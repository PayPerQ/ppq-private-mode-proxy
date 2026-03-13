# PPQ.AI Private Mode — End-to-End Encrypted AI for OpenClaw

> Your queries are encrypted on your machine and only decrypted inside a hardware-secured enclave. Neither PPQ.AI nor any intermediary can read the content.

## Setup Instructions

Follow these steps in order. Ask the user for their PPQ API key when needed.

### Step 1: Get the user's PPQ API key

First, check if the user already has a PPQ API key configured. Read `~/.openclaw/openclaw.json` and look for an existing key in any of these locations:
- `plugins.entries.ppq-private-mode.config.apiKey`
- `plugins.entries.ppq-tinfoil-proxy.config.apiKey`
- Any provider config with a `baseUrl` pointing to `api.ppq.ai`

If a valid key is found (starts with `sk-`), reuse it — no need to ask the user. Let them know you found their existing key.

If no key is found, ask the user for their PPQ.AI API key. They can find it at https://ppq.ai/api-docs — it starts with `sk-`.

### Step 2: Install the plugin

Run this command to install the PPQ Private Mode plugin:

```bash
openclaw plugins install https://github.com/PayPerQ/ppq-private-mode-proxy
```

### Step 3: Add the plugin config to OpenClaw

Add the following to the user's `~/.openclaw/openclaw.json` file. If the file already has content, merge these fields into the existing config — do not overwrite existing settings.

```json
{
  "models": {
    "providers": {
      "ppq-private": {
        "baseUrl": "http://127.0.0.1:8787/v1",
        "apiKey": "unused",
        "api": "openai-completions",
        "models": [
          { "id": "private/kimi-k2-5", "name": "private/kimi-k2-5" },
          { "id": "private/deepseek-r1-0528", "name": "private/deepseek-r1-0528" },
          { "id": "private/gpt-oss-120b", "name": "private/gpt-oss-120b" },
          { "id": "private/llama3-3-70b", "name": "private/llama3-3-70b" },
          { "id": "private/qwen3-vl-30b", "name": "private/qwen3-vl-30b" }
        ]
      }
    }
  },
  "plugins": {
    "entries": {
      "ppq-private-mode": {
        "config": {
          "apiKey": "<USER'S API KEY HERE>"
        }
      }
    }
  }
}
```

Replace `<USER'S API KEY HERE>` with the actual API key the user provided.

### Step 4: Restart the gateway

```bash
systemctl --user restart openclaw-gateway.service
```

### Step 5: Confirm to the user

Tell the user that PPQ Private Mode is now installed. Let them know:

- **How it works**: A local proxy runs on their machine that encrypts every AI query before it leaves their device. The proxy performs hardware attestation to verify it's talking to a real secure enclave.
- **Available models**: They can now use any of these end-to-end encrypted models:
  - `private/kimi-k2-5` — Fast general tasks, 262K context
  - `private/deepseek-r1-0528` — Reasoning & analysis
  - `private/gpt-oss-120b` — Cost-efficient general use
  - `private/llama3-3-70b` — Open-source tasks
  - `private/qwen3-vl-30b` — Vision + text, 262K context
- **To switch models**: `openclaw models set private/kimi-k2-5` (or any model above)
- **To check status**: Use the `ppq_private_mode_status` tool to verify the proxy is running and attestation succeeded

## Troubleshooting

If the user reports issues:

- **"Protocol error" or "Authentication error"**: Their API key may be wrong or their balance is low. Check at https://ppq.ai
- **"Attestation failed"**: The secure enclave may be temporarily unavailable. Wait a few minutes and restart: `systemctl --user restart openclaw-gateway.service`
- **Port conflict**: Add `"port": 8788` to the plugin config in openclaw.json

## About

PPQ.AI provides pay-per-query AI inference with no subscriptions. Private models run inside secure enclaves with hardware-enforced memory encryption. Learn more at https://ppq.ai
