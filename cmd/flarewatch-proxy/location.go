package main

import (
	"cmp"
	"context"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"sync"
	"time"
)

const (
	traceURL        = "https://cloudflare.com/cdn-cgi/trace"
	lookupTimeout   = 3 * time.Second
	lookupRetry     = time.Minute
	unknownLocation = "UNKNOWN"
)

type locator struct {
	lookup func(context.Context) (string, error)

	mu      sync.Mutex
	colo    string
	lastTry time.Time
}

func newLocator(lookup func(context.Context) (string, error)) *locator {
	l := &locator{lookup: lookup}
	l.start()
	return l
}

func (l *locator) Location() string {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.colo == "" && time.Since(l.lastTry) >= lookupRetry {
		l.start()
	}
	return cmp.Or(l.colo, unknownLocation)
}

// The caller holds l.mu, or is newLocator.
func (l *locator) start() {
	l.lastTry = time.Now()
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), lookupTimeout)
		defer cancel()
		colo, err := l.lookup(ctx)
		l.mu.Lock()
		defer l.mu.Unlock()
		if err != nil {
			slog.Warn("location lookup failed", "error", err)
			return
		}
		l.colo = colo
		slog.Info("location found", "location", colo)
	}()
}

func traceColo(ctx context.Context, url string) (string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return "", err
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 4096))
	if err != nil {
		return "", err
	}
	for line := range strings.Lines(string(body)) {
		if colo, ok := strings.CutPrefix(strings.TrimSpace(line), "colo="); ok && colo != "" {
			return colo, nil
		}
	}
	return "", errors.New("the trace has no colo line")
}
