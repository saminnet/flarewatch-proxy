package main

import (
	"strings"
	"testing"
)

func TestReadSettings(t *testing.T) {
	const token = "a-token-of-32-characters-exactly"
	type env = map[string]string
	type testCase struct {
		name string
		env  env
		want settings
		err  string
	}
	cases := []testCase{
		{"token, location and port", env{"FLAREWATCH_PROXY_TOKEN": token, "FLAREWATCH_PROXY_LOCATION": "Home lab", "PORT": "8080"}, settings{Token: token, Location: "Home lab", Port: 8080}, ""},
		{"default port", env{"FLAREWATCH_PROXY_TOKEN": token}, settings{Token: token, Port: 3000}, ""},
		{"empty port", env{"FLAREWATCH_PROXY_TOKEN": token, "PORT": ""}, settings{Token: token, Port: 3000}, ""},
		{"highest port", env{"FLAREWATCH_PROXY_TOKEN": token, "PORT": "65535"}, settings{Token: token, Port: 65535}, ""},
		{"spaces around values", env{"FLAREWATCH_PROXY_TOKEN": " " + token + "\n", "FLAREWATCH_PROXY_TOKEN_PREVIOUS": " the-token-before-this-one\n", "FLAREWATCH_PROXY_LOCATION": " Home lab "}, settings{Token: token, PreviousToken: "the-token-before-this-one", Location: "Home lab", Port: 3000}, ""},
		{"only spaces as location", env{"FLAREWATCH_PROXY_TOKEN": token, "FLAREWATCH_PROXY_LOCATION": "   "}, settings{Token: token, Port: 3000}, ""},
		{"16 characters", env{"FLAREWATCH_PROXY_TOKEN": "sixteen-chars-xy"}, settings{Token: "sixteen-chars-xy", Port: 3000}, ""},
		{"16 accented characters", env{"FLAREWATCH_PROXY_TOKEN": strings.Repeat("é", 16)}, settings{Token: strings.Repeat("é", 16), Port: 3000}, ""},
		{"no token", env{}, settings{}, "FLAREWATCH_PROXY_TOKEN is required"},
		{"only spaces as token", env{"FLAREWATCH_PROXY_TOKEN": "   "}, settings{}, "FLAREWATCH_PROXY_TOKEN is required"},
		{"15 characters", env{"FLAREWATCH_PROXY_TOKEN": "fifteen-chars-x"}, settings{}, "FLAREWATCH_PROXY_TOKEN must be at least 16 characters"},
		{"15 accented characters", env{"FLAREWATCH_PROXY_TOKEN": strings.Repeat("é", 15)}, settings{}, "FLAREWATCH_PROXY_TOKEN must be at least 16 characters"},
		{"short previous token", env{"FLAREWATCH_PROXY_TOKEN": token, "FLAREWATCH_PROXY_TOKEN_PREVIOUS": "short"}, settings{}, "FLAREWATCH_PROXY_TOKEN_PREVIOUS must be at least 16 characters"},
		{"both tokens short", env{"FLAREWATCH_PROXY_TOKEN": "short-token", "FLAREWATCH_PROXY_TOKEN_PREVIOUS": "short"}, settings{}, "FLAREWATCH_PROXY_TOKEN must be at least 16 characters"},
	}
	for _, port := range []string{"0", "65536", "-1", "+80", "80.5", "8080abc", "http", " 8080"} {
		cases = append(cases, testCase{"port " + port, env{"FLAREWATCH_PROXY_TOKEN": token, "PORT": port}, settings{}, "PORT must be a whole number from 1 to 65535"})
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got, err := readSettings(func(key string) string { return c.env[key] })
			if c.err != "" {
				if err == nil || err.Error() != c.err {
					t.Fatalf("error = %v, want %q", err, c.err)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if got != c.want {
				t.Fatalf("settings = %+v, want %+v", got, c.want)
			}
		})
	}
}
