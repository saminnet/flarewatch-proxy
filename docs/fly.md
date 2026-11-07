# Run one proxy in each Fly region

Use one Fly app per region. A single app's anycast hostname routes to the nearest region, which defeats a chosen check location.

Create the app with the published image:

```sh
fly launch --image ghcr.io/saminnet/flarewatch-proxy:2 --name flarewatch-proxy-fra --no-deploy
fly secrets set FLAREWATCH_PROXY_TOKEN='<token>' -a flarewatch-proxy-fra
fly deploy -a flarewatch-proxy-fra
```

Use a separate app name in each region, and set `FLAREWATCH_PROXY_LOCATION` to the region so the status page names it. Without it, the proxy reports the Cloudflare location of its outbound connection, which is usually close but not the same.

Use this minimal `fly.toml`:

```toml
app = "flarewatch-proxy-fra"
primary_region = "fra"

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

Name the app URL in a monitor's `checkProxy` or `confirmVia`:

```ts
checkProxy: 'https://flarewatch-proxy-fra.fly.dev/check'
```

Use the app for checks that need the `fra` vantage point. Repeat the app and region setup for each location.
