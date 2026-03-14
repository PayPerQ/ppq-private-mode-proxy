---
name: ppq-private-mode
description: Configure PPQ.AI Private Mode encrypted models in OpenClaw
user-invocable: true
---

# PPQ.AI Private Mode -- Configure Encrypted Models

This skill installs and configures OpenClaw to use PPQ.AI's end-to-end encrypted models.

## Step 1: Install the plugin

Run this command to install the PPQ Private Mode plugin:

```bash
openclaw plugins install ppq-private-mode
```

## Step 2: Verify the plugin is installed

Check that the plugin exists:

```bash
ls ~/.openclaw/extensions/ppq-private-mode/
```

If the directory does not exist, the install may have failed. Try running the install command again.

## Step 3: Get the user's PPQ API key

First, check if the user already has a PPQ API key configured. Read `~/.openclaw/openclaw.json` and look for an existing key in any of these locations:
- `plugins.entries.ppq-private-mode.config.apiKey`
- Any provider config with a `baseUrl` pointing to `api.ppq.ai`

If a valid key is found (starts with `sk-`), reuse it -- no need to ask the user. Let them know you found their existing key.

If no key is found, ask the user for their PPQ.AI API key. They can find it at https://ppq.ai/api-docs -- it starts with `sk-`.

Do not proceed until you have a key.

## Step 4: Add BOTH the provider AND the plugin config to OpenClaw

IMPORTANT: You must add BOTH sections below to `~/.openclaw/openclaw.json`. Do not skip either one. Merge them into the existing config, preserving all existing settings.

Here is the complete config to merge (replace `USER_API_KEY` with the actual key):

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
          "apiKey": "USER_API_KEY"
        }
      }
    }
  }
}
```

After merging, verify that `~/.openclaw/openclaw.json` contains BOTH:
1. A `ppq-private` entry under `models.providers` with the 5 private models listed
2. A `ppq-private-mode` entry under `plugins.entries` with the user's API key

If either is missing, the private models will not work.

## Step 5: Restart the gateway

```bash
systemctl --user restart openclaw-gateway.service
```

## Step 6: Confirm to the user

Tell the user PPQ Private Mode is configured. Available encrypted models:

- `private/kimi-k2-5` -- Fast general tasks, 262K context
- `private/deepseek-r1-0528` -- Reasoning and analysis
- `private/gpt-oss-120b` -- Cost-efficient general use
- `private/llama3-3-70b` -- Open-source tasks
- `private/qwen3-vl-30b` -- Vision plus text, 262K context

Switch with: `openclaw models set private/kimi-k2-5`

## Troubleshooting

- **"Authentication error"**: Check API key and account balance at https://ppq.ai
- **"Attestation failed"**: Enclave may be temporarily unavailable. Wait and restart: `systemctl --user restart openclaw-gateway.service`
- **"Model not allowed"**: The `ppq-private` provider is missing from `models.providers` in openclaw.json. Add it using the config block above.
- **Port conflict on 8787**: Add `"port": 8788` to the plugin config in openclaw.json

## About

PPQ.AI provides pay-per-query AI with no subscriptions. Private models run inside hardware secure enclaves. Learn more at https://ppq.ai
