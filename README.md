# ppq-private-mode

**End-to-end encrypted access to PPQ.AI models.** A small proxy that runs on
your machine, verifies the hardware enclave it is about to talk to, and
encrypts every request before it leaves — so PPQ.AI, and everyone between you
and the enclave, sees only ciphertext.

It covers **every model on PPQ**, by one of two paths depending on the model
you name:

| | You ask for | Where it runs | What is inside the enclave |
|---|---|---|---|
| **Path 1** | `private/*` models (Kimi K3, GLM-5.3, gpt-oss, Llama, Gemma, DeepSeek) | **Tinfoil** — AMD SEV-SNP confidential VMs | the model itself: nobody outside the enclave sees your text, ever |
| **Path 2** | any other model (Claude, GPT, Gemini, Grok, …) | **PPQ's own Nitro enclave** on AWS | our routing code: PPQ is blind, and your text goes from the enclave straight to the model provider |

The two paths give different guarantees — [How it works](#how-it-works--two-paths)
spells each one out.

Point any OpenAI- or Anthropic-compatible client at it. No crypto in your code.

## Quick start

Needs Node.js 20+ and a PPQ.AI API key from [ppq.ai/api-docs](https://ppq.ai/api-docs).

```bash
PPQ_API_KEY=sk-your-key npx ppq-private-mode
```

The proxy comes up on `http://127.0.0.1:8787` once both enclaves have been
verified. Then, in OpenAI format:

```bash
# Path 1 — a fully private model, runs inside a Tinfoil enclave
curl http://127.0.0.1:8787/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"private/kimi-k3","messages":[{"role":"user","content":"Hello"}]}'

# Path 2 — a frontier model, encrypted to PPQ's Nitro enclave
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

Any model works in either slot — a `private/*` model (Path 1) for a fully
private session, or a frontier model such as `anthropic/claude-opus-5`
(Path 2) through PPQ's Nitro enclave. Claude Code drives everything through tool calls; of the `private/*`
models, `glm-5-3`, `glm-5-3-flash`, `gpt-oss-120b`, `llama3-3-70b` and `kimi-k3`
emit them correctly.

## How it works — two paths

The proxy does the same two things for every request: **verify** the enclave
it is about to talk to, then **encrypt** the request to that enclave and
nothing else. Which enclave depends on the model you name. The two paths are
different products with different guarantees, so they are described
separately.

### Path 1 — `private/*` models: the model runs inside a Tinfoil enclave

```
your app ─▶ proxy ══ HPKE ══▶ api.ppq.ai/private ══▶ Tinfoil enclave (AMD SEV-SNP)
             │ verifies       relays ciphertext,      decrypts, RUNS THE MODEL,
             │ Tinfoil's      bills your key           encrypts the reply
             │ attestation
```

- **Who can read your text:** you, and the model running inside the enclave.
  Not PPQ. Not Tinfoil's operators. Not the cloud it runs on.
- **What is verified:** Tinfoil's hardware attestation, checked against the
  code measurement in Tinfoil's signed release (`tinfoilsh/confidential-model-router`).
- **What PPQ does:** relays ciphertext and bills the API key in the headers.

This is the stronger guarantee — the whole inference happens inside the
enclave — and it is available for the open-weight models Tinfoil hosts.

### Path 2 — every other model: PPQ's routing runs inside a Nitro enclave

```
your app ─▶ proxy ══ HPKE ══▶ enclave.ppq.ai ══▶ PPQ Nitro enclave ──TLS──▶ model provider
             │ verifies       load balancer,       decrypts, picks the        (Anthropic,
             │ PPQ's          forwards bytes       upstream, holds the keys,   OpenAI, …)
             │ attestation                         encrypts the reply          sees plaintext
```

- **Who can read your text:** you, the enclave, and the model's provider —
  Anthropic, OpenAI, Google, xAI, or whoever serves that model. A frontier
  model cannot run inside an enclave, so its provider necessarily sees the
  prompt. **PPQ does not.**
- **What is verified:** AWS Nitro's hardware attestation, checked against the
  `PCR0` measurement PPQ publishes in
  [`ppq-enclave-proxy`](https://github.com/PayPerQ/ppq-enclave-proxy/blob/main/attestation/published-pcr.json).
  The enclave's code is public and its build is reproducible, so anyone can
  confirm that measurement corresponds to that code. The proxy fetches the
  published value on every start, so PPQ's enclave releases never leave it
  with a stale pin.
- **What PPQ does:** operates the enclave and the servers around it — and can
  read none of what passes through. The enclave settles billing (token counts,
  cost) to PPQ's backend; the content never leaves the enclave except to the
  provider.

This is the weaker guarantee — "PayPerQ is blind," not "everyone is blind" —
and it is what makes Claude, GPT, Gemini and the rest usable without trusting
PPQ with your prompts. Threat model, known gaps, and how to verify it yourself:
[PayPerQ/ppq-enclave-proxy](https://github.com/PayPerQ/ppq-enclave-proxy).

### Side by side

| | Path 1 — `private/*` | Path 2 — everything else |
|---|---|---|
| Enclave | Tinfoil (AMD SEV-SNP) | PPQ Nitro enclave (AWS) |
| What runs inside | the model | PPQ's routing + provider keys |
| Sees your prompt | you, the enclave | you, the enclave, the model provider |
| PPQ sees | ciphertext | ciphertext |
| Verified against | Tinfoil's signed release | PPQ's published `PCR0` (public, reproducible build) |
| Models | the Tinfoil catalog below | anything on [ppq.ai/models](https://ppq.ai/models) |

**What neither path hides:** metadata. PPQ sees which account made a request,
when, for which model, and how many tokens it used — that is how billing works.
It cannot read the content on either path.

If verification of either enclave fails at startup, that path is disabled and
requests for its models get an error. Nothing is ever sent to an enclave that
did not prove what it is running.

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
