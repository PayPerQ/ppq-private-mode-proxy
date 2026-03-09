# PPQ Private Mode Proxy

End-to-end encrypted AI proxy for PPQ.AI's private models. Your queries are encrypted on your machine and only decrypted inside a hardware-secured enclave — neither PPQ.AI nor any intermediary can read them.

Works **standalone** (any app, any language) or as an **OpenClaw plugin**.

## Quick Start (Standalone)

```bash
git clone https://github.com/PayPerQ/ppq-private-mode-proxy.git
cd ppq-private-mode-proxy
npm install
PPQ_API_KEY=sk-your-key npm start
```

The proxy starts on `http://127.0.0.1:8787` and exposes an OpenAI-compatible API.

### Send a request

```bash
curl http://127.0.0.1:8787/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "private/kimi-k2-5",
    "messages": [{"role": "user", "content": "Hello!"}]
  }'
```

### Use with any OpenAI-compatible client

```python
from openai import OpenAI

client = OpenAI(base_url="http://127.0.0.1:8787/v1", api_key="unused")
response = client.chat.completions.create(
    model="private/kimi-k2-5",
    messages=[{"role": "user", "content": "Hello!"}]
)
print(response.choices[0].message.content)
```

## Available Models

| Model | Best For |
|-------|----------|
| `private/kimi-k2-5` | Fast general tasks, 262K context |
| `private/deepseek-r1-0528` | Reasoning & analysis |
| `private/gpt-oss-120b` | Cost-efficient general use |
| `private/llama3-3-70b` | Open-source tasks |
| `private/qwen3-vl-30b` | Vision + text, 262K context |
| `autoclaw/private` | Smart routing — auto-picks the best model |

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `PPQ_API_KEY` | Yes | — | Your PPQ.AI API key from [ppq.ai/api-docs](https://ppq.ai/api-docs) |
| `PORT` | No | `8787` | Local proxy port |
| `PPQ_API_BASE` | No | `https://api.ppq.ai` | PPQ API base URL |
| `DEBUG` | No | `false` | Set to `true` for verbose logging |

## OpenClaw Plugin Usage

See [SKILL.md](./skills/private-autoclaw/SKILL.md) for OpenClaw-specific setup, or read the [blog post](https://ppq.ai/blog/using-tee-models-with-openclaw).

## How It Works

1. On startup, the proxy performs **hardware attestation** — verifying the remote server is a genuine secure enclave
2. For each request, it **encrypts the body** using HPKE (RFC 9180) with the enclave's attested public key
3. The encrypted request passes through PPQ.AI (which cannot read it) to the secure enclave
4. The enclave decrypts, runs inference, encrypts the response
5. The proxy decrypts and streams the response back to you

## Troubleshooting

- **"Protocol error"**: Usually an auth or balance issue. Check your API key and balance at [ppq.ai](https://ppq.ai)
- **Attestation failed**: The secure enclave may be temporarily unavailable. Try again in a few minutes.
- **Port conflict**: Set `PORT=8788` (or any free port)

## License

MIT
