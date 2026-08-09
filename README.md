# What are "TEE" AI models?

TEE (Trusted Execution Environment) AI models allow users to run AI queries in the cloud and on remote servers without those servers having access to the content of the users' queries. This delivers one of the best AI capability to privacy tradeoffs in the industry currently.

# ppq-private-mode: Use PPQ's Private (TEE) AI models via our API and with OpenClaw

The trick in using private models is that you need to encrypt the content of your request before sending them onto PPQ and its AI provider. With our proxy repo, you encrypt the queries on your machine before they leave -- neither PPQ.AI nor anyone else can read them.

The repo supports both standalone use cases with your own custom code as well as usage inside of openclaw.

# OpenClaw usage

For openclaw usage, simply paste in this command to your openclaw chat interface:

```
Please install this skill to enable private models via PPQ: https://github.com/PayPerQ/ppq-private-mode-proxy/blob/main/skills/private-mode/SKILL.md
```

In some cases, openclaw's safety guardrails block installation via direct links. In that case, try to paste in the text of the skill file. If issues still persist, create an issue in this repo here to help the community troubleshoot.

# Standalone usage

You can run the proxy directly without OpenClaw and point any OpenAI-compatible client at it.

**Prerequisites:** Node.js 20+ and a PPQ.AI API key from [ppq.ai/api-docs](https://ppq.ai/api-docs).

**Start the proxy:**

```bash
PPQ_API_KEY=sk-your-key npx ppq-private-mode
```

The proxy starts on port 8787 and prints a ready message once attestation succeeds.

**Send a request** (standard OpenAI chat completions format):

```bash
curl http://127.0.0.1:8787/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"private/kimi-k3","messages":[{"role":"user","content":"Hello"}]}'
```

The proxy bills against `PPQ_API_KEY` by default. To use a different key per request, pass it as a bearer token and the proxy will forward it instead:

```bash
curl http://127.0.0.1:8787/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer sk-another-key" \
  -d '{"model":"private/kimi-k3","messages":[{"role":"user","content":"Hello"}]}'
```

**Or point any OpenAI SDK at it:**

```js
import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "http://127.0.0.1:8787/v1",
  apiKey: "unused",
});

const response = await client.chat.completions.create({
  model: "private/kimi-k3",
  messages: [{ role: "user", content: "Hello" }],
});
```

**Environment variables:**

| Variable | Required | Default | Description |
|---|---|---|---|
| `PPQ_API_KEY` | Yes* | — | Your PPQ.AI API key |
| `PPQ_DATA_DIR` | No* | — | Directory for persistent config; enables saving the key from the status page |
| `PORT` | No | `8787` | Local proxy port |
| `HOST` | No | `127.0.0.1` | Bind address (use `0.0.0.0` inside containers) |
| `PPQ_API_BASE` | No | `https://api.ppq.ai` | PPQ API base URL |
| `DEBUG` | No | `false` | Set to `true` for verbose logging |

\*At least one of `PPQ_API_KEY` / `PPQ_DATA_DIR` is required. With
`PPQ_DATA_DIR` set, the proxy can start without a key: open the status page in
a browser and save the key there — it persists to `<dir>/config.json` and takes
effect immediately.

# Status page

`GET /` serves a human-facing status page: enclave attestation state, API key
status, connection snippets, and the model list. When `PPQ_DATA_DIR` is set it
also offers the API-key setup form (the saved key is never echoed back).
`GET /health` remains machine-readable JSON.

# Docker usage

```bash
docker build -t ppq-private-mode .
docker run -d -e PPQ_API_KEY=sk-your-key -p 8787:8787 ppq-private-mode
curl http://127.0.0.1:8787/health   # → {"status":"ok","attestation":true}
```

The image binds to `0.0.0.0` inside the container and exposes port 8787, with a
built-in health check against `GET /health`.

# Claude Code usage

Claude Code (and any other Anthropic-SDK client) speaks the Anthropic Messages
format, not the OpenAI format. The proxy exposes a native Anthropic endpoint at
`POST /v1/messages` that translates to/from the encrypted enclave for you —
including tool calls and streaming — so you can point Claude Code straight at it.

**1. Start the proxy** (leave it running in its own terminal):

```bash
PPQ_API_KEY=sk-your-key npx ppq-private-mode
```

**2. Point Claude Code at the proxy** and pick a private model. Set these
environment variables before launching `claude`:

```bash
export ANTHROPIC_BASE_URL="http://127.0.0.1:8787"
export ANTHROPIC_AUTH_TOKEN="sk-your-key"   # your PPQ.AI API key
# Route every Claude Code "model slot" to a private model:
export ANTHROPIC_MODEL="private/glm-5-2"             # main model
export ANTHROPIC_SMALL_FAST_MODEL="private/glm-5-2"  # background tasks

claude
```

**Use `private/glm-5-2` for Claude Code.** Claude Code drives everything through
tool calls, and `glm-5-2`, `gpt-oss-120b`, and `llama3-3-70b` all emit tool
calls correctly through the enclave, and `private/kimi-k3` advertises
tool-calling support as well. Every request Claude Code makes is end-to-end
encrypted to the PPQ enclave.

**Verify the endpoint directly** (Anthropic Messages format):

```bash
curl http://127.0.0.1:8787/v1/messages \
  -H "Content-Type: application/json" \
  -d '{"model":"private/glm-5-2","max_tokens":256,"messages":[{"role":"user","content":"Hello"}]}'
```

## How This proxy repo works

The code in this runs a local proxy on your machine (port 8787) that:

1. **Verifies the enclave** -- performs hardware attestation to confirm it's talking to a genuine secure enclave, not an impersonator
2. **Encrypts your request** -- uses HPKE (RFC 9180) to encrypt the entire request body before it leaves your machine
3. **Sends the encrypted blob** -- PPQ.AI routes the encrypted data to the secure enclave. PPQ.AI only sees ciphertext.
4. **Enclave processes privately** -- the enclave decrypts your query, runs the AI model, and re-encrypts the response
5. **Your proxy decrypts** -- the response is decrypted locally on your machine

PPQ.AI handles billing via HTTP headers (your API key), so they never need to see the actual content of your queries.

## About

PPQ.AI provides pay-per-query AI inference with no subscriptions. Private models run inside secure enclaves with hardware-enforced memory encryption. Learn more at https://ppq.ai
