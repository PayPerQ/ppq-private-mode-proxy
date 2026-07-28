#!/usr/bin/env node
/**
 * Standalone entry point for the PPQ Private Mode proxy.
 *
 * Usage:
 *   PPQ_API_KEY=sk-xxx npx tsx bin/server.ts
 *
 * Environment variables:
 *   PPQ_API_KEY   (optional*) — Your PPQ.AI API key from https://ppq.ai/api-docs
 *   PPQ_DATA_DIR  (optional*) — Directory for persistent config; enables saving
 *                               the API key from the status page in a browser
 *   PORT          (optional) — Proxy port, default 8787
 *   HOST          (optional) — Bind address, default 127.0.0.1 (use 0.0.0.0 in containers)
 *   PPQ_API_BASE  (optional) — API base URL, default https://api.ppq.ai
 *   DEBUG         (optional) — Set to "true" for verbose logging
 *
 *   *At least one of PPQ_API_KEY / PPQ_DATA_DIR is required.
 */

import { startProxy } from "../lib/proxy.js";

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

const proxy = await startProxy(
  { apiKey, port, host, apiBase, debug, dataDir },
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
console.log(`    -d '{"model":"private/kimi-k2-6","messages":[{"role":"user","content":"Hello"}]}'`);
console.log("");
console.log("Use with Claude Code (Anthropic format, POST /v1/messages):");
console.log(`  export ANTHROPIC_BASE_URL="http://127.0.0.1:${proxy.port}"`);
console.log(`  export ANTHROPIC_AUTH_TOKEN="$PPQ_API_KEY"`);
console.log(`  export ANTHROPIC_MODEL="private/glm-5-2"`);
console.log(`  export ANTHROPIC_SMALL_FAST_MODEL="private/glm-5-2"`);
console.log(`  claude`);
console.log("  # glm-5-2 / gpt-oss-120b / llama3-3-70b support tool calls; avoid kimi-k2-6 for Claude Code");
console.log("");

// Graceful shutdown
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, async () => {
    console.log("\nShutting down...");
    await proxy.close();
    process.exit(0);
  });
}
