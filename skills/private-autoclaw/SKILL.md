---
name: ppq-private-mode
description: Install PPQ.AI Private Mode for end-to-end encrypted AI inference in OpenClaw
user-invocable: true
---

# PPQ.AI Private Mode -- End-to-End Encrypted AI for OpenClaw

Your queries are encrypted on your machine and only decrypted inside a hardware-secured enclave. Neither PPQ.AI nor any intermediary can read the content.

## Setup Instructions

Follow these steps in order.

### Step 1: Get the user's PPQ API key

Ask the user for their PPQ.AI API key. They can find it at https://ppq.ai/api-docs -- it starts with `sk-`.

Do not proceed until the user provides their key.

### Step 2: Install the plugin

```bash
openclaw plugins install https://github.com/PayPerQ/ppq-private-mode-proxy
```

### Step 3: Configure OpenClaw

Merge the following into `~/.openclaw/openclaw.json`, preserving all existing settings:

Add a new provider entry under `models.providers`:

```json
"ppq-private": {
  "baseUrl": "http://127.0.0.1:8787/v1",
  "apiKey": "unused",
  "api": "openai-completions",
  "models": [
    { "id": "private/kimi-k2-5", "name": "private/kimi-k2-5" },
    { "id": "private/deepseek-r1-0528", "name": "private/deepseek-r1-0528" },
    { "id": "private/gpt-oss-120b", "name": "private/gpt-oss-120b" },
    { "id": "private/llama3-3-70b", "name": "private/llama3-3-70b" },
    { "id": "private/qwen3-vl-30b", "name": "private/qwen3-vl-30b" },
    { "id": "autoclaw/private", "name": "autoclaw/private" }
  ]
}
```

Add the plugin entry under `plugins.entries`:

```json
"ppq-private-mode": {
  "config": {
    "apiKey": "<the key the user provided>"
  }
}
```

### Step 4: Restart the gateway

```bash
systemctl --user restart openclaw-gateway.service
```

### Step 5: Confirm to the user

Tell the user PPQ Private Mode is installed. Available encrypted models:

- `private/kimi-k2-5` -- Fast general tasks
- `private/deepseek-r1-0528` -- Reasoning and analysis
- `private/gpt-oss-120b` -- Cost-efficient general use
- `private/llama3-3-70b` -- Open-source tasks
- `private/qwen3-vl-30b` -- Vision plus text
- `autoclaw/private` -- Auto-picks the best private model

Switch with: `openclaw models set autoclaw/private`

## About

PPQ.AI provides pay-per-query AI with no subscriptions. Private models run inside hardware secure enclaves. Learn more at https://ppq.ai
