package main

import (
	"cmp"
	"context"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"fmt"
	"io"
	"math"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"
)

const userAgent = "FlareWatch-Proxy/1.0 (+https://github.com/saminnet/flarewatch)"

type result struct {
	OK      bool         `json:"ok"`
	Error   string       `json:"error,omitempty"`
	Latency int64        `json:"latency"`
	SSL     *certificate `json:"ssl,omitzero"`
}

type certificate struct {
	ExpiryDate      int64  `json:"expiryDate"`
	DaysUntilExpiry int64  `json:"daysUntilExpiry"`
	Issuer          string `json:"issuer,omitempty"`
	Subject         string `json:"subject,omitempty"`
}

type checker struct {
	roots    *x509.CertPool
	verified *http.Client
	insecure *http.Client
}

func newChecker(roots *x509.CertPool) *checker {
	return &checker{
		roots:    roots,
		verified: newClient(&tls.Config{RootCAs: roots}),
		insecure: newClient(&tls.Config{InsecureSkipVerify: true}),
	}
}

func (c *checker) check(ctx context.Context, m *monitor) result {
	ctx, cancel := context.WithTimeout(ctx, m.timeout())
	defer cancel()
	var (
		latency time.Duration
		cert    *certificate
		err     error
	)
	if m.Method == tcpPing {
		latency, err = dialTCP(ctx, m.Target)
	} else {
		latency, cert, err = c.checkHTTP(ctx, m)
	}
	if err != nil && ctx.Err() != nil {
		err = fmt.Errorf("Timeout after %dms", m.Timeout)
	}
	r := result{OK: err == nil, Latency: latency.Round(time.Millisecond).Milliseconds(), SSL: cert}
	if err != nil {
		r.Error = err.Error()
	}
	return r
}

func dialTCP(ctx context.Context, target string) (time.Duration, error) {
	start := time.Now()
	var d net.Dialer
	conn, err := d.DialContext(ctx, "tcp", tcpAddress(target))
	latency := time.Since(start)
	if err != nil {
		return latency, err
	}
	conn.Close()
	return latency, nil
}

func (c *checker) checkHTTP(ctx context.Context, m *monitor) (time.Duration, *certificate, error) {
	start := time.Now()
	resp, err := c.fetch(ctx, m)
	latency := time.Since(start)
	if err != nil {
		return latency, nil, err
	}
	defer resp.Body.Close()
	if err := m.assert(resp); err != nil {
		return latency, nil, err
	}
	if !m.SSLCheckEnabled || resp.Request.URL.Scheme != "https" {
		return latency, nil, nil
	}
	cert, err := c.certificate(ctx, m, resp.Request.URL)
	return latency, cert, err
}

func (c *checker) fetch(ctx context.Context, m *monitor) (*http.Response, error) {
	var body io.Reader
	if m.Body != nil {
		// fetch refuses a body on GET and HEAD, so FlareWatch fails the
		// monitor when it checks it directly.
		if m.Method == http.MethodGet || m.Method == http.MethodHead {
			return nil, errors.New("a GET or HEAD request cannot have a body")
		}
		body = strings.NewReader(*m.Body)
	}
	req, err := http.NewRequestWithContext(ctx, m.Method, cleanURL(m.Target), body)
	if err != nil {
		return nil, err
	}
	// fetch refuses a URL with credentials. Go would send them as Basic auth.
	if req.URL.User != nil {
		return nil, errors.New("the target URL must not hold a username or password")
	}
	for _, h := range m.Headers {
		// fetch drops HTTP whitespace around a value.
		req.Header.Add(h.Name, strings.Trim(string(h.Value), " \t\r\n"))
	}
	if _, ok := req.Header["User-Agent"]; !ok {
		req.Header.Set("User-Agent", userAgent)
	}
	if _, ok := req.Header["Content-Type"]; !ok && m.Body != nil {
		// fetch sends a string body as text.
		req.Header.Set("Content-Type", "text/plain;charset=UTF-8")
	}
	if req.Header.Get("Accept-Encoding") == "" && req.Header.Get("Range") == "" && req.Method != http.MethodHead {
		req.Header.Set("Accept-Encoding", "gzip")
	}
	client := c.verified
	if m.SSLIgnoreSelfSigned {
		client = c.insecure
	}
	resp, err := client.Do(req)
	// The result is public, and the URL the client error repeats can hold a secret.
	if uerr, ok := errors.AsType[*url.Error](err); ok {
		err = uerr.Err
	}
	return resp, err
}

func (c *checker) certificate(ctx context.Context, m *monitor, u *url.URL) (*certificate, error) {
	d := tls.Dialer{Config: &tls.Config{RootCAs: c.roots, InsecureSkipVerify: m.SSLIgnoreSelfSigned}}
	conn, err := d.DialContext(ctx, "tcp", net.JoinHostPort(u.Hostname(), cmp.Or(u.Port(), "443")))
	if err != nil {
		return nil, fmt.Errorf("SSL check failed: %w", err)
	}
	defer conn.Close()
	leaf := conn.(*tls.Conn).ConnectionState().PeerCertificates[0]
	days := int64(math.Floor(time.Until(leaf.NotAfter).Hours() / 24))
	if days <= int64(m.SSLCheckDaysBeforeExpiry) {
		return nil, fmt.Errorf("SSL certificate expires in %d days (threshold: %d)", days, m.SSLCheckDaysBeforeExpiry)
	}
	return &certificate{
		ExpiryDate:      leaf.NotAfter.Unix(),
		DaysUntilExpiry: days,
		Issuer:          cmp.Or(strings.Join(leaf.Issuer.Organization, ", "), leaf.Issuer.CommonName),
		Subject:         leaf.Subject.CommonName,
	}, nil
}
