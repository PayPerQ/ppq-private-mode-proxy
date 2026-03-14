# The ppq-private-mode-proxy repo allows you to use PPQ's Private (TEE) AI models via our API and with OpenClaw

The trick in using private models is that you need to encrypt the content of your request before sending them onto PPQ and its AI provider. With our proxy repo, you encrypt the queries on your machine before they leave -- neither PPQ.AI nor anyone else can read them.

The repo supports both standalone use cases with your own custom code as well as usage inside of openclaw.

# OpenClaw usage

For openclaw usage, simply paste in this command to your openclaw chat interface:

"Please install this skill to enable private models via PPQ: https://github.com/PayPerQ/ppq-private-mode-proxy/blob/main/skills/private-mode/SKILL.md

In some cases, openclaw's safety guardrails block installation via direct links. In that case, try to paste in the text of the skill file. If issues still persist, create an issue in this repo here to help the community troubleshoot.

# Standalone usage

You can run the proxy directly without OpenClaw and point any OpenAI-compatible client at it.

**Prerequisites:** Node.js 18+ and a PPQ.AI API key from [ppq.ai/api-docs](https://ppq.ai/api-docs).

**Start the proxy:**

```bash
PPQ_API_KEY=sk-your-key npx ppq-private-mode
```

The proxy starts on port 8787 and prints a ready message once attestation succeeds.

**Send a request** (standard OpenAI chat completions format):

```bash
curl http://127.0.0.1:8787/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"private/kimi-k2-5","messages":[{"role":"user","content":"Hello"}]}'
```

**Or point any OpenAI SDK at it:**

```js
import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "http://127.0.0.1:8787/v1",
  apiKey: "unused",
});

const response = await client.chat.completions.create({
  model: "private/kimi-k2-5",
  messages: [{ role: "user", content: "Hello" }],
});
```

**Environment variables:**

| Variable | Required | Default | Description |
|---|---|---|---|
| `PPQ_API_KEY` | Yes | — | Your PPQ.AI API key |
| `PORT` | No | `8787` | Local proxy port |
| `PPQ_API_BASE` | No | `https://api.ppq.ai` | PPQ API base URL |
| `DEBUG` | No | `false` | Set to `true` for verbose logging |

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
