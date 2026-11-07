# Run one proxy in each Hetzner location

Hetzner Cloud has six locations, and each one can be a vantage point. Create one small server per location you want. Any Shared AMD plan is enough: the proxy is one static binary with no state.

| Code | Location |
|---|---|
| `fsn1` | Falkenstein, Germany |
| `nbg1` | Nuremberg, Germany |
| `hel1` | Helsinki, Finland |
| `ash` | Ashburn, Virginia, USA |
| `hil` | Hillsboro, Oregon, USA |
| `sin` | Singapore |

Create the server with Ubuntu and the Docker app image, or install Docker yourself. Then run the published image, with the location set by hand so the status page names the place you chose:

```sh
docker run -d --name flarewatch-proxy --restart unless-stopped \
  -p 127.0.0.1:3000:3000 \
  -e FLAREWATCH_PROXY_TOKEN='<token>' \
  -e FLAREWATCH_PROXY_LOCATION=HEL1 \
  ghcr.io/saminnet/flarewatch-proxy:2
```

The port is bound to localhost on purpose. The Worker needs an `https://` URL, so put a reverse proxy with TLS in front, such as Caddy, or run the [Compose file with the tunnel profile](../README.md#give-it-a-public-url) instead of plain `docker run`. With the tunnel you open no port at all, and the Hetzner firewall can block everything inbound except SSH.

Name each server in a monitor's `checkProxy` or `confirmVia`:

```ts
confirmVia: ['https://proxy-hel1.example.com/check', 'https://proxy-ash.example.com/check'],
```

To update, pull the image and recreate the container:

```sh
docker pull ghcr.io/saminnet/flarewatch-proxy:2
docker rm -f flarewatch-proxy
```

Then run the `docker run` command again.
