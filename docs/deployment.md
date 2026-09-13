# Docker, network exposure and browser access

The proxy is designed to sit on `127.0.0.1` next to the programs that use it.
This page covers the cases where it does not: running it in a container,
publishing it on a network, and calling it from a web page.

One fact drives all of it: **the proxy holds your API key and spends it on
behalf of whoever can reach it.** A reachable proxy is a funded AI endpoint.

## Docker

```bash
docker build -t ppq-private-mode .
docker run -d -e PPQ_API_KEY=sk-your-key -p 127.0.0.1:8787:8787 ppq-private-mode
curl http://127.0.0.1:8787/health   # → {"status":"ok","attestation":true,"apiKeyConfigured":true}
```

A prebuilt image is published as `ghcr.io/payperq/ppq-private-mode`.

Inside the container the proxy binds `0.0.0.0` and exposes port 8787, with a
built-in health check against `GET /health`. Bind the published port to
loopback (`-p 127.0.0.1:8787:8787`, as above) unless you intend to serve other
machines; a bare `-p 8787:8787` listens on every interface of the host.

To keep the key across restarts, mount a data directory and let the status page
save it:

```bash
docker run -d -e PPQ_DATA_DIR=/data -v ppq-data:/data -p 127.0.0.1:8787:8787 ppq-private-mode
# then open http://127.0.0.1:8787 and enter the key — it is stored in /data/config.json
```

## Publishing the port to a network

If other machines are meant to reach the proxy, tell it the hostname they will
use:

```bash
docker run -d -e PPQ_API_KEY=sk-your-key \
  -e PPQ_ALLOWED_HOSTS="ppq-proxy.local:8787" -p 8787:8787 ppq-private-mode
```

Why this matters: on a loopback bind the proxy rejects any request whose `Host`
header is not a loopback name, which stops a hostile website from pointing a
domain it controls at your machine (DNS rebinding) and using your proxy through
your browser. That check cannot be applied automatically to a published port —
such a deployment is legitimately reached under a container or LAN name — so
naming the expected `Host` in `PPQ_ALLOWED_HOSTS` restores it.

Never expose the proxy to a network you do not control.

## Calling the proxy from a browser

Local programs — curl, the OpenAI/Anthropic SDKs, Claude Code, OpenClaw — need
nothing from this section: they send no `Origin` header.

Web pages are different. Since v0.6.0 the proxy refuses requests carrying an
`Origin` from any site other than itself, and sends CORS headers only to origins
you name explicitly:

```bash
PPQ_ALLOWED_ORIGINS="http://localhost:3000" npx ppq-private-mode
```

Only add origins you control. Earlier versions answered
`Access-Control-Allow-Origin: *`, which let any website a user visited spend
their credits and read the replies — see
[issue #28](https://github.com/PayPerQ/ppq-private-mode-proxy/issues/28).
