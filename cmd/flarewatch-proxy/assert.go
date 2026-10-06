package main

import (
	"bytes"
	"compress/gzip"
	"encoding/json/jsontext"
	"encoding/json/v2"
	"errors"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"unicode/utf8"
)

const maxBodyBytes = 1 << 20

var jsonPathStep = regexp.MustCompile(`\.([^.[\]]+)|\[(\d+)\]`)

// FlareWatch's own check runs the assertions in this order, reports the
// first failure, and writes the same texts.
func (m *monitor) assert(resp *http.Response) error {
	if m.ExpectedCodes != nil {
		if !slices.Contains(m.ExpectedCodes, resp.StatusCode) {
			codes := make([]string, len(m.ExpectedCodes))
			for i, c := range m.ExpectedCodes {
				codes[i] = strconv.Itoa(c)
			}
			return fmt.Errorf("Expected status %s, got %d", strings.Join(codes, "|"), resp.StatusCode)
		}
	} else if resp.StatusCode < 200 || resp.StatusCode > 299 {
		return fmt.Errorf("Expected 2xx status, got %d", resp.StatusCode)
	}

	for _, h := range m.ResponseHeaderEquals {
		values := resp.Header.Values(h.Name)
		if values == nil {
			return fmt.Errorf(`Header "%s" not found in response`, h.Name)
		}
		if strings.Join(values, ", ") != h.Value {
			return fmt.Errorf(`Header "%s" does not have the expected value`, h.Name)
		}
	}

	if m.ResponseKeyword == nil && m.ResponseForbiddenKeyword == nil && m.ResponseJSONPath == nil {
		return nil
	}
	var body io.Reader = resp.Body
	// fetch decodes a gzip body and leaves the response headers as sent.
	if resp.Body != http.NoBody && strings.EqualFold(resp.Header.Get("Content-Encoding"), "gzip") {
		decoded, err := gzip.NewReader(resp.Body)
		if err != nil {
			return err
		}
		defer decoded.Close()
		body = decoded
	}
	raw, err := io.ReadAll(io.LimitReader(body, maxBodyBytes))
	if err != nil {
		return err
	}
	text := decodeText(raw)

	if kw := m.ResponseKeyword; kw != nil && !strings.Contains(text, *kw) {
		return fmt.Errorf(`Required keyword "%s" not found in response`, *kw)
	}
	if kw := m.ResponseForbiddenKeyword; kw != nil && strings.Contains(text, *kw) {
		return fmt.Errorf(`Forbidden keyword "%s" found in response`, *kw)
	}

	if m.ResponseJSONPath == nil {
		return nil
	}
	path := *m.ResponseJSONPath
	if len(raw) >= maxBodyBytes {
		return fmt.Errorf("Response is too large to check %s", path)
	}
	var doc any
	// JSON.parse keeps the last of duplicate names and accepts an unpaired
	// surrogate escape.
	if err := json.Unmarshal([]byte(text), &doc, jsontext.AllowDuplicateNames(true), jsontext.AllowInvalidUTF8(true)); err != nil {
		return errors.New("Response is not valid JSON")
	}
	got, found := valueAt(doc, path)
	if !found {
		return fmt.Errorf("JSON path %s not found in response", path)
	}
	// wantJSON is never a map or a slice, so the comparison cannot panic.
	if got != m.wantJSON {
		return fmt.Errorf("JSON value at %s is not %s", path, m.ResponseJSONValue)
	}
	return nil
}

// decodeText decodes a body as fetch's text decoding does: a UTF-8
// byte-order mark goes, and invalid bytes become U+FFFD.
func decodeText(raw []byte) string {
	raw = bytes.TrimPrefix(raw, []byte("\uFEFF"))
	var text strings.Builder
	text.Grow(len(raw))
	for len(raw) > 0 {
		r, size := utf8.DecodeRune(raw)
		if r == utf8.RuneError && size == 1 {
			// fetch replaces a malformed sequence's valid prefix with one U+FFFD.
			for size < len(raw) && !utf8.FullRune(raw[:size+1]) {
				size++
			}
		}
		text.WriteRune(r)
		raw = raw[size:]
	}
	return text.String()
}

func valueAt(doc any, path string) (any, bool) {
	for _, step := range jsonPathStep.FindAllStringSubmatch(path, -1) {
		key, index := step[1], step[2]
		switch v := doc.(type) {
		case map[string]any:
			if index != "" {
				return nil, false
			}
			var ok bool
			if doc, ok = v[key]; !ok {
				return nil, false
			}
		case []any:
			i, err := strconv.Atoi(index)
			if err != nil || i >= len(v) {
				return nil, false
			}
			doc = v[i]
		default:
			return nil, false
		}
	}
	return doc, true
}
