# How to use PPQ's Private (TEE) AI models via our API and with OpenClaw

> Your queries are encrypted on your machine and only decrypted inside a hardware-secured enclave. Neither PPQ.AI nor any intermediary can read the content.

This guide walks you through setting up the PPQ private mode proxy. You can follow these steps from either a terminal or the OpenClaw chat interface.

> **Install via the OpenClaw Chat interface or Command line:** Some users report that they are able to install the plugin and update their config files by simply giving the OpenClaw chat interface these instructions. Others report issues. If you encounter problems in the chat, you may need to open a terminal connected to your OpenClaw instance and do it that way.

## What You'll Need

- An OpenClaw installation (already running)
- A PPQ.AI API key -- get one at https://ppq.ai/api-docs (it starts with `sk-`)

## Step 1: Install the Private Mode Plugin

Run this command to install the plugin:

```
openclaw plugins install https://github.com/PayPerQ/ppq-private-mode-proxy
```

This downloads a local encryption proxy that handles all the cryptography on your machine.

To verify it installed correctly:

```
ls ~/.openclaw/plugins/ppq-private-mode/
```

You should see files like `index.ts`, `package.json`, etc.

## Step 2: Add Your API Key and Models to OpenClaw Config

You need to edit your OpenClaw config file at `~/.openclaw/openclaw.json` and add two things: a provider pointing to the local proxy, and your API key.

If you already have a `models.providers` section, merge this in -- don't overwrite your existing providers.

**Add this provider** under `models.providers`:

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

**Add this plugin config** (replace `YOUR_API_KEY` with your actual PPQ API key):

```json
"plugins": {
  "entries": {
    "ppq-private-mode": {
      "config": {
        "apiKey": "YOUR_API_KEY"
      }
    }
  }
}
```

**Chat interface shortcut:** You can tell OpenClaw: *"Please add the ppq-private provider to my openclaw.json config. Here's the JSON to merge in:"* and paste the blocks above. The AI can edit config files for you.

## Step 3: Restart the Gateway

```
systemctl --user restart openclaw-gateway.service
```

This starts the local encryption proxy and connects it to your OpenClaw instance.

## Step 4: Switch to a Private Model

```
openclaw models set private/kimi-k2-5
```

That's it! Your queries are now end-to-end encrypted. You may need to start a new chat session for the model change to take effect.

## Available Private Models

| Model | Best For |
|-------|----------|
| `private/kimi-k2-5` | **Recommended.** Fast general tasks, 262K context window |
| `private/deepseek-r1-0528` | Reasoning and analysis |
| `private/gpt-oss-120b` | Budget-friendly general use |
| `private/llama3-3-70b` | Open-source tasks |
| `private/qwen3-vl-30b` | Vision + text, 262K context window |

Switch between them anytime with `openclaw models set <model-name>`.

## How It Works

The plugin runs a local proxy on your machine (port 8787) that:

1. **Verifies the enclave** -- performs hardware attestation to confirm it's talking to a genuine secure enclave, not an impersonator
2. **Encrypts your request** -- uses HPKE (RFC 9180) to encrypt the entire request body before it leaves your machine
3. **Sends the encrypted blob** -- PPQ.AI routes the encrypted data to the secure enclave. PPQ.AI only sees ciphertext.
4. **Enclave processes privately** -- the enclave decrypts your query, runs the AI model, and re-encrypts the response
5. **Your proxy decrypts** -- the response is decrypted locally on your machine

PPQ.AI handles billing via HTTP headers (your API key), so they never need to see the actual content of your queries.

## Using Private Mode Alongside Regular Models

Your existing OpenClaw models continue working normally. Standard models (like Claude, GPT, etc.) use their regular API routes, while private models route through the encrypted proxy. Both can coexist in your config, and you can switch between them anytime.

## Troubleshooting

**"Authentication error" or "Protocol error"**
Your API key may be wrong or your account balance is low. Check at https://ppq.ai

**"Attestation failed"**
The secure enclave may be temporarily unavailable. Wait a few minutes and restart:
```
systemctl --user restart openclaw-gateway.service
```

**Port conflict on 8787**
If something else is using port 8787, add a different port to your plugin config in `openclaw.json`:
```json
"ppq-private-mode": {
  "config": {
    "apiKey": "YOUR_API_KEY",
    "port": 8788
  }
}
```

**Plugin not found after install**
Make sure `~/.openclaw/plugins/ppq-private-mode/` exists. If not, re-run the install command from Step 1.

**Checking proxy status**
Use the `ppq_private_mode_status` tool in OpenClaw to verify the proxy is running and attestation succeeded.

## About

PPQ.AI provides pay-per-query AI inference with no subscriptions. Private models run inside secure enclaves with hardware-enforced memory encryption. Learn more at https://ppq.ai
