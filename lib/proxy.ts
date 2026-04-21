/**
 * PPQ Private Mode Proxy
 *
 * Runs a local OpenAI-compatible HTTP server that transparently encrypts
 * requests using EHBP (SecureClient) before forwarding them to PPQ.AI's
 * private inference endpoints. The proxy handles attestation, encryption,
 * and response decryption — your client sees a standard OpenAI API at localhost.
 *
 * Flow:
 *   Client → localhost:{port}/v1/chat/completions
 *          → proxy encrypts body via EHBP (SecureClient.fetch)
 *          → api.ppq.ai/private/v1/chat/completions
 *          → secure enclave decrypts, runs inference
 *          → encrypted response streams back
 *          → proxy decrypts → plaintext stream to client
 */

import http from "node:http";
import type { SecureClient, VerificationDocument } from "tinfoil";

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
  "private/kimi-k2-5": "kimi-k2-5",
  "private/kimi-k2-6": "kimi-k2-6",
  "private/deepseek-r1-0528": "deepseek-r1-0528",
  "private/gpt-oss-120b": "gpt-oss-120b",
  "private/llama3-3-70b": "llama3-3-70b",
  "private/qwen3-vl-30b": "qwen3-vl-30b",
  "private/glm-5-1": "glm-5-1",
  "private/gemma4-31b": "gemma4-31b",
};

/** All available private model IDs (user-facing) */
const PRIVATE_MODELS = Object.keys(PRIVATE_MODEL_MAP);

/** OpenAI-format model list response */
const MODEL_LIST_RESPONSE = {
  object: "list",
  data: [
    {
      id: "private/kimi-k2-5",
      object: "model",
      created: 0,
      owned_by: "ppq-private",
    },
    {
      id: "private/kimi-k2-6",
      object: "model",
      created: 0,
      owned_by: "ppq-private",
    },
    {
      id: "private/deepseek-r1-0528",
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
      id: "private/glm-5-1",
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

    // POST /v1/chat/completions
    if (url.pathname === "/v1/chat/completions" && req.method === "POST") {
      try {
        const body = await readBody(req);
        const parsed = JSON.parse(body);

        // Resolve model
        let modelId: string = parsed.model || "private/kimi-k2-5";

        // Ensure model is a valid private model
        if (!PRIVATE_MODEL_MAP[modelId]) {
          // Try adding private/ prefix
          const prefixed = `private/${modelId}`;
          if (PRIVATE_MODEL_MAP[prefixed]) {
            modelId = prefixed;
          } else {
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
        }

        // Map to enclave-internal model ID
        const enclaveModelId = PRIVATE_MODEL_MAP[modelId];
        parsed.model = enclaveModelId;

        if (config.debug) {
          logger.debug?.(`→ ${modelId} (enclave: ${enclaveModelId}), stream: ${!!parsed.stream}`);
        }

        // Forward via SecureClient (EHBP-encrypted)
        const endpoint = `${apiBase}/private/v1/chat/completions`;
        const response = await encryptedFetch(endpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${config.apiKey}`,
            "X-Private-Model": modelId,
            "x-query-source": "api",
          },
          body: JSON.stringify(parsed),
        });

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
        if (response.body) {
          const reader = response.body.getReader();
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              res.write(value);
            }
          } catch (err: any) {
            if (config.debug) {
              logger.error(`Stream error: ${err.message}`);
            }
          } finally {
            res.end();
          }
        } else {
          const text = await response.text();
          res.end(text);
        }
      } catch (err: any) {
        // Handle non-encrypted error responses (auth/balance errors from proxy)
        if (err?.name === "ProtocolError") {
          logger.error(`Protocol error (likely auth/balance issue): ${err.message}`);
          res.writeHead(401, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              error: {
                message: "Authentication or balance error. Check your PPQ API key and account balance.",
                type: "authentication_error",
              },
            })
          );
          return;
        }

        logger.error(`Request error: ${err.message}`);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            error: {
              message: err.message || "Internal proxy error",
              type: "proxy_error",
            },
          })
        );
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
      logger.info(`Endpoints: GET /v1/models, POST /v1/chat/completions`);
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
