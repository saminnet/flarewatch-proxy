# AGENTS.md

See [README.md](README.md) for what the proxy is and how FlareWatch uses it.

- Build, vet and test with the Go toolchain: `go build ./cmd/flarewatch-proxy`, `go vet ./...`, `go test -race ./...`. Keep the code `gofmt` clean.
- Run `go tool staticcheck ./...` before you present a change. `staticcheck.conf` holds the check list.
- Build the binary from the Go standard library only. You can add a tool dependency to `go.mod` with `go get -tool`.
- The Go code is one `main` package in `cmd/flarewatch-proxy`. The paths below are relative to that folder.
- The wire contract with FlareWatch lives in `server.go`, `monitor.go`, `check.go` and `assert.go`. It mirrors `services/worker/src/checkers/proxy.ts` in [saminnet/flarewatch](https://github.com/saminnet/flarewatch). Change both repos together.
- FlareWatch holds a copy of each file in `testdata` and runs every case. Keep each copy byte-identical: `http-assertions.json` and `requests.json` in `packages/shared/tests/fixtures`, `verdicts.json` in `services/worker/tests/fixtures`.
- `testdata/requests.json` lists which `/check` bodies the proxy accepts. For a rejected body, it names the field at fault.
- `testdata/verdicts.json` lists the verdict for each target behavior that depends on JavaScript rules. `fixture_test.go` defines the target server and the placeholders.
- The TypeScript proxy that this version replaced gave the expected values in these fixtures. A run on workerd gave the values for the gzip cases, the redirect cases without a body, and the broken UTF-8 cases. Never change an expected value to make a test pass.
- Keep a piece of JavaScript emulation only while a fixture case fails without it. Its comment names the rule it copies.
- Do not reword the assertion failure texts or `Timeout after <timeout>ms`. FlareWatch's own check writes the same texts.
- Do not reword `Unauthorized` or the settings errors.
- A network or TLS failure returns the Go runtime's error text. A 400 error text is free, but it must name the field.
- When a change makes a statement in README.md false, fix README.md in the same change.
