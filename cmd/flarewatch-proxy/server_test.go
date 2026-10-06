package main

import (
	"encoding/json/v2"
	"net"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
	"time"
)

func TestServerRoutes(t *testing.T) {
	h := newServer(func() string { return "TEST" }, newTestChecker(t, nil), testToken, "previous-token-0123456789")
	const info = `{"contract":2,"docs":"https://github.com/saminnet/flarewatch-proxy","endpoints":{"GET /":"This info page","GET /health":"Health check","POST /check":"Execute a monitor check"},"name":"FlareWatch Proxy"}`
	const unauthorized = `{"error":"Unauthorized"}`
	cases := []struct {
		method, path, auth string
		status             int
		body               string
	}{
		{"GET", "/", "", 200, info},
		{"HEAD", "/", "", 200, ""},
		{"HEAD", "/health", "", 200, ""},
		{"GET", "/nope", "", 404, ""},
		{"GET", "/health/", "", 404, ""},
		{"POST", "/", "", 404, ""},
		{"POST", "/health", "", 404, ""},
		{"GET", "/check", "", 401, unauthorized},
		{"GET", "/check", "Bearer " + testToken, 404, ""},
		{"PUT", "/check", "Bearer " + testToken, 404, ""},
		{"POST", "/check", "", 401, unauthorized},
		{"POST", "/check", "Bearer wrong-token-0123456789", 401, unauthorized},
		{"POST", "/check", testToken, 401, unauthorized},
		{"POST", "/check", "Bearer " + testToken + " ", 401, unauthorized},
		{"POST", "/check", "Bearer " + testToken, 400, ""},
		{"POST", "/check", "Bearer previous-token-0123456789", 400, ""},
	}
	for _, c := range cases {
		t.Run(c.method+" "+c.path+" "+c.auth, func(t *testing.T) {
			req := httptest.NewRequest(c.method, c.path, strings.NewReader("{}"))
			if c.auth != "" {
				req.Header.Set("Authorization", c.auth)
			}
			rec := httptest.NewRecorder()
			h.ServeHTTP(rec, req)
			if rec.Code != c.status {
				t.Fatalf("status = %d, want %d", rec.Code, c.status)
			}
			if c.body != "" && rec.Body.String() != c.body {
				t.Fatalf("body = %s, want %s", rec.Body, c.body)
			}
		})
	}
}

func TestServerWithoutPreviousToken(t *testing.T) {
	h := newServer(func() string { return "TEST" }, newTestChecker(t, nil), testToken, "")
	for _, token := range []string{"", " "} {
		req := httptest.NewRequest("POST", "/check", strings.NewReader("{}"))
		req.Header.Set("Authorization", "Bearer "+token)
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		if rec.Code != http.StatusUnauthorized {
			t.Fatalf("token %q: status = %d, want 401", token, rec.Code)
		}
	}
}

func TestServerHealth(t *testing.T) {
	h := testServer(t, newTestChecker(t, nil))
	before := time.Now().UnixMilli()
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest("GET", "/health", nil))
	var body struct {
		Status    string `json:"status"`
		Timestamp int64  `json:"timestamp"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body, json.RejectUnknownMembers(true)); err != nil {
		t.Fatal(err)
	}
	if rec.Code != 200 || body.Status != "ok" || body.Timestamp < before || body.Timestamp > time.Now().UnixMilli() {
		t.Fatalf("status %d, body %s", rec.Code, rec.Body)
	}
}

func TestServerBodySize(t *testing.T) {
	h := testServer(t, newTestChecker(t, nil))
	env := startTarget(t, []targetReply{{Body: "ok"}})
	monitor := `{"target":"` + env.origin + `/0"}`
	for _, c := range []struct {
		size   int
		status int
	}{{maxRequestBytes, 200}, {maxRequestBytes + 1, 413}} {
		body := monitor + strings.Repeat(" ", c.size-len(monitor))
		if status, reply := postCheck(h, testToken, body); status != c.status {
			t.Fatalf("%d bytes: status = %d, want %d: %s", c.size, status, c.status, reply)
		}
	}
}

func TestServerRejectsABodyThatIsNotAnObject(t *testing.T) {
	h := testServer(t, newTestChecker(t, nil))
	for body, want := range map[string]string{
		"null":          "the body must be a JSON object",
		"[]":            "the body must be a JSON object",
		`"x"`:           "the body must be a JSON object",
		`{"target":"x"`: "the body is not valid JSON",
	} {
		status, reply := postCheck(h, testToken, body)
		if status != http.StatusBadRequest || string(reply) != `{"error":"`+want+`"}` {
			t.Fatalf("%s: status = %d, reply = %s, want %q", body, status, reply, want)
		}
	}
}

func TestServerReply(t *testing.T) {
	h := testServer(t, newTestChecker(t, nil))
	env := startTarget(t, []targetReply{{Body: "ok"}, {Status: 500}})
	cases := []struct {
		target string
		want   string
	}{
		{"/0", `{"contract":2,"location":"TEST","result":{"ok":true,"latency":0}}`},
		{"/1", `{"contract":2,"location":"TEST","result":{"ok":false,"error":"Expected 2xx status, got 500","latency":0}}`},
	}
	for _, c := range cases {
		status, reply := postCheck(h, testToken, `{"target":"`+env.origin+c.target+`"}`)
		var got map[string]any
		if err := json.Unmarshal(reply, &got); err != nil {
			t.Fatal(err)
		}
		got["result"].(map[string]any)["latency"] = 0.0
		var want map[string]any
		if err := json.Unmarshal([]byte(c.want), &want); err != nil {
			t.Fatal(err)
		}
		if status != 200 || !reflect.DeepEqual(got, want) {
			t.Fatalf("reply = %s, want %s", reply, c.want)
		}
	}
}

func TestProbeHealth(t *testing.T) {
	port := func(t *testing.T, status int) int {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.URL.Path != "/health" {
				http.NotFound(w, r)
				return
			}
			w.WriteHeader(status)
		}))
		t.Cleanup(server.Close)
		return server.Listener.Addr().(*net.TCPAddr).Port
	}
	closed := listen(t)
	refused := closed.Addr().(*net.TCPAddr).Port
	closed.Close()
	cases := []struct {
		name string
		port int
		ok   bool
	}{
		{"a 200 reply", port(t, http.StatusOK), true},
		{"a 503 reply", port(t, http.StatusServiceUnavailable), false},
		{"a refused connection", refused, false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if err := probeHealth(c.port); (err == nil) != c.ok {
				t.Fatalf("error = %v, want ok %v", err, c.ok)
			}
		})
	}
}
