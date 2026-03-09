# PPQ Private Mode

End-to-end encrypted AI inference through PPQ.AI's private models running inside secure enclaves.

## What This Does

This plugin runs a local proxy on your machine that encrypts your AI queries before they leave your device. The encryption uses hardware-attested keys from a secure enclave — neither PPQ.AI, network intermediaries, nor anyone else can read your queries or responses.

## Setup

1. **Get a PPQ.AI API key** from https://ppq.ai/settings
2. **Install the plugin** in your OpenClaw plugins directory
3. **Run `npm install`** in the plugin directory
4. **Configure** your API key in OpenClaw settings under "PPQ Private Mode"

## Available Models

| Model ID | Description |
|---|---|
| `private/kimi-k2-5` | Kimi K2.5 — fast, 262K context |
| `private/deepseek-r1-0528` | DeepSeek R1 — reasoning model |
| `private/gpt-oss-120b` | GPT-OSS 120B — cost-efficient |
| `private/llama3-3-70b` | Llama 3.3 70B — open source |
| `private/qwen3-vl-30b` | Qwen3-VL 30B — vision + text |
| `autoclaw/private` | Smart routing across all private models |

## How It Works

1. On startup, the proxy performs **attestation** — cryptographically verifying the remote server is a genuine secure enclave running the expected code
2. For each request, the proxy **encrypts the body** using HPKE (RFC 9180) with the enclave's attested public key
3. The encrypted request is forwarded through PPQ.AI's backend (which cannot read it) to the secure enclave
4. The enclave **decrypts**, runs inference, and **encrypts the response**
5. The proxy **decrypts the response** and returns it as a standard OpenAI-format stream

## Troubleshooting

- **"Protocol error"**: Usually means an auth or balance issue. Check your PPQ API key and account balance at https://ppq.ai
- **Attestation failed**: The secure enclave may be temporarily unavailable. Try again in a few minutes.
- **Connection refused**: Make sure the proxy is running. Check the status with the `ppq_private_mode_status` tool.

## Verification

Use the `ppq_private_mode_status` MCP tool to check:
- Whether the proxy is running and healthy
- Attestation status (enclave fingerprint, code fingerprint)
- Available endpoints and models
