/**
 * Server-rendered status / setup page served at GET /.
 *
 * Gives the proxy a browser-facing surface: attestation state, connection
 * details, quick-start snippets, and — when a persistent data directory is
 * configured (PPQ_DATA_DIR) — a first-run form to save the PPQ.AI API key.
 * The saved key is never echoed back to the page.
 */

export interface StatusPageState {
  attested: boolean;
  enclaveHost?: string;
  codeFingerprint?: string;
  keyConfigured: boolean;
  /** Setup form is shown only when the key can be persisted (PPQ_DATA_DIR set). */
  setupEnabled: boolean;
  models: string[];
}

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function renderStatusPage(state: StatusPageState): string {
  const attestation = state.attested
    ? `<span class="badge ok">verified</span>
       <div class="kv">
         <div><span>Enclave</span><code>${esc(state.enclaveHost || "unknown")}</code></div>
         <div><span>Code fingerprint</span><code>${esc((state.codeFingerprint || "").slice(0, 32))}…</code></div>
       </div>`
    : `<span class="badge warn">pending</span>`;

  const keySection = state.keyConfigured
    ? `<p><span class="badge ok">configured</span> Requests are billed to your saved PPQ.AI API key.
       ${state.setupEnabled ? `<a href="#" id="change-key">Replace key</a>` : ""}</p>
       ${state.setupEnabled ? keyForm(true) : ""}`
    : state.setupEnabled
      ? `<p><span class="badge warn">not configured</span> Paste an API key from
         <a href="https://ppq.ai/api-docs" target="_blank" rel="noopener">ppq.ai</a>
         (create one under <strong>Settings&nbsp;→&nbsp;API&nbsp;Keys</strong> and fund the account —
         usage is billed per query).</p>
         ${keyForm(false)}`
      : `<p><span class="badge warn">not configured</span> Start the proxy with the
         <code>PPQ_API_KEY</code> environment variable, or send a key per request as an
         <code>Authorization: Bearer</code> header.</p>`;

  const modelList = state.models.map((m) => `<li><code>${esc(m)}</code></li>`).join("");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>PPQ Private Mode</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 15px/1.6 system-ui, sans-serif; max-width: 720px; margin: 2rem auto; padding: 0 1rem; }
  h1 { font-size: 1.5rem; } h2 { font-size: 1.05rem; margin-top: 2rem; }
  code { background: rgba(128,128,128,.15); padding: .1em .35em; border-radius: 4px; font-size: .9em; }
  pre { background: rgba(128,128,128,.12); padding: .75rem 1rem; border-radius: 8px; overflow-x: auto; }
  pre code { background: none; padding: 0; }
  .badge { display: inline-block; padding: .1em .6em; border-radius: 999px; font-size: .8em; font-weight: 600; }
  .badge.ok { background: #16a34a22; color: #16a34a; }
  .badge.warn { background: #d9770622; color: #d97706; }
  .kv div { display: flex; gap: .5rem; align-items: baseline; }
  .kv span { min-width: 9.5rem; opacity: .7; font-size: .9em; }
  form { display: flex; gap: .5rem; margin: .75rem 0; }
  input[type=password] { flex: 1; padding: .5rem .75rem; border-radius: 8px; border: 1px solid rgba(128,128,128,.4); font: inherit; }
  button { padding: .5rem 1rem; border-radius: 8px; border: none; background: #ea580c; color: #fff; font: inherit; cursor: pointer; }
  #msg { font-size: .9em; }
  .hidden { display: none; }
  footer { margin-top: 3rem; opacity: .6; font-size: .85em; }
</style>
</head>
<body>
<h1>🔥 PPQ Private Mode</h1>
<p>End-to-end encrypted proxy for PPQ.AI private (TEE) AI models. Requests are encrypted
here and only decrypted inside a hardware-secured enclave — nobody in between, PPQ.AI
included, can read them.</p>

<h2>Enclave attestation</h2>
${attestation}

<h2>API key</h2>
${keySection}
<p id="msg"></p>

<h2>Connect a client</h2>
<p>OpenAI-compatible clients:</p>
<pre><code>POST {origin}/v1/chat/completions
{"model": "private/glm-5-2", "messages": [{"role": "user", "content": "Hello"}]}</code></pre>
<p>Anthropic-SDK clients (including Claude Code):</p>
<pre><code>export ANTHROPIC_BASE_URL="{origin}"
export ANTHROPIC_MODEL="private/glm-5-2"</code></pre>
<p><code>GET /v1/models</code> lists models. <code>GET /health</code> returns JSON status.</p>

<h2>Available models</h2>
<ul>${modelList}</ul>

<footer>
  <a href="https://github.com/PayPerQ/ppq-private-mode-proxy" target="_blank" rel="noopener">Source</a> ·
  <a href="https://ppq.ai" target="_blank" rel="noopener">PPQ.AI</a>
</footer>

<script>
  // Fill in the real origin the user is browsing from.
  document.querySelectorAll("pre code").forEach(function (el) {
    el.textContent = el.textContent.replaceAll("{origin}", window.location.origin);
  });

  var form = document.getElementById("key-form");
  var change = document.getElementById("change-key");
  if (change && form) {
    change.addEventListener("click", function (e) {
      e.preventDefault();
      form.classList.toggle("hidden");
    });
  }
  if (form) {
    form.addEventListener("submit", async function (e) {
      e.preventDefault();
      var msg = document.getElementById("msg");
      var input = document.getElementById("key-input");
      msg.textContent = "Saving…";
      try {
        var res = await fetch("/setup/api-key", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ apiKey: input.value.trim() }),
        });
        var body = await res.json();
        if (res.ok) {
          msg.textContent = "Saved. Reloading…";
          window.location.reload();
        } else {
          msg.textContent = body?.error?.message || "Failed to save the key.";
        }
      } catch (err) {
        msg.textContent = "Failed to save the key: " + err.message;
      }
    });
  }
</script>
</body>
</html>`;
}

function keyForm(hidden: boolean): string {
  return `<form id="key-form" class="${hidden ? "hidden" : ""}" autocomplete="off">
    <input type="password" id="key-input" placeholder="sk-..." required
           autocomplete="off" spellcheck="false">
    <button type="submit">Save key</button>
  </form>`;
}
