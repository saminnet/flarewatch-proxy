package main

import (
	"cmp"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/json/v2"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"time"
)

const (
	contract        = 2
	maxRequestBytes = 64 << 10
)

type server struct {
	tokens   [][sha256.Size]byte
	location func() string
	checker  *checker
}

func newServer(location func() string, c *checker, tokens ...string) http.Handler {
	s := &server{location: location, checker: c}
	for _, t := range tokens {
		if t != "" {
			s.tokens = append(s.tokens, sha256.Sum256([]byte("Bearer "+t)))
		}
	}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /{$}", info)
	mux.HandleFunc("GET /health", health)
	mux.HandleFunc("/check", s.check)
	mux.HandleFunc("/", http.NotFound)
	return mux
}

func info(w http.ResponseWriter, _ *http.Request) {
	type endpoints struct {
		Root   string `json:"GET /"`
		Health string `json:"GET /health"`
		Check  string `json:"POST /check"`
	}
	writeJSON(w, http.StatusOK, struct {
		Contract  int       `json:"contract"`
		Docs      string    `json:"docs"`
		Endpoints endpoints `json:"endpoints"`
		Name      string    `json:"name"`
	}{contract, "https://github.com/saminnet/flarewatch-proxy", endpoints{"This info page", "Health check", "Execute a monitor check"}, "FlareWatch Proxy"})
}

func health(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, struct {
		Status    string `json:"status"`
		Timestamp int64  `json:"timestamp"`
	}{"ok", time.Now().UnixMilli()})
}

func (s *server) check(w http.ResponseWriter, r *http.Request) {
	if !s.authorized(r) {
		slog.Info("unauthorized request", "remote", r.RemoteAddr)
		writeError(w, http.StatusUnauthorized, "Unauthorized")
		return
	}
	if r.Method != http.MethodPost {
		http.NotFound(w, r)
		return
	}
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxRequestBytes))
	if _, tooLarge := errors.AsType[*http.MaxBytesError](err); tooLarge {
		writeError(w, http.StatusRequestEntityTooLarge, fmt.Sprintf("request body is over %d bytes", maxRequestBytes))
		return
	}
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	m, err := parseMonitor(body)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	res := s.checker.check(r.Context(), m)
	location := s.location()
	slog.Info("check", "name", cmp.Or(m.Name, m.ID), "method", m.Method, "ok", res.OK, "latency", res.Latency, "error", res.Error, "location", location)
	writeJSON(w, http.StatusOK, struct {
		Contract int    `json:"contract"`
		Location string `json:"location"`
		Result   result `json:"result"`
	}{contract, location, res})
}

// authorized compares the header with every token, so the time it takes does not tell which token matched.
func (s *server) authorized(r *http.Request) bool {
	given := sha256.Sum256([]byte(r.Header.Get("Authorization")))
	match := 0
	for _, t := range s.tokens {
		match |= subtle.ConstantTimeCompare(given[:], t[:])
	}
	return match == 1
}

func writeError(w http.ResponseWriter, status int, text string) {
	writeJSON(w, status, struct {
		Error string `json:"error"`
	}{text})
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	if err := json.MarshalWrite(w, v); err != nil {
		slog.Error("write reply", "error", err)
	}
}
