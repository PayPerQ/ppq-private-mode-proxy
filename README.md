# ppq-private-mode

**End-to-end encrypted access to PPQ.AI models.** A small proxy that runs on
your machine, verifies the hardware enclave it is about to talk to, and
encrypts every request before it leaves — so PPQ.AI, and everyone between you
and the enclave, sees only ciphertext.

It covers **every model on PPQ**, through two kinds of enclave:

| You ask for | Where it runs | What is inside the enclave |
|---|---|---|
| `private/*` models (Kimi K3, GLM-5.3, gpt-oss, Llama, Gemma, DeepSeek) | **Tinfoil** — AMD SEV-SNP confidential VMs | the model itself: nobody outside the enclave sees your text, ever |
| Any other model (Claude, GPT, Gemini, Grok, …) | **PPQ's own Nitro enclave** on AWS | our routing code: PPQ is blind, and your text goes from the enclave straight to the model provider |

Point any OpenAI- or Anthropic-compatible client at it. No crypto in your code.

## Quick start

Needs Node.js 20+ and a PPQ.AI API key from [ppq.ai/api-docs](https://ppq.ai/api-docs).

```bash
PPQ_API_KEY=sk-your-key npx ppq-private-mode
```

The proxy comes up on `http://127.0.0.1:8787` once both enclaves have been
verified. Then, in OpenAI format:

```bash
# A fully private model — runs inside a Tinfoil enclave
curl http://127.0.0.1:8787/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"private/kimi-k3","messages":[{"role":"user","content":"Hello"}]}'

# A frontier model — routed through PPQ's Nitro enclave, encrypted end to end
curl http://127.0.0.1:8787/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"anthropic/claude-sonnet-5","messages":[{"role":"user","content":"Hello"}]}'
```

Or with any OpenAI SDK:

```js
import OpenAI from "openai";

const client = new OpenAI({ baseURL: "http://127.0.0.1:8787/v1", apiKey: "unused" });

const response = await client.chat.completions.create({
  model: "private/glm-5-3",          // or "openai/gpt-5.3", "google/gemini-3.7-flash", …
  messages: [{ role: "user", content: "Hello" }],
});
```

The proxy bills `PPQ_API_KEY` by default. To bill a different key per request,
send it as a bearer token and the proxy forwards that one instead:

```bash
curl http://127.0.0.1:8787/v1/chat/completions \
  -H "Authorization: Bearer sk-another-key" \
  -H "Content-Type: application/json" \
  -d '{"model":"private/kimi-k3","messages":[{"role":"user","content":"Hello"}]}'
```

Open `http://127.0.0.1:8787` in a browser for a status page (attestation state,
key status, connection snippets, model list).

## Claude Code

The proxy also speaks the Anthropic Messages format at `POST /v1/messages` —
tool calls and streaming included — so Claude Code (or any Anthropic SDK
client) can run through it unchanged.

```bash
# terminal 1
PPQ_API_KEY=sk-your-key npx ppq-private-mode

# terminal 2
export ANTHROPIC_BASE_URL="http://127.0.0.1:8787"
export ANTHROPIC_AUTH_TOKEN="sk-your-key"               # your PPQ.AI API key
export ANTHROPIC_MODEL="private/glm-5-3"                # main model
export ANTHROPIC_SMALL_FAST_MODEL="private/glm-5-3-flash"  # background tasks
claude
```

Any model works in either slot — a `private/*` model for a fully private
session, or a frontier model (`anthropic/claude-opus-5`, …) through the Nitro
enclave. Claude Code drives everything through tool calls; of the `private/*`
models, `glm-5-3`, `glm-5-3-flash`, `gpt-oss-120b`, `llama3-3-70b` and `kimi-k3`
emit them correctly.

## How it works

```
your app ──▶ localhost:8787 ──▶ verify attestation ──▶ encrypt (HPKE) ──▶ PPQ.AI ──▶ enclave
                                                                         sees only
                                                                         ciphertext
```

1. **Verify.** At startup the proxy fetches each enclave's hardware attestation
   and checks it: Tinfoil's against the code measurement in Tinfoil's signed
   release, PPQ's against the `PCR0` published in
   [`ppq-enclave-proxy`](https://github.com/PayPerQ/ppq-enclave-proxy/blob/main/attestation/published-pcr.json)
   (fetched fresh on every start, so enclave releases never leave a stale pin).
   If verification fails, that backend is disabled — nothing is sent to an
   enclave that did not prove what it is running.
2. **Encrypt.** Each request body is sealed with HPKE (RFC 9180) to the public
   key the attestation document commits to — a key that exists only inside the
   verified enclave.
3. **Forward.** PPQ.AI routes the ciphertext to the enclave. It reads your API
   key from the headers for billing and nothing else.
4. **Answer.** The enclave decrypts, runs the request, and encrypts the
   response back to your proxy, which decrypts it on your machine.

The two backends differ in one important way:

- **Tinfoil (`private/*`)**: the model runs *inside* the enclave. Your text is
  never in the clear outside that hardware boundary.
- **PPQ's Nitro enclave (everything else)**: the enclave holds PPQ's routing
  logic and provider keys, not the model. Your text is decrypted inside it and
  sent over TLS to the model's provider (Anthropic, OpenAI, Google, …) —
  which necessarily sees it, to run inference. What the enclave guarantees is
  that **PayPerQ cannot**: the code is public, its measurement is published,
  and your proxy checks that measurement before sending a byte. Details, the
  threat model, and how to verify it yourself:
  [PayPerQ/ppq-enclave-proxy](https://github.com/PayPerQ/ppq-enclave-proxy).

**What neither protects:** metadata. PPQ.AI sees which account made a request,
when, for which model, and how many tokens it used — that is how billing works.
It cannot read the content.

## Models

- `private/*` — the Tinfoil catalog built into the proxy; `GET /v1/models`
  lists them. Currently `kimi-k3`, `gpt-oss-120b`, `llama3-3-70b`, `glm-5-3`,
  `glm-5-3-flash`, `gemma4-31b`, `deepseek-v4-flash`, `deepseek-v4-1-flash`.
  Omitting `model` defaults to `private/kimi-k3`.
- Everything else — any id from [ppq.ai/models](https://ppq.ai/models), passed
  through verbatim to the Nitro enclave. (These are not yet included in
  `GET /v1/models`.)

## Configuration

| Variable | Default | Description |
|---|---|---|
| `PPQ_API_KEY` | — | Your PPQ.AI API key. Required unless `PPQ_DATA_DIR` is set |
| `PPQ_DATA_DIR` | — | Directory for persistent config. With it set, the proxy can start without a key and you save one from the status page (`<dir>/config.json`) |
| `PORT` | `8787` | Local port |
| `HOST` | `127.0.0.1` | Bind address (`0.0.0.0` inside containers — see [deployment](docs/deployment.md)) |
| `PPQ_API_BASE` | `https://api.ppq.ai` | PPQ API base URL (Tinfoil path) |
| `PPQ_ENCLAVE_URL` | `https://enclave.ppq.ai` | PPQ Nitro enclave URL |
| `PPQ_ENCLAVE_PCR0` | published value | Override the expected enclave measurement |
| `PPQ_ALLOWED_ORIGINS` | — | Browser origins allowed to call the proxy |
| `PPQ_ALLOWED_HOSTS` | — | `Host` values to accept when published on a network |
| `DEBUG` | `false` | Verbose logging |

## More

- **[Docker, network exposure and browser access](docs/deployment.md)** — the
  container image, publishing the port safely, `PPQ_ALLOWED_HOSTS` /
  `PPQ_ALLOWED_ORIGINS`.
- **[OpenClaw](skills/private-mode/SKILL.md)** — paste into the OpenClaw chat:
  *"Please install this skill to enable private models via PPQ:
  https://github.com/PayPerQ/ppq-private-mode-proxy/blob/main/skills/private-mode/SKILL.md"*
  (if OpenClaw's guardrails block the link, paste the file's text instead).
- **[Verifying PPQ's enclave yourself](https://github.com/PayPerQ/ppq-enclave-proxy#verifying-the-enclave)**
  — reproducible builds, the published measurement, the reference verifier.

## About

[PPQ.AI](https://ppq.ai) is pay-per-query AI inference with no subscriptions
and no account required. Private models run inside secure enclaves with
hardware-enforced memory encryption. MIT licensed.
