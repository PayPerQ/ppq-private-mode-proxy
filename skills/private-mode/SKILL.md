---
name: ppq-private-mode
description: Configure PPQ.AI Private Mode encrypted models in OpenClaw
user-invocable: true
---

# PPQ.AI Private Mode -- Configure Encrypted Models

This skill configures OpenClaw to use PPQ.AI's end-to-end encrypted models. The PPQ Private Mode plugin must already be installed before running this skill.

## Prerequisites

The user must have already installed the PPQ Private Mode plugin. If it is not installed, tell the user to run this command themselves:

    openclaw plugins install https://github.com/PayPerQ/ppq-private-mode-proxy

Then ask the user to come back and run this skill again after installing.

## Configuration Steps

### Step 1: Verify the plugin is installed

Check that the plugin exists:

```bash
ls ~/.openclaw/plugins/ppq-private-mode/
```

If the directory does not exist, stop and tell the user they need to install the plugin first (see Prerequisites above). Do not continue.

### Step 2: Get the user's PPQ API key

Ask the user for their PPQ.AI API key. They can find it at https://ppq.ai/api-docs -- it starts with `sk-`.

Do not proceed until the user provides their key.

### Step 3: Add the provider to OpenClaw config

Merge the following into `~/.openclaw/openclaw.json`, preserving all existing settings.

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
    { "id": "private/qwen3-vl-30b", "name": "private/qwen3-vl-30b" }
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

Tell the user PPQ Private Mode is configured. Available encrypted models:

- `private/kimi-k2-5` -- Fast general tasks
- `private/deepseek-r1-0528` -- Reasoning and analysis
- `private/gpt-oss-120b` -- Cost-efficient general use
- `private/llama3-3-70b` -- Open-source tasks
- `private/qwen3-vl-30b` -- Vision plus text

Switch with: `openclaw models set private/kimi-k2-5`

## About

PPQ.AI provides pay-per-query AI with no subscriptions. Private models run inside hardware secure enclaves. Learn more at https://ppq.ai
