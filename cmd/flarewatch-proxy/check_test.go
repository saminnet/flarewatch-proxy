package main

import (
	"bufio"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"errors"
	"io"
	"math/big"
	"net"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"
)

func newCert(t *testing.T, org string, days int, hosts ...string) (tls.Certificate, *x509.Certificate) {
	t.Helper()
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	template := &x509.Certificate{
		SerialNumber:          big.NewInt(1),
		Subject:               pkix.Name{Organization: []string{org}, CommonName: hosts[0]},
		NotBefore:             time.Now().Add(-time.Hour),
		NotAfter:              time.Now().Add(time.Duration(days)*24*time.Hour + time.Hour),
		KeyUsage:              x509.KeyUsageDigitalSignature | x509.KeyUsageCertSign,
		BasicConstraintsValid: true,
		IsCA:                  true,
	}
	for _, h := range hosts {
		if ip := net.ParseIP(h); ip != nil {
			template.IPAddresses = append(template.IPAddresses, ip)
		} else {
			template.DNSNames = append(template.DNSNames, h)
		}
	}
	der, err := x509.CreateCertificate(rand.Reader, template, template, pub, priv)
	if err != nil {
		t.Fatal(err)
	}
	parsed, err := x509.ParseCertificate(der)
	if err != nil {
		t.Fatal(err)
	}
	return tls.Certificate{Certificate: [][]byte{der}, PrivateKey: priv}, parsed
}

func startTLS(t *testing.T, network, addr string, cert tls.Certificate, handler http.HandlerFunc) string {
	t.Helper()
	ln, err := net.Listen(network, addr)
	if err != nil {
		t.Skip(err)
	}
	server := httptest.NewUnstartedServer(handler)
	server.Listener.Close()
	server.Listener = ln
	server.TLS = &tls.Config{Certificates: []tls.Certificate{cert}}
	server.StartTLS()
	t.Cleanup(server.Close)
	return server.URL
}

func runCheck(t *testing.T, c *checker, body string) result {
	t.Helper()
	m, err := parseMonitor([]byte(body))
	if err != nil {
		t.Fatal(err)
	}
	return c.check(t.Context(), m)
}

func TestCheckCertificate(t *testing.T) {
	trusted, trustedX509 := newCert(t, "FlareWatch Test", 40, "localhost", "127.0.0.1", "::1")
	other, otherX509 := newCert(t, "FlareWatch Other", 50, "localhost", "127.0.0.1")
	soon, soonX509 := newCert(t, "FlareWatch Soon", 10, "localhost", "127.0.0.1")
	foreign, foreignX509 := newCert(t, "FlareWatch Foreign", 40, "other.example")
	untrusted, untrustedX509 := newCert(t, "FlareWatch Untrusted", 40, "localhost", "127.0.0.1")
	roots := x509.NewCertPool()
	for _, c := range []*x509.Certificate{trustedX509, otherX509, soonX509, foreignX509} {
		roots.AddCert(c)
	}
	c := newTestChecker(t, roots)
	ok := func(w http.ResponseWriter, r *http.Request) { io.WriteString(w, "ok") }
	plain := httptest.NewServer(http.HandlerFunc(ok))
	t.Cleanup(plain.Close)
	site := startTLS(t, "tcp", "127.0.0.1:0", trusted, ok)
	final := startTLS(t, "tcp", "127.0.0.1:0", other, ok)
	redirect := func(to string) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) { http.Redirect(w, r, to, http.StatusFound) }
	}
	ssl := func(cert *x509.Certificate, days int64, org string) *certificate {
		return &certificate{ExpiryDate: cert.NotAfter.Unix(), DaysUntilExpiry: days, Issuer: org, Subject: cert.Subject.CommonName}
	}

	cases := []struct {
		name    string
		monitor string
		ok      bool
		error   string
		ssl     *certificate
	}{
		{"a trusted certificate", `{"target":"` + site + `","sslCheckEnabled":true}`, true, "", ssl(trustedX509, 40, "FlareWatch Test")},
		{"no ssl block without sslCheckEnabled", `{"target":"` + site + `"}`, true, "", nil},
		{"an upper-case scheme", `{"target":"` + strings.Replace(site, "https://", "HTTPS://", 1) + `","sslCheckEnabled":true}`, true, "", ssl(trustedX509, 40, "FlareWatch Test")},
		{"expiry inside the default threshold", `{"target":"` + startTLS(t, "tcp", "127.0.0.1:0", soon, ok) + `","sslCheckEnabled":true}`, false, "SSL certificate expires in 10 days (threshold: 30)", nil},
		{"expiry on the threshold", `{"target":"` + startTLS(t, "tcp", "127.0.0.1:0", soon, ok) + `","sslCheckEnabled":true,"sslCheckDaysBeforeExpiry":10}`, false, "SSL certificate expires in 10 days (threshold: 10)", nil},
		{"expiry past the threshold", `{"target":"` + startTLS(t, "tcp", "127.0.0.1:0", soon, ok) + `","sslCheckEnabled":true,"sslCheckDaysBeforeExpiry":9}`, true, "", ssl(soonX509, 10, "FlareWatch Soon")},
		{"the final hop's certificate", `{"target":"` + startTLS(t, "tcp", "127.0.0.1:0", trusted, redirect(final)) + `","sslCheckEnabled":true}`, true, "", ssl(otherX509, 50, "FlareWatch Other")},
		{"a final hop over plain http", `{"target":"` + startTLS(t, "tcp", "127.0.0.1:0", trusted, redirect(plain.URL)) + `","sslCheckEnabled":true}`, true, "", nil},
		{"a plain http target", `{"target":"` + plain.URL + `","sslCheckEnabled":true}`, true, "", nil},
		{"a certificate for another host", `{"target":"` + startTLS(t, "tcp", "127.0.0.1:0", foreign, ok) + `"}`, false, "", nil},
		{"an untrusted certificate", `{"target":"` + startTLS(t, "tcp", "127.0.0.1:0", untrusted, ok) + `"}`, false, "", nil},
		{"an untrusted certificate with sslIgnoreSelfSigned", `{"target":"` + startTLS(t, "tcp", "127.0.0.1:0", untrusted, ok) + `","sslIgnoreSelfSigned":true,"sslCheckEnabled":true}`, true, "", ssl(untrustedX509, 40, "FlareWatch Untrusted")},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := runCheck(t, c, tc.monitor)
			if got.OK != tc.ok || (tc.error != "" && got.Error != tc.error) || (!tc.ok && got.Error == "") {
				t.Fatalf("result = %+v, want ok %v error %q", got, tc.ok, tc.error)
			}
			if (got.SSL == nil) != (tc.ssl == nil) || got.SSL != nil && *got.SSL != *tc.ssl {
				t.Fatalf("ssl = %+v, want %+v", got.SSL, tc.ssl)
			}
		})
	}
}

func TestCheckCertificateOfIPv6Target(t *testing.T) {
	cert, parsed := newCert(t, "FlareWatch Test", 40, "::1")
	roots := x509.NewCertPool()
	roots.AddCert(parsed)
	target := startTLS(t, "tcp6", "[::1]:0", cert, func(w http.ResponseWriter, r *http.Request) {})
	got := runCheck(t, newTestChecker(t, roots), `{"target":"`+target+`","sslCheckEnabled":true}`)
	if !got.OK || got.SSL == nil || got.SSL.DaysUntilExpiry != 40 {
		t.Fatalf("result = %+v", got)
	}
}

func tlsOnce(t *testing.T, cert tls.Certificate, second func(net.Conn)) string {
	t.Helper()
	ln := listen(t)
	go func() {
		for i := 0; ; i++ {
			conn, err := ln.Accept()
			if err != nil {
				return
			}
			if i > 0 {
				go second(conn)
				continue
			}
			go func() {
				defer conn.Close()
				tc := tls.Server(conn, &tls.Config{Certificates: []tls.Certificate{cert}})
				if _, err := http.ReadRequest(bufio.NewReader(tc)); err != nil {
					return
				}
				io.WriteString(tc, "HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok")
			}()
		}
	}()
	return "https://" + ln.Addr().String()
}

func TestCheckCertificateStepTimesOut(t *testing.T) {
	cert, _ := newCert(t, "FlareWatch Test", 40, "127.0.0.1")
	stalled := make(chan struct{})
	t.Cleanup(func() { close(stalled) })
	target := tlsOnce(t, cert, func(conn net.Conn) {
		defer conn.Close()
		<-stalled
	})
	got := runCheck(t, newTestChecker(t, nil), `{"target":"`+target+`","sslIgnoreSelfSigned":true,"sslCheckEnabled":true,"timeout":300}`)
	if got.OK || got.Error != "Timeout after 300ms" {
		t.Fatalf("result = %+v", got)
	}
}

func TestCheckCertificateStepClosesConnection(t *testing.T) {
	cert, _ := newCert(t, "FlareWatch Test", 40, "127.0.0.1")
	closed := make(chan error, 1)
	target := tlsOnce(t, cert, func(conn net.Conn) {
		defer conn.Close()
		conn.SetReadDeadline(time.Now().Add(2 * time.Second))
		tc := tls.Server(conn, &tls.Config{Certificates: []tls.Certificate{cert}})
		_, err := tc.Read(make([]byte, 1))
		closed <- err
	})
	got := runCheck(t, newTestChecker(t, nil), `{"target":"`+target+`","sslIgnoreSelfSigned":true,"sslCheckEnabled":true}`)
	if !got.OK || got.SSL == nil {
		t.Fatalf("result = %+v", got)
	}
	if err := <-closed; !errors.Is(err, io.EOF) {
		t.Fatalf("server read = %v, want EOF", err)
	}
}

func TestCheckReadsAtMostOneMiB(t *testing.T) {
	endless := make(chan struct{})
	t.Cleanup(func() { close(endless) })
	mux := http.NewServeMux()
	mux.HandleFunc("/late-keyword", func(w http.ResponseWriter, r *http.Request) {
		io.WriteString(w, strings.Repeat("x", maxBodyBytes)+"needle")
	})
	mux.HandleFunc("/endless", func(w http.ResponseWriter, r *http.Request) {
		chunk := []byte(strings.Repeat("x", 4096))
		for {
			select {
			case <-endless:
				return
			default:
			}
			if _, err := w.Write(chunk); err != nil {
				return
			}
		}
	})
	mux.HandleFunc("/json/{size}", func(w http.ResponseWriter, r *http.Request) {
		size, _ := strconv.Atoi(r.PathValue("size"))
		prefix := `{"a":"ok","pad":"`
		io.WriteString(w, prefix+strings.Repeat("x", size-len(prefix)-2)+`"}`)
	})
	server := httptest.NewServer(mux)
	t.Cleanup(server.Close)
	c := newTestChecker(t, nil)
	cases := []struct {
		name, monitor, error string
	}{
		{"a keyword after 1 MiB", `{"target":"` + server.URL + `/late-keyword","responseKeyword":"needle"}`, `Required keyword "needle" not found in response`},
		{"an endless body", `{"target":"` + server.URL + `/endless","responseKeyword":"needle","timeout":60000}`, `Required keyword "needle" not found in response`},
		{"a JSON body of 1 MiB", `{"target":"` + server.URL + `/json/` + strconv.Itoa(maxBodyBytes) + `","responseJsonPath":"$.a","responseJsonValue":"ok"}`, "Response is too large to check $.a"},
		{"a JSON body just under 1 MiB", `{"target":"` + server.URL + `/json/` + strconv.Itoa(maxBodyBytes-1) + `","responseJsonPath":"$.a","responseJsonValue":"ok"}`, ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := runCheck(t, c, tc.monitor)
			if got.OK != (tc.error == "") || got.Error != tc.error {
				t.Fatalf("result = %+v, want error %q", got, tc.error)
			}
		})
	}
}

func TestCheckNetworkErrorLeavesOutTheURL(t *testing.T) {
	closed := listen(t)
	addr := closed.Addr().String()
	closed.Close()
	got := runCheck(t, newTestChecker(t, nil), `{"target":"http://`+addr+`/private?key=secret"}`)
	if got.OK || !strings.Contains(got.Error, "connection refused") || strings.Contains(got.Error, "secret") {
		t.Fatalf("result = %+v", got)
	}
}

func TestCheckTCPClosesConnection(t *testing.T) {
	ln := listen(t)
	closed := make(chan error, 1)
	go func() {
		conn, err := ln.Accept()
		if err != nil {
			closed <- err
			return
		}
		defer conn.Close()
		conn.SetReadDeadline(time.Now().Add(2 * time.Second))
		_, err = conn.Read(make([]byte, 1))
		closed <- err
	}()
	got := runCheck(t, newTestChecker(t, nil), `{"method":"TCP_PING","target":"`+ln.Addr().String()+`"}`)
	if !got.OK {
		t.Fatalf("result = %+v", got)
	}
	if err := <-closed; !errors.Is(err, io.EOF) {
		t.Fatalf("server read = %v, want EOF", err)
	}
}

// A local listener cannot hold a connect open: macOS resets a connect to a
// full accept queue. So the name lookup before the connect stalls instead.
func TestCheckTCPTimeout(t *testing.T) {
	resolver := net.DefaultResolver
	t.Cleanup(func() { net.DefaultResolver = resolver })
	net.DefaultResolver = &net.Resolver{PreferGo: true, Dial: func(ctx context.Context, _, _ string) (net.Conn, error) {
		<-ctx.Done()
		return nil, ctx.Err()
	}}
	got := runCheck(t, newTestChecker(t, nil), `{"method":"TCP_PING","target":"db.internal:5432","timeout":300}`)
	if got.OK || got.Error != "Timeout after 300ms" {
		t.Fatalf("result = %+v", got)
	}
}

func gzipBytes(t *testing.T, body string) []byte {
	t.Helper()
	var compressed bytes.Buffer
	z := gzip.NewWriter(&compressed)
	io.WriteString(z, body)
	if err := z.Close(); err != nil {
		t.Fatal(err)
	}
	return compressed.Bytes()
}

func TestCheckGzipErrorsAndLimits(t *testing.T) {
	site := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Encoding", "gzip")
		if r.URL.Path == "/invalid" {
			io.WriteString(w, "invalid gzip header")
			return
		}
		if r.URL.Path == "/timeout" {
			w.WriteHeader(http.StatusOK)
			w.(http.Flusher).Flush()
			<-r.Context().Done()
			return
		}
		body := "ok"
		if r.URL.Path == "/large" {
			body = `{"status":"ok","pad":"` + strings.Repeat("x", maxBodyBytes) + `"}`
		}
		compressed := gzipBytes(t, body)
		if r.URL.Path == "/truncated" {
			compressed = compressed[:len(compressed)-4]
		}
		w.Write(compressed)
	}))
	defer site.Close()
	c := newTestChecker(t, nil)
	for _, tc := range []struct{ path, assertions, error string }{
		{"/invalid", `"responseKeyword":"ok"`, "gzip: invalid header"},
		{"/truncated", `"responseKeyword":"ok"`, "unexpected EOF"},
		{"/timeout", `"responseKeyword":"ok","timeout":300`, "Timeout after 300ms"},
		{"/large", `"responseJsonPath":"$.status","responseJsonValue":"ok"`, "Response is too large to check $.status"},
	} {
		t.Run(tc.path, func(t *testing.T) {
			got := runCheck(t, c, `{"target":"`+site.URL+tc.path+`","headers":{"Accept-Encoding":"gzip"},`+tc.assertions+`}`)
			if got.OK || got.Error != tc.error {
				t.Fatalf("result = %+v, want error %q", got, tc.error)
			}
		})
	}
}
