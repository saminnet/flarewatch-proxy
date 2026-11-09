# Run one proxy in each Fly region

Use one Fly app per region. A single app's anycast hostname routes to the nearest region, which defeats a chosen check location.

Save this minimal `fly.toml` in an empty directory:

```toml
app = "flarewatch-proxy-fra"
primary_region = "fra"

[build]
  image = "ghcr.io/saminnet/flarewatch-proxy:2"

[env]
  FLAREWATCH_PROXY_LOCATION = "FRA"

[http_service]
  internal_port = 3000
  force_https = true
  auto_start_machines = true
  auto_stop_machines = "stop"
  min_machines_running = 1

  [[http_service.checks]]
    method = "GET"
    path = "/health"
    interval = "30s"
    timeout = "5s"
    grace_period = "10s"
```

Use a separate app name in each region, and set `FLAREWATCH_PROXY_LOCATION` to the region so the status page names it. Without it, the proxy reports the Cloudflare location of its outbound connection, which is usually close but not the same.

Create the app, set its token and deploy from that directory:

```sh
fly apps create flarewatch-proxy-fra
fly secrets set FLAREWATCH_PROXY_TOKEN='<token>' -a flarewatch-proxy-fra
fly deploy
```

Name the app URL in a monitor's `checkProxy` or `confirmVia`:

```ts
checkProxy: 'https://flarewatch-proxy-fra.fly.dev/check'
```

Use the app for checks that need the `fra` vantage point. Repeat the app and region setup for each location.
