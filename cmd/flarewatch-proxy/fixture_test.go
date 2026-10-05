package main

import (
	"crypto/x509"
	"encoding/json/jsontext"
	"encoding/json/v2"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"regexp"
	"strconv"
	"strings"
	"testing"
)

const testToken = "test-token-0123456789"

var decoderText = regexp.MustCompile(`json|Go |main\.|within "/`)

func TestMain(m *testing.M) {
	slog.SetDefault(slog.New(slog.DiscardHandler))
	os.Exit(m.Run())
}

// A deviation reverses the TypeScript proxy's acceptance result.
func TestRequests(t *testing.T) {
	var cases []struct {
		Name      string         `json:"name"`
		Body      jsontext.Value `json:"body"`
		RawBody   *string        `json:"rawBody"`
		Accepted  bool           `json:"accepted"`
		Deviation string         `json:"deviation"`
		Field     string         `json:"field"`
	}
	readFixture(t, "requests.json", &cases)
	h := testServer(t, newTestChecker(t, nil))
	for _, c := range cases {
		t.Run(c.Name, func(t *testing.T) {
			t.Parallel()
			env := startTarget(t, []targetReply{{Body: "ok"}})
			payload := env.expand(string(c.Body))
			if c.RawBody != nil {
				payload = *c.RawBody
			}
			status, reply := postCheck(h, testToken, payload)
			if c.Accepted != (c.Deviation != "") {
				if status != http.StatusOK {
					t.Fatalf("status = %d, want 200: %s", status, reply)
				}
				return
			}
			if status != http.StatusBadRequest {
				t.Fatalf("status = %d, want 400: %s", status, reply)
			}
			var body struct {
				Error string `json:"error"`
			}
			if err := json.Unmarshal(reply, &body); err != nil || body.Error == "" {
				t.Fatalf("reply = %s, want an error", reply)
			}
			if c.Field != "" && !strings.HasPrefix(body.Error, c.Field+" ") {
				t.Fatalf("error = %q, want it to start with %s", body.Error, c.Field)
			}
			if decoderText.MatchString(body.Error) {
				t.Fatalf("error = %q, want no Go type or JSON pointer", body.Error)
			}
		})
	}
}

func TestVerdicts(t *testing.T) {
	var cases []struct {
		Name    string         `json:"name"`
		Replies []targetReply  `json:"replies"`
		Hops    int            `json:"hops"`
		Monitor jsontext.Value `json:"monitor"`
		Result  struct {
			OK    bool    `json:"ok"`
			Error *string `json:"error"`
		} `json:"result"`
	}
	readFixture(t, "verdicts.json", &cases)
	h := testServer(t, newTestChecker(t, nil))
	for _, c := range cases {
		t.Run(c.Name, func(t *testing.T) {
			t.Parallel()
			replies := c.Replies
			if c.Hops > 0 {
				replies = nil
				for i := range c.Hops {
					replies = append(replies, targetReply{Status: http.StatusFound, Headers: map[string]string{"Location": "/" + strconv.Itoa(i+1)}})
				}
				replies = append(replies, targetReply{Body: "end"})
			}
			got := runCase(t, h, replies, c.Monitor)
			if got.OK != c.Result.OK {
				t.Fatalf("result = %+v, want ok %v", got, c.Result.OK)
			}
			if c.Result.Error != nil && got.Error != *c.Result.Error {
				t.Fatalf("error = %q, want %q", got.Error, *c.Result.Error)
			}
			if !got.OK && got.Error == "" {
				t.Fatalf("result = %+v, want an error", got)
			}
		})
	}
}

func TestHTTPAssertions(t *testing.T) {
	var cases []struct {
		Name    string         `json:"name"`
		Monitor jsontext.Value `json:"monitor"`
		Reply   targetReply    `json:"reply"`
		Error   *string        `json:"error"`
	}
	readFixture(t, "http-assertions.json", &cases)
	if len(cases) < 61 {
		t.Fatalf("fixture holds %d cases, want at least 61", len(cases))
	}
	h := testServer(t, newTestChecker(t, nil))
	for _, c := range cases {
		t.Run(c.Name, func(t *testing.T) {
			t.Parallel()
			got := runCase(t, h, []targetReply{c.Reply}, c.Monitor)
			want := result{OK: c.Error == nil}
			if c.Error != nil {
				want.Error = *c.Error
			}
			if got.OK != want.OK || got.Error != want.Error {
				t.Fatalf("result = %+v, want ok %v error %q", got, want.OK, want.Error)
			}
		})
	}
}

func runCase(t *testing.T, h http.Handler, replies []targetReply, monitor jsontext.Value) result {
	t.Helper()
	env := startTarget(t, replies)
	var fields map[string]jsontext.Value
	if err := json.Unmarshal(monitor, &fields); err != nil {
		t.Fatal(err)
	}
	if _, ok := fields["target"]; !ok {
		fields["target"] = jsontext.Value(`"{origin}/0"`)
	}
	body, err := json.Marshal(fields)
	if err != nil {
		t.Fatal(err)
	}
	status, raw := postCheck(h, testToken, env.expand(string(body)))
	if status != http.StatusOK {
		t.Fatalf("status = %d: %s", status, raw)
	}
	var reply struct {
		Result result `json:"result"`
	}
	if err := json.Unmarshal(raw, &reply); err != nil {
		t.Fatal(err)
	}
	return reply.Result
}

type targetReply struct {
	Status     int               `json:"status"`
	Headers    map[string]string `json:"headers"`
	Body       string            `json:"body"`
	BodyBase64 []byte            `json:"bodyBase64"`
	Echo       bool              `json:"echo"`
	Hang       any               `json:"hang"`
	Cut        bool              `json:"cut"`
}

type target struct {
	origin, other, tcp, closed string
}

func (e target) expand(s string) string {
	host, port, _ := net.SplitHostPort(e.tcp)
	return strings.NewReplacer(
		"{origin}", e.origin,
		"{ORIGIN}", strings.Replace(e.origin, "http://", "HTTP://", 1),
		"{originhost}", strings.TrimPrefix(e.origin, "http://"),
		"{otherhost}", strings.TrimPrefix(e.other, "http://"),
		"{other}", e.other,
		"{tcp}", e.tcp,
		"{tcphost}", host,
		"{tcpport}", port,
		"{closed}", e.closed,
	).Replace(s)
}

func startTarget(t *testing.T, replies []targetReply) target {
	t.Helper()
	var env target
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		i, err := strconv.Atoi(strings.TrimPrefix(r.URL.Path, "/"))
		if err != nil || i < 0 || i >= len(replies) {
			http.NotFound(w, r)
			return
		}
		reply := replies[i]
		for name, value := range reply.Headers {
			w.Header().Set(name, env.expand(value))
		}
		status := reply.Status
		if status == 0 {
			status = http.StatusOK
		}
		switch {
		case reply.Hang == true:
			<-r.Context().Done()
		case reply.Hang == "body" || reply.Cut:
			w.Header().Set("Content-Length", "1000")
			w.WriteHeader(status)
			io.WriteString(w, "partial")
			w.(http.Flusher).Flush()
			if reply.Cut {
				panic(http.ErrAbortHandler)
			}
			<-r.Context().Done()
		case reply.Echo:
			body, _ := io.ReadAll(r.Body)
			headers := map[string]string{}
			for name, values := range r.Header {
				headers[strings.ToLower(name)] = strings.Join(values, ", ")
			}
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(status)
			json.MarshalWrite(w, map[string]any{"method": r.Method, "headers": headers, "body": string(body)})
		default:
			w.WriteHeader(status)
			if reply.BodyBase64 != nil {
				w.Write(reply.BodyBase64)
			} else {
				io.WriteString(w, reply.Body)
			}
		}
	})
	for _, origin := range []*string{&env.origin, &env.other} {
		server := httptest.NewServer(handler)
		t.Cleanup(server.Close)
		*origin = server.URL
	}
	ln := listen(t)
	go func() {
		for {
			conn, err := ln.Accept()
			if err != nil {
				return
			}
			conn.Close()
		}
	}()
	env.tcp = ln.Addr().String()
	closed := listen(t)
	env.closed = closed.Addr().String()
	closed.Close()
	return env
}

func listen(t *testing.T) net.Listener {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close() })
	return ln
}

func readFixture(t *testing.T, name string, v any) {
	t.Helper()
	raw, err := os.ReadFile("testdata/" + name)
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(raw, v); err != nil {
		t.Fatalf("%s: %v", name, err)
	}
}

func newTestChecker(t *testing.T, roots *x509.CertPool) *checker {
	t.Helper()
	c := newChecker(roots)
	t.Cleanup(func() {
		c.verified.CloseIdleConnections()
		c.insecure.CloseIdleConnections()
	})
	return c
}

func testServer(t *testing.T, c *checker) http.Handler {
	t.Helper()
	return newServer(func() string { return "TEST" }, c, testToken)
}

func postCheck(h http.Handler, token, body string) (int, []byte) {
	req := httptest.NewRequest(http.MethodPost, "/check", strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec.Code, rec.Body.Bytes()
}
