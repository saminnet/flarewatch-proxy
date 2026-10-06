package main

import (
	"cmp"
	"context"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"
)

const version = "2.0.0"

func main() {
	healthcheck := flag.Bool("healthcheck", false, "ask the proxy on this machine for /health and exit")
	flag.Parse()
	if *healthcheck {
		port, ok := readPort(os.Getenv("PORT"))
		if !ok {
			port = defaultPort
		}
		if err := probeHealth(port); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		return
	}

	var handler slog.Handler = slog.NewTextHandler(os.Stderr, nil)
	if os.Getenv("FLAREWATCH_PROXY_LOG") == "json" {
		handler = slog.NewJSONHandler(os.Stderr, nil)
	}
	slog.SetDefault(slog.New(handler))

	if err := run(); err != nil {
		slog.Error(err.Error())
		os.Exit(1)
	}
}

func run() error {
	s, err := readSettings(os.Getenv)
	if err != nil {
		return err
	}
	location := func() string { return s.Location }
	if s.Location == "" {
		location = newLocator(func(ctx context.Context) (string, error) { return traceColo(ctx, traceURL) }).Location
	}
	server := &http.Server{
		Addr:              ":" + strconv.Itoa(s.Port),
		Handler:           newServer(location, newChecker(nil), s.Token, s.PreviousToken),
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       30 * time.Second,
		// The write deadline starts with the request: it spans the 30s body
		// read and the 60s longest check, with margin.
		WriteTimeout: 105 * time.Second,
		IdleTimeout:  120 * time.Second,
	}
	slog.Info("starting", "version", version, "port", s.Port, "location", cmp.Or(s.Location, "auto-detect"))

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	errc := make(chan error, 1)
	go func() { errc <- server.ListenAndServe() }()
	select {
	case err := <-errc:
		return err
	case <-ctx.Done():
		shutdown, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if err := server.Shutdown(shutdown); err != nil && !errors.Is(err, http.ErrServerClosed) {
			return err
		}
		return nil
	}
}

// probeHealth is the Docker health check: the image has no shell or curl.
func probeHealth(port int) error {
	client := http.Client{Timeout: 4 * time.Second}
	resp, err := client.Get("http://127.0.0.1:" + strconv.Itoa(port) + "/health")
	if err != nil {
		return err
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("/health answered %s", resp.Status)
	}
	return nil
}
