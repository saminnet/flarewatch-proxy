package main

import (
	"errors"
	"fmt"
	"strconv"
	"strings"
	"unicode/utf8"
)

const (
	defaultPort    = 3000
	minTokenLength = 16
)

type settings struct {
	Token         string
	PreviousToken string
	Location      string
	Port          int
}

func readSettings(getenv func(string) string) (settings, error) {
	s := settings{
		Token:         strings.TrimSpace(getenv("FLAREWATCH_PROXY_TOKEN")),
		PreviousToken: strings.TrimSpace(getenv("FLAREWATCH_PROXY_TOKEN_PREVIOUS")),
		Location:      strings.TrimSpace(getenv("FLAREWATCH_PROXY_LOCATION")),
	}
	if s.Token == "" {
		return settings{}, errors.New("FLAREWATCH_PROXY_TOKEN is required")
	}
	for _, env := range []struct{ name, token string }{
		{"FLAREWATCH_PROXY_TOKEN", s.Token},
		{"FLAREWATCH_PROXY_TOKEN_PREVIOUS", s.PreviousToken},
	} {
		if env.token != "" && utf8.RuneCountInString(env.token) < minTokenLength {
			return settings{}, fmt.Errorf("%s must be at least %d characters", env.name, minTokenLength)
		}
	}
	port, ok := readPort(getenv("PORT"))
	if !ok {
		return settings{}, errors.New("PORT must be a whole number from 1 to 65535")
	}
	s.Port = port
	return s, nil
}

func readPort(raw string) (int, bool) {
	if raw == "" {
		return defaultPort, true
	}
	port, err := strconv.ParseUint(raw, 10, 16)
	return int(port), err == nil && port > 0
}
