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
import type { SecureClient, VerificationDocument } from "tinfoil";
import {
  anthropicToOpenAI,
  openAIToAnthropicResponse,
  AnthropicStreamTranslator,
  newMessageId,
  type AnthropicRequest,
} from "./anthropic.js";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ProxyConfig {
  apiKey: string;
  port: number;
  apiBase: string;
  debug: boolean;
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
 * that isn't a real PPQ key falls back to the key the proxy was started with.
 */
function computeUpstreamAuth(req: http.IncomingMessage, config: ProxyConfig): string {
  const incomingAuth = req.headers["authorization"];
  const trimmedAuth = typeof incomingAuth === "string" ? incomingAuth.trim() : "";
  const forwardable = /^Bearer\s+sk-[A-Za-z0-9]{22}$/.test(trimmedAuth);
  return forwardable ? trimmedAuth : `Bearer ${config.apiKey}`;
}

// ─── Proxy server ────────────────────────────────────────────────────────────

export async function startProxy(config: ProxyConfig, logger: Logger): Promise<ProxyHandle> {
  const port = config.port || DEFAULT_PORT;
  const apiBase = config.apiBase || DEFAULT_API_BASE;

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
    upstreamAuth: string
  ): Promise<Response> {
    return encryptedFetch(`${apiBase}/private/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: upstreamAuth,
        "X-Private-Model": modelId,
        "x-query-source": "api",
      },
      body: JSON.stringify(openaiBody),
    });
  }

  const server = http.createServer(async (req, res) => {
    // CORS headers
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url || "/", `http://127.0.0.1:${port}`);

    // GET /health
    if (url.pathname === "/health" || url.pathname === "/") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", attestation: !!verification }));
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

        if (config.debug) {
          logger.debug?.(
            `→ [openai] ${resolved.modelId} (enclave: ${resolved.enclaveModelId}), stream: ${!!parsed.stream}`
          );
        }

        const response = await forwardEncrypted(
          parsed,
          resolved.modelId,
          computeUpstreamAuth(req, config)
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

        if (config.debug) {
          logger.debug?.(
            `→ [anthropic] ${resolved.modelId} (enclave: ${resolved.enclaveModelId}), stream: ${wantStream}`
          );
        }

        const response = await forwardEncrypted(
          openaiBody,
          resolved.modelId,
          computeUpstreamAuth(req, config)
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
    server.listen(port, "127.0.0.1", () => {
      logger.info(`PPQ Private Mode proxy listening on http://127.0.0.1:${port}`);
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

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // SSE events are separated by blank lines; process complete lines only.
      let nl: number;
      while ((nl = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;
        try {
          translator.pushChunk(JSON.parse(payload));
        } catch {
          // Skip malformed/partial JSON lines.
        }
      }
    }
  } finally {
    translator.finish();
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
