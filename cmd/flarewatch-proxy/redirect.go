package main

import (
	"crypto/tls"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"slices"
	"strconv"
	"strings"
	"time"
)

const maxRedirects = 20

func newClient(config *tls.Config) *http.Client {
	return &http.Client{
		Transport: &http.Transport{
			TLSClientConfig:    config,
			IdleConnTimeout:    90 * time.Second,
			DisableCompression: true,
		},
		CheckRedirect: followRedirect,
	}
}

func followRedirect(req *http.Request, via []*http.Request) error {
	if len(via) > maxRedirects {
		return fmt.Errorf("stopped after %d redirects", maxRedirects)
	}
	if req.URL.User != nil {
		return errors.New("redirect to a URL with a username or password")
	}
	first, prev := via[0], via[len(via)-1]
	method := prev.Method
	switch req.Response.StatusCode {
	case http.StatusMovedPermanently, http.StatusFound:
		if method == http.MethodPost {
			method = http.MethodGet
		}
	case http.StatusSeeOther:
		if method != http.MethodHead {
			method = http.MethodGet
		}
	}
	req.Method = method
	if method != http.MethodGet && method != http.MethodHead && req.Body == nil && first.GetBody != nil {
		body, err := first.GetBody()
		if err != nil {
			return err
		}
		req.Body, req.GetBody, req.ContentLength = body, first.GetBody, first.ContentLength
	}
	if method == prev.Method {
		for _, name := range []string{"Content-Type", "Content-Encoding", "Content-Language", "Content-Location"} {
			if v, ok := prev.Header[name]; ok {
				req.Header[name] = v
			}
		}
	}

	if _, ok := first.Header["Referer"]; !ok {
		req.Header.Del("Referer")
	}

	left := !sameOrigin(first.URL, req.URL) || slices.ContainsFunc(via[1:], func(r *http.Request) bool {
		return !sameOrigin(first.URL, r.URL)
	})
	if left {
		for _, name := range []string{"Authorization", "Cookie", "Proxy-Authorization"} {
			req.Header.Del(name)
		}
	}
	return nil
}

func sameOrigin(a, b *url.URL) bool {
	return a.Scheme == b.Scheme && strings.EqualFold(a.Hostname(), b.Hostname()) && port(a) == port(b)
}

func port(u *url.URL) int {
	if n, err := strconv.Atoi(u.Port()); err == nil {
		return n
	}
	if u.Scheme == "https" {
		return 443
	}
	return 80
}
