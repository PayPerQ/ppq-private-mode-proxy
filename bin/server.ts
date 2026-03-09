#!/usr/bin/env node
/**
 * Standalone entry point for the PPQ Private Mode proxy.
 *
 * Usage:
 *   PPQ_API_KEY=sk-xxx npx tsx bin/server.ts
 *
 * Environment variables:
 *   PPQ_API_KEY   (required) — Your PPQ.AI API key from https://ppq.ai/api-docs
 *   PORT          (optional) — Proxy port, default 8787
 *   PPQ_API_BASE  (optional) — API base URL, default https://api.ppq.ai
 *   DEBUG         (optional) — Set to "true" for verbose logging
 */

import { startProxy } from "../lib/proxy.js";

const apiKey = process.env.PPQ_API_KEY;
if (!apiKey) {
  console.error("Error: PPQ_API_KEY environment variable is required");
  console.error("Get your API key from https://ppq.ai/api-docs");
  process.exit(1);
}

const port = parseInt(process.env.PORT || "8787", 10);
const apiBase = process.env.PPQ_API_BASE || "https://api.ppq.ai";
const debug = process.env.DEBUG === "true";

const proxy = await startProxy(
  { apiKey, port, apiBase, debug },
  {
    info: (msg) => console.log(msg),
    error: (msg) => console.error(msg),
    debug: debug ? (msg) => console.log(`[debug] ${msg}`) : undefined,
  }
);

console.log("");
console.log("Send a test request:");
console.log(`  curl http://127.0.0.1:${proxy.port}/v1/chat/completions \\`);
console.log(`    -H "Content-Type: application/json" \\`);
console.log(`    -d '{"model":"private/kimi-k2-5","messages":[{"role":"user","content":"Hello"}]}'`);
console.log("");

// Graceful shutdown
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, async () => {
    console.log("\nShutting down...");
    await proxy.close();
    process.exit(0);
  });
}
