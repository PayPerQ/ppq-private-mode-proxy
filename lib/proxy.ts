/**
 * PPQ Private Mode Proxy
 *
 * Runs a local HTTP server that transparently encrypts requests using EHBP
 * (SecureClient) before forwarding them to PPQ.AI's private inference
 * endpoints. The proxy handles attestation, encryption, and response
 * decryption.
 *
 * It exposes two dialects, both backed by the same encrypted upstream:
 *   • OpenAI    — POST /v1/chat/completions  (any OpenAI-compatible client)
 *   • Anthropic — POST /v1/messages          (Claude Code & the Anthropic SDK)
 *
 * Flow:
 *   Client → localhost:{port}/v1/chat/completions | /v1/messages
 *          → (Anthropic requests are translated to OpenAI format)
 *          → proxy encrypts body via EHBP (SecureClient.fetch)
 *          → api.ppq.ai/private/v1/chat/completions
 *          → secure enclave decrypts, runs inference
 *          → encrypted response streams back
 *          → proxy decrypts (→ translates back to Anthropic when needed)
 *          → plaintext stream to client
 */

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import type { SecureClient, VerificationDocument } from "tinfoil";
import {
  anthropicToOpenAI,
  openAIToAnthropicResponse,
  AnthropicStreamTranslator,
  newMessageId,
  type AnthropicRequest,
} from "./anthropic.js";
import { renderStatusPage } from "./statusPage.js";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ProxyConfig {
  /**
   * Default PPQ.AI API key requests are billed to. Optional when `dataDir` is
   * set — the key can then be provided via the setup form on the status page
   * and is persisted to `<dataDir>/config.json`.
   */
  apiKey?: string;
  port: number;
  apiBase: string;
  debug: boolean;
  /** Bind address. Defaults to 127.0.0.1; set to 0.0.0.0 when running in a container. */
  host?: string;
  /**
   * Directory for persistent proxy config. When set, the status page offers a
   * setup form that saves the API key to `<dataDir>/config.json`, and a key
   * stored there is loaded at startup (an explicit `apiKey` takes precedence).
   */
  dataDir?: string;
}

export interface ProxyHandle {
  port: number;
  server: http.Server;
  verification: VerificationDocument | null;
  close: () => Promise<void>;
}

export interface Logger {
  info: (msg: string) => void;
  error: (msg: string) => void;
  debug?: (msg: string) => void;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const DEFAULT_PORT = 8787;
const DEFAULT_API_BASE = "https://api.ppq.ai";
const HEALTH_TIMEOUT_MS = 15_000;

const NO_KEY_MESSAGE =
  "No PPQ.AI API key configured. Save one on the proxy's status page, set the " +
  "PPQ_API_KEY environment variable, or pass a key as an Authorization: Bearer header.";

/** Maps user-facing model IDs to enclave-internal model IDs */
const PRIVATE_MODEL_MAP: Record<string, string> = {
  "private/kimi-k2-6": "kimi-k2-6",
  "private/gpt-oss-120b": "gpt-oss-120b",
  "private/llama3-3-70b": "llama3-3-70b",
  "private/qwen3-vl-30b": "qwen3-vl-30b",
  "private/glm-5-2": "glm-5-2",
  "private/gemma4-31b": "gemma4-31b",
};

/** All available private model IDs (user-facing) */
const PRIVATE_MODELS = Object.keys(PRIVATE_MODEL_MAP);

/** OpenAI-format model list response */
const MODEL_LIST_RESPONSE = {
  object: "list",
  data: [
    {
      id: "private/kimi-k2-6",
      object: "model",
      created: 0,
      owned_by: "ppq-private",
    },
    {
      id: "private/gpt-oss-120b",
      object: "model",
      created: 0,
      owned_by: "ppq-private",
    },
    {
      id: "private/llama3-3-70b",
      object: "model",
      created: 0,
      owned_by: "ppq-private",
    },
    {
      id: "private/qwen3-vl-30b",
      object: "model",
      created: 0,
      owned_by: "ppq-private",
    },
    {
      id: "private/glm-5-2",
      object: "model",
      created: 0,
      owned_by: "ppq-private",
    },
    {
      id: "private/gemma4-31b",
      object: "model",
      created: 0,
      owned_by: "ppq-private",
    },
  ],
};

// ─── Request helpers (shared by both dialects) ───────────────────────────────

interface ResolvedModel {
  /** User-facing id, e.g. "private/kimi-k2-6" — sent upstream as X-Private-Model. */
  modelId: string;
  /** Enclave-internal id, e.g. "kimi-k2-6" — placed in the request body. */
  enclaveModelId: string;
}

/**
 * Resolve an incoming model name to a valid private model, tolerating a missing
 * "private/" prefix. Returns null when the model is not a known private model.
 */
function resolveModel(rawModel: unknown): ResolvedModel | null {
  let modelId = typeof rawModel === "string" && rawModel ? rawModel : "private/kimi-k2-6";
  if (!PRIVATE_MODEL_MAP[modelId]) {
    const prefixed = `private/${modelId}`;
    if (PRIVATE_MODEL_MAP[prefixed]) {
      modelId = prefixed;
    } else {
      return null;
    }
  }
  return { modelId, enclaveModelId: PRIVATE_MODEL_MAP[modelId] };
}

/**
 * Decide which Authorization header to send upstream. A caller-supplied header
 * is forwarded ONLY when it has the exact PPQ key shape ("sk-" + 22 [A-Za-z0-9]).
 * Agent clients routinely send their own placeholder Authorization header to a
 * local endpoint — both obvious ones ("Bearer none", "ollama") and sk-prefixed
 * ones ("Bearer sk-no-key-required"). Forwarding any of those upstream overrode
 * PPQ_API_KEY and produced a plaintext 401, which the EHBP client surfaced as
 * the misleading "missing ehbp-response-nonce header" ProtocolError. Anything
 * that isn't a real PPQ key falls back to the proxy's configured key; null when
 * no key is available at all (the caller must answer 401).
 */
function computeUpstreamAuth(
  req: http.IncomingMessage,
  configuredKey: string | undefined
): string | null {
  const incomingAuth = req.headers["authorization"];
  const trimmedAuth = typeof incomingAuth === "string" ? incomingAuth.trim() : "";
  const forwardable = /^Bearer\s+sk-[A-Za-z0-9]{22}$/.test(trimmedAuth);
  if (forwardable) return trimmedAuth;
  return configuredKey ? `Bearer ${configuredKey}` : null;
}

// ─── Persistent key store ────────────────────────────────────────────────────

/** Shape check for keys accepted by the setup endpoint (tolerant on length). */
const KEY_SHAPE = /^sk-[A-Za-z0-9]{16,64}$/;

/**
 * Holds the proxy's default API key. When a data directory is configured the
 * key survives restarts in `<dataDir>/config.json`; setting a new key takes
 * effect immediately without a restart.
 */
class KeyStore {
  private key: string | undefined;
  private readonly configFile: string | null;

  constructor(explicitKey: string | undefined, dataDir: string | undefined, logger: Logger) {
    this.configFile = dataDir ? path.join(dataDir, "config.json") : null;
    this.key = explicitKey;
    if (!this.key && this.configFile) {
      try {
        const raw = JSON.parse(fs.readFileSync(this.configFile, "utf-8"));
        if (typeof raw?.apiKey === "string" && raw.apiKey) {
          this.key = raw.apiKey;
          logger.info(`Loaded API key from ${this.configFile}`);
        }
      } catch {
        // Missing or unreadable config — start unconfigured.
      }
    }
  }

  get(): string | undefined {
    return this.key;
  }

  get persistent(): boolean {
    return this.configFile !== null;
  }

  /** Validate, persist (when possible), and activate a new key. */
  set(apiKey: string): void {
    if (!KEY_SHAPE.test(apiKey)) {
      throw new Error("That doesn't look like a PPQ.AI API key (expected sk-…).");
    }
    if (this.configFile) {
      fs.mkdirSync(path.dirname(this.configFile), { recursive: true });
      fs.writeFileSync(this.configFile, JSON.stringify({ apiKey }, null, 2) + "\n", {
        mode: 0o600,
      });
    }
    this.key = apiKey;
  }
}

/**
 * Extract a creator-payout tool id (e.g. "stt:ppq-voice") from the incoming
 * `X-Tool-Id` header so PPQ can pay the registered tool creator for the
 * request. The request body is encrypted before it reaches PPQ, so this is
 * forwarded as a cleartext metadata header alongside X-Private-Model. Only a
 * single conservatively-shaped value is forwarded; anything else is dropped.
 */
function computeToolId(req: http.IncomingMessage): string | null {
  const incoming = req.headers["x-tool-id"];
  return typeof incoming === "string" && /^[\w:.-]{1,64}$/.test(incoming) ? incoming : null;
}

// ─── Proxy server ────────────────────────────────────────────────────────────

export async function startProxy(config: ProxyConfig, logger: Logger): Promise<ProxyHandle> {
  const port = config.port || DEFAULT_PORT;
  const apiBase = config.apiBase || DEFAULT_API_BASE;
  const host = config.host || "127.0.0.1";
  const keyStore = new KeyStore(config.apiKey, config.dataDir, logger);

  // Dynamic import to avoid loading at module level
  const { SecureClient: SC } = await import("tinfoil");

  logger.info("Initializing encrypted connection to secure enclave...");

  const client = new SC({
    baseURL: `${apiBase}/private/`,
    attestationBundleURL: `${apiBase}/private`,
    transport: "ehbp",
  });

  // Perform attestation — verifies enclave code fingerprint
  await client.ready();

  let verification: VerificationDocument | null = null;
  try {
    verification = client.getVerificationDocument();
    logger.info(
      `Attestation verified — enclave: ${verification?.enclaveHost || "unknown"}, ` +
        `code fingerprint: ${verification?.codeFingerprint?.slice(0, 16) || "unknown"}...`
    );
  } catch {
    logger.info("Attestation completed (verification document unavailable)");
  }

  const encryptedFetch = client.fetch;

  /** Forward an OpenAI-format body to the enclave over the EHBP-encrypted channel. */
  function forwardEncrypted(
    openaiBody: Record<string, unknown>,
    modelId: string,
    upstreamAuth: string,
    toolId: string | null = null
  ): Promise<Response> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Authorization: upstreamAuth,
      "X-Private-Model": modelId,
      "x-query-source": "api",
    };
    if (toolId) {
      headers["X-Tool-Id"] = toolId;
    }
    return encryptedFetch(`${apiBase}/private/v1/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify(openaiBody),
    });
  }

  const server = http.createServer(async (req, res) => {
    // CORS headers
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader(
      "Access-Control-Allow-Headers",
      "Content-Type, Authorization, X-Tool-Id"
    );

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url || "/", `http://127.0.0.1:${port}`);

    // GET / — human-facing status & setup page
    if (url.pathname === "/" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(
        renderStatusPage({
          attested: !!verification,
          enclaveHost: verification?.enclaveHost,
          codeFingerprint: verification?.codeFingerprint,
          keyConfigured: !!keyStore.get(),
          setupEnabled: keyStore.persistent,
          models: PRIVATE_MODELS,
        })
      );
      return;
    }

    // GET /health
    if (url.pathname === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          status: "ok",
          attestation: !!verification,
          apiKeyConfigured: !!keyStore.get(),
        })
      );
      return;
    }

    // POST /setup/api-key — save the default key (only with persistent config)
    if (url.pathname === "/setup/api-key" && req.method === "POST") {
      if (!keyStore.persistent) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            error: {
              message:
                "Setup is disabled: the proxy was started without a data directory (PPQ_DATA_DIR).",
              type: "invalid_request_error",
            },
          })
        );
        return;
      }
      try {
        const body = JSON.parse(await readBody(req));
        keyStore.set(typeof body?.apiKey === "string" ? body.apiKey.trim() : "");
        logger.info("API key saved via setup page");
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      } catch (err: any) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            error: { message: err?.message || "Invalid request", type: "invalid_request_error" },
          })
        );
      }
      return;
    }

    // GET /v1/models
    if (url.pathname === "/v1/models" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(MODEL_LIST_RESPONSE));
      return;
    }

    // POST /v1/chat/completions  (OpenAI dialect)
    if (url.pathname === "/v1/chat/completions" && req.method === "POST") {
      try {
        const body = await readBody(req);
        const parsed = JSON.parse(body);

        const resolved = resolveModel(parsed.model);
        if (!resolved) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              error: {
                message: `Unknown model: ${parsed.model}. Available: ${PRIVATE_MODELS.join(", ")}`,
                type: "invalid_request_error",
              },
            })
          );
          return;
        }

        // Map to enclave-internal model ID
        parsed.model = resolved.enclaveModelId;

        const upstreamAuth = computeUpstreamAuth(req, keyStore.get());
        if (!upstreamAuth) {
          res.writeHead(401, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              error: {
                message: NO_KEY_MESSAGE,
                type: "authentication_error",
              },
            })
          );
          return;
        }

        if (config.debug) {
          logger.debug?.(
            `→ [openai] ${resolved.modelId} (enclave: ${resolved.enclaveModelId}), stream: ${!!parsed.stream}`
          );
        }

        const response = await forwardEncrypted(
          parsed,
          resolved.modelId,
          upstreamAuth,
          computeToolId(req)
        );

        // Forward status and headers
        const responseHeaders: Record<string, string> = {
          "Content-Type": response.headers.get("content-type") || "application/json",
          "Access-Control-Allow-Origin": "*",
        };

        if (parsed.stream) {
          responseHeaders["Cache-Control"] = "no-cache";
          responseHeaders["Connection"] = "keep-alive";
        }

        res.writeHead(response.status, responseHeaders);

        // Stream the (decrypted) response body
        await pipeResponse(response, res, config, logger);
      } catch (err: any) {
        sendUpstreamError(err, res, logger, "openai");
      }
      return;
    }

    // POST /v1/messages  (Anthropic dialect — Claude Code & the Anthropic SDK)
    if (url.pathname === "/v1/messages" && req.method === "POST") {
      try {
        const body = await readBody(req);
        const anthropicReq = JSON.parse(body) as AnthropicRequest;

        const resolved = resolveModel(anthropicReq.model);
        if (!resolved) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              type: "error",
              error: {
                type: "invalid_request_error",
                message: `Unknown model: ${anthropicReq.model}. Available: ${PRIVATE_MODELS.join(", ")}`,
              },
            })
          );
          return;
        }

        const wantStream = !!anthropicReq.stream;
        const openaiBody = anthropicToOpenAI(anthropicReq);
        openaiBody.model = resolved.enclaveModelId;

        const upstreamAuth = computeUpstreamAuth(req, keyStore.get());
        if (!upstreamAuth) {
          res.writeHead(401, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              type: "error",
              error: { type: "authentication_error", message: NO_KEY_MESSAGE },
            })
          );
          return;
        }

        if (config.debug) {
          logger.debug?.(
            `→ [anthropic] ${resolved.modelId} (enclave: ${resolved.enclaveModelId}), stream: ${wantStream}`
          );
        }

        const response = await forwardEncrypted(
          openaiBody,
          resolved.modelId,
          upstreamAuth,
          computeToolId(req)
        );

        const messageId = newMessageId();

        // Upstream errors arrive as non-streamed JSON regardless of `stream`.
        if (!response.ok) {
          const errText = await response.text();
          res.writeHead(response.status, { "Content-Type": "application/json" });
          res.end(toAnthropicError(errText, response.status));
          return;
        }

        if (wantStream) {
          res.writeHead(response.status, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
            "Access-Control-Allow-Origin": "*",
          });
          await streamAnthropic(response, res, resolved.modelId, messageId);
        } else {
          const text = await response.text();
          const oai = JSON.parse(text);
          const anthropicResp = openAIToAnthropicResponse(oai, resolved.modelId, messageId);
          res.writeHead(response.status, {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
          });
          res.end(JSON.stringify(anthropicResp));
        }
      } catch (err: any) {
        sendUpstreamError(err, res, logger, "anthropic");
      }
      return;
    }

    // 404 for everything else
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        error: {
          message: `Unknown endpoint: ${req.method} ${url.pathname}`,
          type: "invalid_request_error",
        },
      })
    );
  });

  // Start listening
  await new Promise<void>((resolve, reject) => {
    server.on("error", reject);
    server.listen(port, host, () => {
      logger.info(`PPQ Private Mode proxy listening on http://${host}:${port}`);
      logger.info(
        `Endpoints: GET /v1/models, POST /v1/chat/completions (OpenAI), POST /v1/messages (Anthropic)`
      );
      resolve();
    });
  });

  return {
    port,
    server,
    verification,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

/** Stream a (decrypted) upstream response body straight through to the client. */
async function pipeResponse(
  response: Response,
  res: http.ServerResponse,
  config: ProxyConfig,
  logger: Logger
): Promise<void> {
  if (!response.body) {
    res.end(await response.text());
    return;
  }
  const reader = response.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(value);
    }
  } catch (err: any) {
    if (config.debug) logger.error(`Stream error: ${err.message}`);
  } finally {
    res.end();
  }
}

/** Write a single Server-Sent Event (`event:` + `data:` lines) to the client. */
function writeSSE(res: http.ServerResponse, event: string, data: unknown): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

/**
 * Read an OpenAI SSE stream and emit the translated Anthropic event sequence.
 * Tolerates chunk boundaries splitting individual SSE lines.
 */
async function streamAnthropic(
  response: Response,
  res: http.ServerResponse,
  model: string,
  messageId: string
): Promise<void> {
  const translator = new AnthropicStreamTranslator(
    (event, data) => writeSSE(res, event, data),
    model,
    messageId
  );

  if (!response.body) {
    translator.finish();
    res.end();
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let done = false;

  try {
    while (!done) {
      const { done: streamDone, value } = await reader.read();
      if (streamDone) break;
      buffer += decoder.decode(value, { stream: true });

      // OpenAI emits one JSON object per `data:` line; process complete lines.
      let nl: number;
      while ((nl = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (!payload) continue;
        if (payload === "[DONE]") {
          // Stop on the sentinel rather than waiting for the socket to close,
          // so the client isn't left hanging for message_stop.
          done = true;
          break;
        }
        try {
          translator.pushChunk(JSON.parse(payload));
        } catch {
          // Skip malformed/partial JSON lines.
        }
      }
    }
    translator.finish();
  } catch (err: any) {
    // A mid-stream failure must surface as an Anthropic `error` event, not a
    // clean message_stop — otherwise a broken turn looks like a completed one.
    translator.error(err?.message || "Upstream stream error");
  } finally {
    res.end();
  }
}

/** Wrap an upstream error body in the Anthropic top-level error envelope. */
function toAnthropicError(rawBody: string, status: number): string {
  let message = rawBody;
  try {
    const parsed = JSON.parse(rawBody);
    message = parsed?.error?.message ?? parsed?.message ?? rawBody;
  } catch {
    // Non-JSON body — use as-is.
  }
  const type =
    status === 401 || status === 403 ? "authentication_error" : "api_error";
  return JSON.stringify({ type: "error", error: { type, message } });
}

/** Send an exception as a dialect-appropriate error response (headers not yet sent). */
function sendUpstreamError(
  err: any,
  res: http.ServerResponse,
  logger: Logger,
  dialect: "openai" | "anthropic"
): void {
  // Headers may already be flushed mid-stream; nothing more we can send.
  if (res.headersSent) {
    logger.error(`Error after response started: ${err?.message}`);
    res.end();
    return;
  }

  const isProtocol = err?.name === "ProtocolError";
  if (isProtocol) {
    logger.error(`Protocol error (likely auth/balance issue): ${err.message}`);
  } else {
    logger.error(`Request error: ${err?.message}`);
  }

  const status = isProtocol ? 401 : 500;
  const message = isProtocol
    ? "Authentication or balance error. Check your PPQ API key and account balance."
    : err?.message || "Internal proxy error";

  res.writeHead(status, { "Content-Type": "application/json" });
  if (dialect === "anthropic") {
    const type = isProtocol ? "authentication_error" : "api_error";
    res.end(JSON.stringify({ type: "error", error: { type, message } }));
  } else {
    const type = isProtocol ? "authentication_error" : "proxy_error";
    res.end(JSON.stringify({ error: { message, type } }));
  }
}
