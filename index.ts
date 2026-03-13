/**
 * PPQ Private Mode — OpenClaw Plugin
 *
 * Registers a local proxy service that encrypts AI requests using EHBP
 * before forwarding to PPQ.AI's private inference endpoints. This ensures
 * end-to-end encryption: neither PPQ.AI nor any intermediary can read your queries.
 *
 * Install:
 *   1. Copy this plugin directory to your OpenClaw plugins folder
 *   2. Run `npm install` in the plugin directory
 *   3. Add your PPQ API key in OpenClaw settings
 *   4. Set model to any private model (e.g. private/kimi-k2-5)
 */

import { startProxy, type ProxyHandle, type ProxyConfig } from "./lib/proxy.js";

export const id = "ppq-private-mode";
export const name = "PPQ Private Mode";

interface PluginConfig {
  apiKey?: string;
  port?: number;
  apiBase?: string;
  debug?: boolean;
}

let proxy: ProxyHandle | null = null;

export default function register(api: any) {
  const pluginConfig: PluginConfig =
    api.config?.plugins?.entries?.["ppq-private-mode"]?.config || {};

  // ─── MCP Tool: check proxy status ───────────────────────────────────────────

  api.registerTool(
    {
      name: "ppq_private_mode_status",
      description:
        "Check status of the PPQ Private Mode proxy (attestation, health, endpoints)",
      parameters: { type: "object", properties: {} },
      async execute() {
        if (!pluginConfig.apiKey) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  status: "not_configured",
                  message:
                    "PPQ API key not configured. Set it in OpenClaw settings under PPQ Private Mode.",
                  setup: {
                    step1: "Get a PPQ.AI API key from https://ppq.ai/settings",
                    step2: 'Add your key to the plugin config: { "apiKey": "your-key" }',
                    step3: "Restart OpenClaw",
                  },
                }),
              },
            ],
          };
        }

        if (!proxy) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  status: "not_running",
                  message: "Private Mode proxy is not running. It may be starting up.",
                }),
              },
            ],
          };
        }

        // Health check
        try {
          const resp = await fetch(`http://127.0.0.1:${proxy.port}/health`);
          const health = await resp.json();

          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  status: "running",
                  healthy: resp.ok,
                  port: proxy.port,
                  baseUrl: `http://127.0.0.1:${proxy.port}`,
                  attestation: {
                    verified: !!proxy.verification,
                    enclaveHost: proxy.verification?.enclaveHost || null,
                    codeFingerprint: proxy.verification?.codeFingerprint || null,
                  },
                  endpoints: {
                    models: `http://127.0.0.1:${proxy.port}/v1/models`,
                    chat: `http://127.0.0.1:${proxy.port}/v1/chat/completions`,
                  },
                  availableModels: [
                    "private/kimi-k2-5",
                    "private/deepseek-r1-0528",
                    "private/gpt-oss-120b",
                    "private/llama3-3-70b",
                    "private/qwen3-vl-30b",
                  ],
                }),
              },
            ],
          };
        } catch {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  status: "unhealthy",
                  message: "Proxy is registered but health check failed.",
                }),
              },
            ],
          };
        }
      },
    },
    { optional: true }
  );

  // ─── Provider: expose private models to OpenClaw ────────────────────────────

  api.registerProvider({
    id: "ppq-private-mode",
    label: "PPQ Private Mode (End-to-End Encrypted)",
    docsPath: "./skills/private-mode",
    models: {
      baseUrl: `http://127.0.0.1:${pluginConfig.port || 8787}`,
      api: "openai-completions",
      models: [
        {
          id: "private/kimi-k2-5",
          name: "Kimi K2.5 (Private)",
          reasoning: false,
          input: ["text"],
          cost: { input: 2.48, output: 8.66, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 262144,
          maxTokens: 8192,
        },
        {
          id: "private/deepseek-r1-0528",
          name: "DeepSeek R1 (Private)",
          reasoning: true,
          input: ["text"],
          cost: { input: 2.48, output: 8.66, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 131072,
          maxTokens: 8192,
        },
        {
          id: "private/gpt-oss-120b",
          name: "GPT-OSS 120B (Private)",
          reasoning: false,
          input: ["text"],
          cost: { input: 1.24, output: 2.06, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 131072,
          maxTokens: 8192,
        },
        {
          id: "private/llama3-3-70b",
          name: "Llama 3.3 70B (Private)",
          reasoning: false,
          input: ["text"],
          cost: { input: 2.89, output: 4.54, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 131072,
          maxTokens: 8192,
        },
        {
          id: "private/qwen3-vl-30b",
          name: "Qwen3-VL 30B (Private)",
          reasoning: false,
          input: ["text", "image"],
          cost: { input: 2.06, output: 6.60, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 262144,
          maxTokens: 8192,
        },
      ],
    },
    auth: [
      {
        id: "api_key",
        label: "PPQ.AI API Key",
        hint: "Get your API key from https://ppq.ai/settings",
        kind: "api_key" as const,
        async run(ctx: any) {
          const key = await ctx.prompter.text({
            message: "Enter your PPQ.AI API key:",
            validate: (v: string) =>
              v.trim().length > 0 ? undefined : "API key is required",
          });
          if (typeof key === "symbol") throw new Error("Setup cancelled");
          return {
            profiles: [{ profileId: "default", credential: { apiKey: key } }],
            defaultModel: "private/kimi-k2-5",
          };
        },
      },
    ],
  });

  // ─── Service: manage proxy lifecycle ────────────────────────────────────────

  api.registerService({
    id: "ppq-private-mode-service",

    async start() {
      if (!pluginConfig.apiKey) {
        api.logger.warn(
          "PPQ Private Mode: no API key configured. Skipping proxy startup."
        );
        return;
      }

      const config: ProxyConfig = {
        apiKey: pluginConfig.apiKey,
        port: pluginConfig.port || 8787,
        apiBase: pluginConfig.apiBase || "https://api.ppq.ai",
        debug: pluginConfig.debug || false,
      };

      try {
        proxy = await startProxy(config, {
          info: (msg) => api.logger.info(`[private-mode] ${msg}`),
          error: (msg) => api.logger.error(`[private-mode] ${msg}`),
          debug: config.debug
            ? (msg) => api.logger.info(`[private-mode:debug] ${msg}`)
            : undefined,
        });
      } catch (err: any) {
        api.logger.error(`Failed to start Private Mode proxy: ${err.message}`);
      }
    },

    async stop() {
      if (proxy) {
        await proxy.close();
        proxy = null;
      }
    },
  });
}
