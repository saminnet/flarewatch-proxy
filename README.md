<h1 align="center">FlareWatch Proxy</h1>

<p align="center">
  A small Node service you run where it can reach what Cloudflare can't.<br />
  FlareWatch sends it a check, it runs the check and sends back the result.
</p>

<p align="center">
  <a href="https://github.com/saminnet/flarewatch">FlareWatch</a> ·
  <a href="https://flarewatch.app">Website</a> ·
  <a href="https://flarewatch.app/docs/monitors#other-regions-and-private-networks">Monitor docs</a>
</p>

<p align="center">
  <img src="docs/assets/how-it-works.svg" alt="How flarewatch-proxy works. The FlareWatch monitor Worker runs at Cloudflare. It sends a check to the proxy on every run when the monitor sets checkProxy, or after a failed check when it sets confirmVia. The request goes to a public URL or a tunnel, which forwards it to flarewatch-proxy inside your network. The proxy checks your private services over HTTP or TCP, and can read their SSL certificates. It returns the result and its location, and the Worker saves both in its Durable Object. A private address such as 192.168.1.10 does not work as the proxy URL, because the Worker cannot reach your network." />
</p>

## When you need it

FlareWatch's monitor Worker runs at Cloudflare and checks your sites from there. Run the proxy when that isn't enough:

- The target is on a [private network](https://flarewatch.app/docs/monitors#other-regions-and-private-networks), such as a NAS, a database or an internal API.
- The target is in the [same Cloudflare zone](https://flarewatch.app/docs/monitors#other-regions-and-private-networks) as the monitor Worker. Cloudflare sends a Worker's requests for its own zone straight to the origin, so a direct check gets a 503.
- You want a warning before an [SSL certificate expires](https://flarewatch.app/docs/monitors#other-regions-and-private-networks). The Worker can't see the certificate. The proxy can.
- You want a [second place to confirm a failure](https://flarewatch.app/docs/monitors#confirm-from-a-second-place) before an incident opens.

## Run it

The proxy won't start without a token of at least 16 characters. Make one:

```bash
openssl rand -base64 32
```

No image is published, so build it from a clone. With Docker Compose, put the token in `docker/.env`:

```bash
git clone https://github.com/saminnet/flarewatch-proxy.git
cd flarewatch-proxy
cp docker/.env.example docker/.env
docker compose -f docker/docker-compose.yml up -d --build
curl http://localhost:3000/health
```

Compose publishes the port on `127.0.0.1`, so only this machine can reach the proxy. To open it to your network, set `BIND_ADDRESS=0.0.0.0` in `docker/.env`.

With plain Docker:

```bash
docker build -t flarewatch-proxy -f docker/Dockerfile .
docker run -d -p 127.0.0.1:3000:3000 \
  -e FLAREWATCH_PROXY_TOKEN='<token>' \
  -e FLAREWATCH_PROXY_LOCATION='Berlin office' \
  flarewatch-proxy
```

The image runs as a non-root user and holds one bundled JavaScript file. Docker calls `/health` every 30 seconds, so `docker ps` shows the container as `healthy` or `unhealthy`.

With Node 24 and pnpm:

```bash
pnpm install --frozen-lockfile
pnpm build
FLAREWATCH_PROXY_TOKEN='<token>' pnpm start
```

Run this way, the proxy listens on every network interface, over plain HTTP. Keep the port closed in your firewall to everything but your reverse proxy or tunnel.

### Give it a public URL

The monitor Worker runs at Cloudflare, not in your network. It reaches the proxy only at a public URL, so `http://192.168.1.100:3000/check` doesn't work. Put the proxy behind a reverse proxy with TLS, such as Caddy or nginx, or behind a [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/). Use an `https://` URL, because the token travels in a header.

A reverse proxy or `cloudflared` on the same machine reaches the proxy at `http://127.0.0.1:3000`. If yours runs on another machine, set `BIND_ADDRESS` in `docker/.env` to an address that machine can reach.

The Compose file can run the tunnel for you, so you open no port and need no reverse proxy. In the Cloudflare dashboard, create a tunnel and give it a public hostname that points to `http://flarewatch-proxy:3000`. Put the tunnel's token in `docker/.env` as `TUNNEL_TOKEN`, then start both containers:

```bash
docker compose -f docker/docker-compose.yml --profile tunnel up -d --build
```

## Configure

| Variable                          | What it's for                                                                     |
| --------------------------------- | --------------------------------------------------------------------------------- |
| `FLAREWATCH_PROXY_TOKEN`          | Required. FlareWatch sends it as `Authorization: Bearer <token>`.                 |
| `FLAREWATCH_PROXY_TOKEN_PREVIOUS` | A second token the proxy also accepts. See [Change the token](#change-the-token). |
| `FLAREWATCH_PROXY_LOCATION`       | The name FlareWatch records for checks run here. See [Location](#location).       |
| `PORT`                            | The port to listen on. The default is `3000`.                                     |

The proxy drops spaces and line breaks around the token. A token shorter than 16 characters stops the proxy at startup, and so does a `PORT` that isn't a whole number from 1 to 65535.

FlareWatch needs the same token. In your FlareWatch fork, open **Settings > Secrets and variables > Actions** and add it as `FLAREWATCH_PROXY_TOKEN`, as the [deploy guide](https://flarewatch.app/docs/deploy#3-add-secrets-to-your-fork) shows. With the GitHub CLI:

```bash
gh secret set FLAREWATCH_PROXY_TOKEN --repo <you>/flarewatch
```

The next deploy copies it onto the monitor Worker. Without it, the Worker sends no token and every check through the proxy fails with `Proxy HTTP 401`. The Worker holds one token, so all your proxies need the same one.

Don't put the token in a monitor's `headers`. The proxy sends those headers on to the target.

### Change the token

To change the token with no failed checks:

1. On the proxy, set `FLAREWATCH_PROXY_TOKEN` to the new token and `FLAREWATCH_PROXY_TOKEN_PREVIOUS` to the old one, then restart it. It accepts both.
2. Set the new token as the `FLAREWATCH_PROXY_TOKEN` secret in your FlareWatch fork and deploy.
3. Remove `FLAREWATCH_PROXY_TOKEN_PREVIOUS` from the proxy and restart it.

## Use it from FlareWatch

Monitors live in `packages/config/src/worker.ts` in your fork. `checkProxy` runs every check of a monitor through the proxy. The target can be a private address, because the proxy is the one that reaches it:

```ts
{
  id: 'nas',
  name: 'NAS',
  method: 'GET',
  target: 'http://192.168.1.20:5000',
  checkProxy: 'https://proxy.example.com/check',
}
```

```ts
{
  id: 'db',
  name: 'Database',
  method: 'TCP_PING',
  target: '192.168.1.50:5432',
  checkProxy: 'https://proxy.example.com/check',
}
```

When the proxy fails, the check fails. Set `checkProxyFallback: true` to fall back to a direct check from the Worker.

For certificate expiry, add `sslCheckEnabled: true` and `sslCheckDaysBeforeExpiry: 14` to a monitor with an `https://` target.

`confirmVia` keeps the Worker as the first place to check and uses the proxy as the second:

```ts
{
  id: 'site',
  name: 'Website',
  method: 'GET',
  target: 'https://example.com',
  confirmVia: 'https://proxy.example.com/check',
}
```

When a check fails, FlareWatch runs it once more through the proxy, straight away, and records that result and its location. The monitor goes down only when the proxy sees it down too. `confirmVia` must name a different place than `checkProxy`.

Not every place can run every check. The [settings table](https://flarewatch.app/docs/monitors#other-regions-and-private-networks) lists what a proxy can run, and FlareWatch refuses a monitor that asks it for more.

## What it checks

An HTTP check sends the monitor's method, `headers` and `body`, and follows redirects. It sends the user agent `FlareWatch-Proxy/1.0` unless `headers` sets one. The check fails on a status outside `expectedCodes`, or outside 2xx when that's unset. It also fails when `responseKeyword` is missing from the first 1 MiB of the body, or when `responseForbiddenKeyword` is in it.

A redirecting target's next hop gets the monitor's `headers` too. When a redirect leads to another origin, Node's fetch drops `Authorization`, `Cookie` and `Proxy-Authorization`, but keeps every other header, such as `X-Api-Key`. Don't put a secret in `headers` for a target you don't control.

A `TCP_PING` check opens a connection to `host:port` and closes it.

With `sslCheckEnabled`, the proxy reads the certificate of the `https://` URL the redirects end at. If they end at a plain `http://` URL, the check passes without an `ssl` block. The check fails when the certificate expires within `sslCheckDaysBeforeExpiry` days, 30 by default. `sslIgnoreSelfSigned: true` turns off certificate verification, for the request and for the certificate check, so a self-signed certificate passes.

A check and its SSL step finish within the monitor's `timeout`, 10 seconds by default.

`responseHeaderEquals` fails the check when a listed header is missing or has another value. Header names ignore case and values don't. `responseJsonPath` with `responseJsonValue` reads the body as JSON and fails when the value at a path such as `$.checks[0].status` isn't equal to `responseJsonValue`. A JSON body of 1 MiB or more fails, because the proxy can't read all of it. The proxy runs the status first, then the headers, then the body, and reports the first that fails.

FlareWatch runs header and JSON checks through a proxy at 1.1.0 or later. An older proxy would skip them and pass, so FlareWatch fails those checks with an error that asks you to update it. It knows a proxy's version by the `contract` field in each reply.

## Location

Each result carries a location, and FlareWatch records it with the result. Set `FLAREWATCH_PROXY_LOCATION` to a name you'll recognise, such as `Berlin office`.

Without it, the proxy asks Cloudflare's trace endpoint, `https://cloudflare.com/cdn-cgi/trace`, at startup. It uses the Cloudflare data centre code that comes back, such as `FRA`. This is the one outbound call the proxy makes on its own. A check never waits for it. Until an answer comes back the location is `UNKNOWN`, and after a failed lookup the proxy tries again no sooner than a minute later.

The Worker records its own location as a data centre code too. A proxy near the Worker's data centre gets the same code, so a confirmation looks like the Worker's own check. Set `FLAREWATCH_PROXY_LOCATION` to tell them apart.

## API

| Route         | Token | Returns                                      |
| ------------- | ----- | -------------------------------------------- |
| `GET /`       | no    | The name, version, contract and routes.      |
| `GET /health` | no    | `{"status": "ok", "timestamp": <ms>}`        |
| `POST /check` | yes   | The result of the check in the request body. |

`POST /check` takes the monitor as FlareWatch sends it. Only `target` is required. It reads `id`, `name`, `method` (default `GET`), `target`, `expectedCodes`, `timeout`, `headers`, `body`, `responseKeyword`, `responseForbiddenKeyword`, `responseHeaderEquals`, `responseJsonPath`, `responseJsonValue`, `sslCheckEnabled`, `sslCheckDaysBeforeExpiry` and `sslIgnoreSelfSigned`, and ignores other fields. It checks them as FlareWatch's config check does: for example `timeout` must be a whole number from 1 to 60000, and `target` an `http(s)` URL, or `host:port` for `TCP_PING`. The body can be at most 64 KiB.

```bash
curl -s https://proxy.example.com/check \
  -H "Authorization: Bearer $FLAREWATCH_PROXY_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"method": "GET", "target": "https://example.com", "sslCheckEnabled": true}'
```

```json
{
  "contract": 2,
  "location": "Berlin office",
  "result": {
    "ok": true,
    "latency": 145,
    "ssl": {
      "expiryDate": 1735689600,
      "daysUntilExpiry": 89,
      "issuer": "Let's Encrypt",
      "subject": "example.com"
    }
  }
}
```

`contract` is 2 from proxy 1.1.0 on, and tells FlareWatch the proxy runs header and JSON checks. A failed check has `"ok": false` and an `error`, and usually a `latency`. `ssl` comes back only when `sslCheckEnabled` is set and the check passes. `expiryDate` is in Unix seconds.

| Status | Means                                                          |
| ------ | -------------------------------------------------------------- |
| 200    | The check ran. `result.ok` says whether it passed.             |
| 400    | The body isn't JSON, or a field is invalid. `{"error": "..."}` |
| 401    | The token is missing or wrong. `{"error": "Unauthorized"}`     |
| 413    | The body is over 64 KiB. `{"error": "..."}`                    |
| 500    | The proxy itself failed. `{"error": "..."}`                    |

## Development

You need Node 24. The `packageManager` field in `package.json` pins pnpm, and the scripts run Vite+ (`vp`).

```bash
pnpm install
FLAREWATCH_PROXY_TOKEN=local-dev-token-0001 pnpm dev   # restarts on change
pnpm check                                             # format, lint and types
pnpm test
pnpm build                                             # dist/index.mjs
```

The lint rules in `tools/oxlint/anti-slop/` are a copy from FlareWatch. Don't edit them here.

MIT licensed. See [LICENSE](LICENSE).
