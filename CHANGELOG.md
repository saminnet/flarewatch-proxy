# Changelog

All notable changes to FlareWatch Proxy will be documented in this file.

## 2.0.0 - 2026-10-06

FlareWatch needs this release to run `responseHeaderEquals` and `responseJsonPath` checks through a proxy.

The proxy is now written in Go. If you run it with Node and pnpm, switch to Docker, or build the binary with Go 1.27. With Docker Compose you run the same commands as before.

The proxy no longer starts with a token shorter than 16 characters. If yours is shorter, make a new one with `openssl rand -base64 32` and set it on the proxy and in your FlareWatch fork before you update.

Docker Compose now publishes the port on `127.0.0.1` only. If a reverse proxy on another machine reaches the proxy over your network, set `BIND_ADDRESS=0.0.0.0` in `docker/.env` before you update.

### Added

- `responseHeaderEquals` checks response headers, and `responseJsonPath` with `responseJsonValue` checks one value in a JSON response. They work and fail the same way as in FlareWatch, with the same error texts.
- `FLAREWATCH_PROXY_TOKEN_PREVIOUS` names a second token the proxy accepts, so you can change the token with no failed checks.
- The Docker image has a health check on `/health`.
- `docker compose --profile tunnel up` also runs `cloudflared`, with the tunnel token in `TUNNEL_TOKEN`. The proxy then needs no open port and no reverse proxy.
- Every `/check` reply and `GET /` carry `"contract": 2`. FlareWatch reads it to know that the proxy runs header and JSON checks.

### Changed

- The proxy is written in Go and ships as one static binary with no shell. The routes, the settings errors, the texts of failed assertions and the `Timeout after <timeout>ms` text stay the same. A network or TLS failure now reports what the Go runtime found, such as `connect: connection refused`, instead of the Node error code. So does a request header the proxy can't send.
- `/check` checks the request the way FlareWatch's config check does, and answers 400 when a field is wrong. `method` must be one of `GET`, `POST`, `PUT`, `PATCH`, `DELETE`, `HEAD`, `OPTIONS` or `TCP_PING`. Before, an unknown method ran as an HTTP request. `timeout` must be a whole number from 1 to 60000. `expectedCodes` must list at least one code, each a whole number from 100 to 599. Neither keyword can be empty. `sslCheckDaysBeforeExpiry` must be a whole number from 0 to 3650. `target` must be an `http://` or `https://` URL, or `host:port` for `TCP_PING`. Before, a `data:` URL passed without a request. A field set to `null` counts as missing. A body that repeats a field name, or isn't valid UTF-8, gets a 400.
- A `/check` body over 64 KiB gets a 413.
- Docker Compose publishes the port on `127.0.0.1` by default. `BIND_ADDRESS` in `docker/.env` changes it.
- The proxy finds its location from Cloudflare's trace only. The ipapi.co lookup is gone. The lookup starts with the proxy, and a check never waits for it. The location is `UNKNOWN` until it answers, and a failed lookup is tried again after a minute. Before, the first check waited for the lookup, and a failure left the location `UNKNOWN` until a restart.
- Keyword checks read the first 1 MiB of the body and no more. Before, the proxy read the whole body.
- A network error names its cause, such as `connect: connection refused`. Before, it said only `fetch failed`.
- `GET /` links to this repository.
- `GET /` no longer shows the version. The startup log line shows it instead.
- A `PORT` that isn't a whole number from 1 to 65535 stops the proxy at startup. Before, the proxy listened on 3000 without a word.
- A token shorter than 16 characters stops the proxy at startup. Before, any token was accepted.

### Fixed

- `sslIgnoreSelfSigned: true` now applies to the HTTP request too. Before, it applied only to the certificate step, so the request to a self-signed target failed.
- After a redirect, the SSL step reads the certificate of the URL the redirects end at. If that URL is plain `http://`, the check passes without an `ssl` block. Before, the proxy read the first URL's certificate, so a final hop's expiring certificate went unnoticed.
- The SSL step ends within the monitor's `timeout`. Before, it took at least another second, even when the request had used up the time. A timeout in the SSL step now reports `Timeout after <timeout>ms`.
- A target written with `HTTPS://` in capitals gets its certificate checked too.
- A `TCP_PING` check closes its connection as soon as the check is done. Before, it kept the connection until the timeout.
- A certificate that repeats an issuer or subject attribute reports it as one string, not a list.
- Spaces or a line break around `FLAREWATCH_PROXY_TOKEN` no longer make every request fail with 401. The proxy drops them.
- A `FLAREWATCH_PROXY_LOCATION` of only spaces no longer becomes the location. The proxy finds the location itself.
- The SSL step works for a target written as an IPv6 address, such as `https://[fd00::10]`. Before, it failed with `getaddrinfo ENOTFOUND`.
- A `TCP_PING` target written as an IPv6 address, such as `[fd00::10]:5432`, now connects. Before, it failed with `getaddrinfo ENOTFOUND`.
- The SSL step closes its connection as soon as it has the certificate. Before, a target that kept sending could hold the connection open.
