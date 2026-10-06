package main

import (
	"cmp"
	"encoding/json/jsontext"
	"encoding/json/v2"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"time"
)

const (
	tcpPing      = "TCP_PING"
	maxTimeoutMS = 60_000
)

var methods = []string{"GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS", tcpPing}

var (
	headerName = regexp.MustCompile("^[!#$%&'*+.^_`|~0-9A-Za-z-]+$")
	jsonPath   = regexp.MustCompile(`^\$(?:\.[^.[\]]+|\[\d+\])*$`)
)

type monitor struct {
	ID                       string              `json:"id"`
	Name                     string              `json:"name"`
	Method                   string              `json:"method"`
	Target                   string              `json:"target"`
	Timeout                  int                 `json:"timeout"`
	ExpectedCodes            []int               `json:"expectedCodes"`
	Headers                  fields[headerValue] `json:"headers"`
	Body                     *string             `json:"body"`
	ResponseKeyword          *string             `json:"responseKeyword"`
	ResponseForbiddenKeyword *string             `json:"responseForbiddenKeyword"`
	ResponseHeaderEquals     fields[string]      `json:"responseHeaderEquals"`
	ResponseJSONPath         *string             `json:"responseJsonPath"`
	ResponseJSONValue        jsontext.Value      `json:"responseJsonValue"`
	SSLCheckEnabled          bool                `json:"sslCheckEnabled"`
	SSLCheckDaysBeforeExpiry int                 `json:"sslCheckDaysBeforeExpiry"`
	SSLIgnoreSelfSigned      bool                `json:"sslIgnoreSelfSigned"`

	wantJSON any
}

var errNotObject = errors.New("the body must be a JSON object")

var fieldTypes = map[string]string{
	"timeout":                  "a whole number",
	"sslCheckDaysBeforeExpiry": "a whole number",
	"expectedCodes":            "a list of whole numbers",
	"headers":                  "an object of strings or numbers",
	"responseHeaderEquals":     "an object of strings",
	"sslCheckEnabled":          "true or false",
	"sslIgnoreSelfSigned":      "true or false",
}

func parseMonitor(body []byte) (*monitor, error) {
	m := &monitor{Method: http.MethodGet, Timeout: 10_000, SSLCheckDaysBeforeExpiry: 30}
	if err := json.Unmarshal(body, &m); err != nil {
		return nil, decodeError(err)
	}
	if m == nil {
		return nil, errNotObject
	}
	if err := m.validate(); err != nil {
		return nil, err
	}
	return m, nil
}

func decodeError(err error) error {
	if serr, ok := errors.AsType[*jsontext.SyntacticError](err); ok && errors.Is(err, jsontext.ErrDuplicateName) {
		if serr.JSONPointer.Parent() == "" {
			return fmt.Errorf("%s must appear only once", serr.JSONPointer.LastToken())
		}
		return fmt.Errorf("%s must not repeat a name", firstToken(serr.JSONPointer))
	}
	serr, ok := errors.AsType[*json.SemanticError](err)
	if !ok {
		return errors.New("the body is not valid JSON")
	}
	field := firstToken(serr.JSONPointer)
	if field == "" {
		return errNotObject
	}
	return fmt.Errorf("%s must be %s", field, cmp.Or(fieldTypes[field], "a string"))
}

func firstToken(p jsontext.Pointer) string {
	for name := range p.Tokens() {
		return name
	}
	return ""
}

func (m *monitor) validate() error {
	if !slices.Contains(methods, m.Method) {
		return fmt.Errorf("method must be one of %s", strings.Join(methods, ", "))
	}
	if m.Method == tcpPing {
		if !validHostPort(strings.TrimSpace(tcpAddress(m.Target))) {
			return errors.New("target must be host:port for TCP_PING")
		}
	} else if !validHTTPURL(cleanURL(m.Target)) {
		return errors.New("target must be an http or https URL")
	}
	if m.Timeout < 1 || m.Timeout > maxTimeoutMS {
		return fmt.Errorf("timeout must be from 1 to %d milliseconds", maxTimeoutMS)
	}
	if m.ExpectedCodes != nil && len(m.ExpectedCodes) == 0 {
		return errors.New("expectedCodes must list at least one status code")
	}
	for _, code := range m.ExpectedCodes {
		if code < 100 || code > 599 {
			return errors.New("expectedCodes must hold status codes from 100 to 599")
		}
	}
	if m.ResponseKeyword != nil && *m.ResponseKeyword == "" {
		return errors.New("responseKeyword must not be empty")
	}
	if m.ResponseForbiddenKeyword != nil && *m.ResponseForbiddenKeyword == "" {
		return errors.New("responseForbiddenKeyword must not be empty")
	}
	if m.ResponseHeaderEquals != nil && len(m.ResponseHeaderEquals) == 0 {
		return errors.New("responseHeaderEquals must name at least one header")
	}
	for _, h := range m.ResponseHeaderEquals {
		if !headerName.MatchString(h.Name) {
			return fmt.Errorf("responseHeaderEquals has an invalid header name %q", h.Name)
		}
	}
	if m.ResponseJSONPath != nil && !jsonPath.MatchString(*m.ResponseJSONPath) {
		return errors.New("responseJsonPath must be a path like $.a.b[0].c")
	}
	switch {
	case m.ResponseJSONPath != nil && m.ResponseJSONValue == nil:
		return errors.New("responseJsonValue is required with responseJsonPath")
	case m.ResponseJSONPath == nil && m.ResponseJSONValue != nil:
		return errors.New("responseJsonPath is required with responseJsonValue")
	case m.ResponseJSONValue != nil:
		if !slices.Contains([]jsontext.Kind{'"', '0', 't', 'f', 'n'}, m.ResponseJSONValue.Kind()) ||
			json.Unmarshal(m.ResponseJSONValue, &m.wantJSON) != nil || m.ResponseJSONValue.Canonicalize() != nil {
			return errors.New("responseJsonValue must be a string, number, boolean or null")
		}
	}
	if m.SSLCheckDaysBeforeExpiry < 0 || m.SSLCheckDaysBeforeExpiry > 3650 {
		return errors.New("sslCheckDaysBeforeExpiry must be from 0 to 3650")
	}
	return nil
}

func (m *monitor) timeout() time.Duration {
	return time.Duration(m.Timeout) * time.Millisecond
}

func validHTTPURL(s string) bool {
	u, err := url.Parse(s)
	return err == nil && (u.Scheme == "http" || u.Scheme == "https") && u.Hostname() != "" && (u.Port() == "" || validPort(u.Port()))
}

func validHostPort(s string) bool {
	host, port, err := net.SplitHostPort(s)
	return err == nil && host != "" && !strings.ContainsAny(host, " @") && validPort(port)
}

func validPort(port string) bool {
	n, err := strconv.ParseUint(port, 10, 16)
	return err == nil && n > 0
}

// cleanURL applies the input rules of the WHATWG URL parser, which fetch and
// FlareWatch's own checks use: tab, CR and LF go wherever they are, C0
// controls and spaces go at both ends.
func cleanURL(s string) string {
	s = strings.NewReplacer("\t", "", "\n", "", "\r", "").Replace(s)
	return strings.TrimFunc(s, func(r rune) bool { return r <= ' ' })
}

// tcpAddress cleans a TCP_PING target as FlareWatch does when it parses
// "tcp://" + target. Only the end of the target is the end of that URL, so a
// leading space stays and the dial fails, as it does in FlareWatch.
func tcpAddress(target string) string {
	return strings.TrimPrefix(cleanURL("tcp://"+target), "tcp://")
}

// fields is a JSON object kept in document order. The order shows: header
// values that share a name join in that order, and the first failing
// responseHeaderEquals entry is the one reported.
type fields[V any] []field[V]

type field[V any] struct {
	Name  string
	Value V
}

func (f *fields[V]) UnmarshalJSONFrom(dec *jsontext.Decoder) error {
	tok, err := dec.ReadToken()
	if err != nil || tok.Kind() == 'n' {
		return err
	}
	if tok.Kind() != '{' {
		return errors.New("must be an object")
	}
	*f = fields[V]{}
	for dec.PeekKind() != '}' {
		tok, err := dec.ReadToken()
		if err != nil {
			return err
		}
		name := tok.String()
		if dec.PeekKind() == 'n' {
			return fmt.Errorf("%q must not be null", name)
		}
		var v V
		if err := json.UnmarshalDecode(dec, &v); err != nil {
			return err
		}
		*f = append(*f, field[V]{name, v})
	}
	_, err = dec.ReadToken()
	return err
}

// headerValue is a request header value, which FlareWatch's config allows to
// be a string or a number. FlareWatch sends a number as JavaScript prints it,
// so its JSON text is the value fetch would send.
type headerValue string

func (h *headerValue) UnmarshalJSONFrom(dec *jsontext.Decoder) error {
	tok, err := dec.ReadToken()
	if err != nil {
		return err
	}
	if k := tok.Kind(); k != '"' && k != '0' {
		return errors.New("must be a string or a number")
	}
	*h = headerValue(tok.String())
	return nil
}
