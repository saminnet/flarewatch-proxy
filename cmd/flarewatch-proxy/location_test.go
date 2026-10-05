package main

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"testing/synctest"
	"time"
)

func TestLocationIsUnknownUntilTheLookupAnswers(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		answer := make(chan string)
		l := newLocator(func(context.Context) (string, error) { return <-answer, nil })
		if got := l.Location(); got != "UNKNOWN" {
			t.Fatalf("location = %q, want UNKNOWN", got)
		}
		answer <- "FRA"
		synctest.Wait()
		if got := l.Location(); got != "FRA" {
			t.Fatalf("location = %q, want FRA", got)
		}
	})
}

func TestLocationRetriesAMinuteAfterAFailure(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		var calls atomic.Int32
		l := newLocator(func(context.Context) (string, error) {
			if calls.Add(1) == 1 {
				return "", errors.New("offline")
			}
			return "AMS", nil
		})
		synctest.Wait()
		time.Sleep(lookupRetry - time.Second)
		if got := l.Location(); got != "UNKNOWN" || calls.Load() != 1 {
			t.Fatalf("location = %q after %d lookups, want UNKNOWN after 1", got, calls.Load())
		}
		time.Sleep(time.Second)
		l.Location()
		synctest.Wait()
		if got := l.Location(); got != "AMS" || calls.Load() != 2 {
			t.Fatalf("location = %q after %d lookups, want AMS after 2", got, calls.Load())
		}
	})
}

func TestLocationLookupHasATimeout(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		ended := make(chan error, 1)
		newLocator(func(ctx context.Context) (string, error) {
			<-ctx.Done()
			ended <- ctx.Err()
			return "", ctx.Err()
		})
		time.Sleep(lookupTimeout)
		synctest.Wait()
		select {
		case err := <-ended:
			if !errors.Is(err, context.DeadlineExceeded) {
				t.Fatalf("lookup ended with %v", err)
			}
		default:
			t.Fatalf("lookup still runs after %v", lookupTimeout)
		}
	})
}

func TestTraceColo(t *testing.T) {
	cases := []struct {
		name, body, colo string
	}{
		{"a trace", "fl=29f1\nh=cloudflare.com\nip=192.0.2.1\ncolo=FRA\nhttp=http/2\n", "FRA"},
		{"CRLF line ends", "fl=29f1\r\ncolo=AMS\r\n", "AMS"},
		{"no colo line", "fl=29f1\nh=cloudflare.com\n", ""},
		{"an empty colo", "colo=\n", ""},
		{"a colo past 4 KiB", strings.Repeat("x", 4096) + "\ncolo=FRA\n", ""},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				io.WriteString(w, c.body)
			}))
			defer server.Close()
			colo, err := traceColo(t.Context(), server.URL)
			if colo != c.colo || (c.colo == "") != (err != nil) {
				t.Fatalf("colo = %q, err = %v, want %q", colo, err, c.colo)
			}
		})
	}
}
