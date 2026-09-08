#!/usr/bin/env node
/**
 * Standalone entry point for the PPQ Private Mode proxy.
 *
 * Usage:
 *   PPQ_API_KEY=sk-xxx npx tsx bin/server.ts
 *
 * Environment variables:
 *   PPQ_API_KEY      (optional*) — Your PPQ.AI API key from https://ppq.ai/api-docs
 *   PPQ_DATA_DIR     (optional*) — Directory for persistent config; enables saving
 *                                  the API key from the status page in a browser
 *   PORT             (optional) — Proxy port, default 8787
 *   HOST             (optional) — Bind address, default 127.0.0.1 (use 0.0.0.0 in containers)
 *   PPQ_API_BASE     (optional) — API base URL, default https://api.ppq.ai
 *   DEBUG            (optional) — Set to "true" for verbose logging
 *   PPQ_ENCLAVE_URL  (optional) — override the Nitro enclave base URL (default: the published prod enclave)
 *   PPQ_ENCLAVE_PCR0 (optional) — override the pinned enclave PCR0 (default: the published value)
 *   PPQ_ALLOWED_ORIGINS (optional) — comma-separated browser origins allowed to call
 *                                  the proxy, e.g. "http://localhost:3000". Empty by
 *                                  default; local programs need no entry here.
 *   PPQ_ALLOWED_HOSTS   (optional) — comma-separated Host header values to accept.
 *                                  Set this when publishing the port on a network
 *                                  interface; it is what blocks DNS rebinding there.
 *
 *   *At least one of PPQ_API_KEY / PPQ_DATA_DIR is required.
 */

import { startProxy } from "../lib/proxy.js";

// The Tinfoil verifier and our EHBP client need the global WebCrypto, which only
// exists on Node 20+. On older Node the attestation fails DEEP inside the SDK
// with a misleading "AMD certificate chain verification failed" (the real cause
// is `ReferenceError: crypto is not defined`). Guard early with a clear message.
const nodeMajor = Number(process.versions.node.split(".")[0]);
if (Number.isFinite(nodeMajor) && nodeMajor < 20) {
  console.error(
    `Error: ppq-private-mode requires Node.js 20+ (you are running ${process.version}).`
  );
  console.error("Upgrade Node (e.g. `nvm install 20`) and re-run.");
  process.exit(1);
}

const apiKey = process.env.PPQ_API_KEY;
const dataDir = process.env.PPQ_DATA_DIR;
if (!apiKey && !dataDir) {
  console.error("Error: PPQ_API_KEY environment variable is required");
  console.error("Get your API key from https://ppq.ai/api-docs");
  console.error(
    "(Or set PPQ_DATA_DIR to a writable directory to configure the key from the status page.)"
  );
  process.exit(1);
}

const port = parseInt(process.env.PORT || "8787", 10);
const host = process.env.HOST || "127.0.0.1";
const apiBase = process.env.PPQ_API_BASE || "https://api.ppq.ai";
const debug = process.env.DEBUG === "true";
// PHASED / dormant: the Nitro enclave backend is used only when BOTH are set.
// Unset (default) => Tinfoil-only, exactly as before.
const enclaveUrl = process.env.PPQ_ENCLAVE_URL;
const enclavePcr0 = process.env.PPQ_ENCLAVE_PCR0;
// Opt-in only. Without this the proxy serves local programs and its own status
// page, which is what every documented client does (issue #28).
const allowedOrigins = (process.env.PPQ_ALLOWED_ORIGINS || "")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);
const allowedHosts = (process.env.PPQ_ALLOWED_HOSTS || "")
  .split(",")
  .map((h) => h.trim())
  .filter(Boolean);

const proxy = await startProxy(
  { apiKey, port, host, apiBase, debug, dataDir, enclaveUrl, enclavePcr0, allowedOrigins, allowedHosts },
  {
    info: (msg) => console.log(msg),
    error: (msg) => console.error(msg),
    debug: debug ? (msg) => console.log(`[debug] ${msg}`) : undefined,
  }
);

console.log("");
console.log("Send a test request (OpenAI format):");
console.log(`  curl http://127.0.0.1:${proxy.port}/v1/chat/completions \\`);
console.log(`    -H "Content-Type: application/json" \\`);
console.log(`    -d '{"model":"private/kimi-k3","messages":[{"role":"user","content":"Hello"}]}'`);
console.log("");
console.log("Use with Claude Code (Anthropic format, POST /v1/messages):");
console.log(`  export ANTHROPIC_BASE_URL="http://127.0.0.1:${proxy.port}"`);
console.log(`  export ANTHROPIC_AUTH_TOKEN="$PPQ_API_KEY"`);
console.log(`  export ANTHROPIC_MODEL="private/glm-5-2"`);
console.log(`  export ANTHROPIC_SMALL_FAST_MODEL="private/glm-5-2"`);
console.log(`  claude`);
console.log("  # glm-5-2 / gpt-oss-120b / llama3-3-70b / kimi-k3 support tool calls");
console.log("");

// Graceful shutdown
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, async () => {
    console.log("\nShutting down...");
    await proxy.close();
    process.exit(0);
  });
}
