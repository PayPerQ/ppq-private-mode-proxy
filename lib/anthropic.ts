/**
 * Anthropic Messages ↔ OpenAI Chat Completions translation.
 *
 * The PPQ private enclave speaks the OpenAI chat-completions dialect. Claude
 * Code (and any other Anthropic-SDK client) speaks the Anthropic Messages
 * dialect and POSTs to `/v1/messages`. This module converts between the two so
 * the proxy can expose a native `/v1/messages` endpoint without changing the
 * encrypted upstream path.
 *
 * Tool calls and streaming are translated faithfully because Claude Code relies
 * on both for every agentic turn.
 */

// ─── Request: Anthropic → OpenAI ─────────────────────────────────────────────

interface AnthropicTextBlock {
  type: "text";
  text: string;
}
interface AnthropicImageBlock {
  type: "image";
  source:
    | { type: "base64"; media_type: string; data: string }
    | { type: "url"; url: string };
}
interface AnthropicToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
}
interface AnthropicToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content?: string | Array<AnthropicTextBlock | AnthropicImageBlock>;
  is_error?: boolean;
}
type AnthropicContentBlock =
  | AnthropicTextBlock
  | AnthropicImageBlock
  | AnthropicToolUseBlock
  | AnthropicToolResultBlock;

interface AnthropicMessage {
  role: "user" | "assistant";
  content: string | AnthropicContentBlock[];
}

export interface AnthropicRequest {
  model?: string;
  max_tokens?: number;
  messages: AnthropicMessage[];
  system?: string | AnthropicTextBlock[];
  stream?: boolean;
  temperature?: number;
  top_p?: number;
  top_k?: number;
  stop_sequences?: string[];
  tools?: Array<{ name: string; description?: string; input_schema: unknown }>;
  tool_choice?:
    | { type: "auto" }
    | { type: "any" }
    | { type: "tool"; name: string }
    | { type: "none" };
}

/** Flatten an Anthropic image source into an OpenAI data/remote URL. */
function imageToUrl(source: AnthropicImageBlock["source"]): string {
  if (source.type === "url") return source.url;
  return `data:${source.media_type};base64,${source.data}`;
}

/** Reduce a tool_result's content to a single string for an OpenAI tool message. */
function toolResultToText(
  content: AnthropicToolResultBlock["content"]
): string {
  if (content == null) return "";
  if (typeof content === "string") return content;
  return content
    .map((block) =>
      block.type === "text" ? block.text : "[non-text tool result content omitted]"
    )
    .join("\n");
}

/** Convert an Anthropic system prompt (string or block array) to plain text. */
function systemToText(system: AnthropicRequest["system"]): string | null {
  if (system == null) return null;
  if (typeof system === "string") return system;
  return system.map((b) => b.text).join("\n");
}

/**
 * Translate an Anthropic Messages request body into an OpenAI chat-completions
 * request body. Returns a plain object ready to JSON.stringify and forward.
 */
export function anthropicToOpenAI(req: AnthropicRequest): Record<string, unknown> {
  const messages: Array<Record<string, unknown>> = [];

  const systemText = systemToText(req.system);
  if (systemText) {
    messages.push({ role: "system", content: systemText });
  }

  for (const msg of req.messages) {
    // Simple string content maps directly.
    if (typeof msg.content === "string") {
      messages.push({ role: msg.role, content: msg.content });
      continue;
    }

    if (msg.role === "assistant") {
      // Assistant turns may contain text and/or tool_use blocks.
      const textParts: string[] = [];
      const toolCalls: Array<Record<string, unknown>> = [];
      for (const block of msg.content) {
        if (block.type === "text") {
          textParts.push(block.text);
        } else if (block.type === "tool_use") {
          toolCalls.push({
            id: block.id,
            type: "function",
            function: {
              name: block.name,
              arguments: JSON.stringify(block.input ?? {}),
            },
          });
        }
      }
      const assistantMsg: Record<string, unknown> = { role: "assistant" };
      assistantMsg.content = textParts.length ? textParts.join("") : null;
      if (toolCalls.length) assistantMsg.tool_calls = toolCalls;
      messages.push(assistantMsg);
      continue;
    }

    // User turns may contain text, images, and tool_result blocks. Each
    // tool_result becomes its own OpenAI `tool` message; remaining blocks are
    // collected into a single user message (multimodal parts when needed).
    const userParts: Array<Record<string, unknown>> = [];
    const pendingToolMessages: Array<Record<string, unknown>> = [];
    for (const block of msg.content) {
      if (block.type === "text") {
        userParts.push({ type: "text", text: block.text });
      } else if (block.type === "image") {
        userParts.push({
          type: "image_url",
          image_url: { url: imageToUrl(block.source) },
        });
      } else if (block.type === "tool_result") {
        pendingToolMessages.push({
          role: "tool",
          tool_call_id: block.tool_use_id,
          content: toolResultToText(block.content),
        });
      }
    }

    // OpenAI requires tool results to immediately follow the assistant
    // tool_calls message, so emit them before any plain user content.
    for (const toolMsg of pendingToolMessages) messages.push(toolMsg);
    if (userParts.length) {
      // Collapse to a plain string when there's a single text part — keeps
      // requests simple for models/endpoints that don't expect part arrays.
      if (userParts.length === 1 && userParts[0].type === "text") {
        messages.push({ role: "user", content: userParts[0].text });
      } else {
        messages.push({ role: "user", content: userParts });
      }
    }
  }

  const out: Record<string, unknown> = {
    model: req.model,
    messages,
    // Anthropic requires max_tokens; OpenAI tolerates it. Default defensively.
    max_tokens: req.max_tokens ?? 4096,
    stream: !!req.stream,
  };

  if (typeof req.temperature === "number") out.temperature = req.temperature;
  if (typeof req.top_p === "number") out.top_p = req.top_p;
  // top_k has no OpenAI equivalent — intentionally dropped.
  if (req.stop_sequences?.length) out.stop = req.stop_sequences;
  if (req.stream) out.stream_options = { include_usage: true };

  if (req.tools?.length) {
    out.tools = req.tools.map((t) => ({
      type: "function",
      function: {
        name: t.name,
        description: t.description,
        parameters: t.input_schema ?? { type: "object", properties: {} },
      },
    }));
  }

  if (req.tool_choice) {
    switch (req.tool_choice.type) {
      case "auto":
        out.tool_choice = "auto";
        break;
      case "any":
        out.tool_choice = "required";
        break;
      case "none":
        out.tool_choice = "none";
        break;
      case "tool":
        out.tool_choice = {
          type: "function",
          function: { name: req.tool_choice.name },
        };
        break;
    }
  }

  return out;
}

// ─── Response: OpenAI → Anthropic ────────────────────────────────────────────

const STOP_REASON_MAP: Record<string, string> = {
  stop: "end_turn",
  length: "max_tokens",
  tool_calls: "tool_use",
  function_call: "tool_use",
  content_filter: "end_turn",
};

function mapStopReason(finish: string | null | undefined): string {
  if (!finish) return "end_turn";
  return STOP_REASON_MAP[finish] ?? "end_turn";
}

let messageCounter = 0;
/** Generate an Anthropic-style message id. Uniqueness within a process run. */
export function newMessageId(): string {
  messageCounter = (messageCounter + 1) % 1_000_000;
  const ts = Date.now().toString(36);
  return `msg_${ts}${messageCounter.toString(36).padStart(4, "0")}`;
}

interface OpenAIChoice {
  message?: {
    content?: string | null;
    tool_calls?: Array<{
      id: string;
      function: { name: string; arguments: string };
    }>;
  };
  finish_reason?: string | null;
}
interface OpenAIResponse {
  id?: string;
  choices?: OpenAIChoice[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

/** Parse a tool_call arguments string into an object, tolerating malformed JSON. */
function parseToolInput(args: string): unknown {
  if (!args) return {};
  try {
    return JSON.parse(args);
  } catch {
    return {};
  }
}

/**
 * Translate a non-streaming OpenAI chat-completions response into an Anthropic
 * Messages response.
 */
export function openAIToAnthropicResponse(
  oai: OpenAIResponse,
  model: string,
  messageId: string
): Record<string, unknown> {
  const choice = oai.choices?.[0];
  const content: Array<Record<string, unknown>> = [];

  const text = choice?.message?.content;
  if (typeof text === "string" && text.length) {
    content.push({ type: "text", text });
  }

  for (const call of choice?.message?.tool_calls ?? []) {
    content.push({
      type: "tool_use",
      id: call.id,
      name: call.function.name,
      input: parseToolInput(call.function.arguments),
    });
  }

  // An Anthropic message must always carry at least one content block.
  if (content.length === 0) content.push({ type: "text", text: "" });

  return {
    id: messageId,
    type: "message",
    role: "assistant",
    model,
    content,
    stop_reason: mapStopReason(choice?.finish_reason),
    stop_sequence: null,
    usage: {
      input_tokens: oai.usage?.prompt_tokens ?? 0,
      output_tokens: oai.usage?.completion_tokens ?? 0,
    },
  };
}

// ─── Streaming: OpenAI SSE → Anthropic SSE ───────────────────────────────────

interface SSEWriter {
  (event: string, data: unknown): void;
}

interface ToolBlockState {
  anthropicIndex: number;
  started: boolean;
}

/**
 * Stateful translator that consumes OpenAI streaming chunks and emits the
 * Anthropic SSE event sequence (message_start → content_block_* → message_delta
 * → message_stop). Feed each parsed OpenAI `data:` object to `pushChunk`, then
 * call `finish` once the upstream stream ends.
 */
export class AnthropicStreamTranslator {
  private write: SSEWriter;
  private model: string;
  private messageId: string;

  private messageStarted = false;
  private textBlockIndex = -1; // anthropic index of the open text block, or -1
  private nextIndex = 0;
  private toolBlocks = new Map<number, ToolBlockState>(); // keyed by OpenAI tool_call index
  private finishReason: string | null = null;
  private inputTokens = 0;
  private outputTokens = 0;

  constructor(write: SSEWriter, model: string, messageId: string) {
    this.write = write;
    this.model = model;
    this.messageId = messageId;
  }

  private ensureStarted(): void {
    if (this.messageStarted) return;
    this.messageStarted = true;
    this.write("message_start", {
      type: "message_start",
      message: {
        id: this.messageId,
        type: "message",
        role: "assistant",
        model: this.model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: this.inputTokens, output_tokens: 0 },
      },
    });
  }

  private openTextBlock(): void {
    if (this.textBlockIndex !== -1) return;
    this.textBlockIndex = this.nextIndex++;
    this.write("content_block_start", {
      type: "content_block_start",
      index: this.textBlockIndex,
      content_block: { type: "text", text: "" },
    });
  }

  private closeTextBlock(): void {
    if (this.textBlockIndex === -1) return;
    this.write("content_block_stop", {
      type: "content_block_stop",
      index: this.textBlockIndex,
    });
    this.textBlockIndex = -1;
  }

  private closeToolBlock(oaiIndex: number): void {
    const state = this.toolBlocks.get(oaiIndex);
    if (state?.started) {
      this.write("content_block_stop", {
        type: "content_block_stop",
        index: state.anthropicIndex,
      });
      state.started = false;
    }
  }

  pushChunk(chunk: {
    choices?: Array<{
      delta?: {
        content?: string | null;
        tool_calls?: Array<{
          index: number;
          id?: string;
          function?: { name?: string; arguments?: string };
        }>;
      };
      finish_reason?: string | null;
    }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  }): void {
    this.ensureStarted();

    if (chunk.usage) {
      if (typeof chunk.usage.prompt_tokens === "number")
        this.inputTokens = chunk.usage.prompt_tokens;
      if (typeof chunk.usage.completion_tokens === "number")
        this.outputTokens = chunk.usage.completion_tokens;
    }

    const choice = chunk.choices?.[0];
    if (!choice) return;

    const delta = choice.delta;

    // Text delta.
    if (delta?.content) {
      this.openTextBlock();
      this.write("content_block_delta", {
        type: "content_block_delta",
        index: this.textBlockIndex,
        delta: { type: "text_delta", text: delta.content },
      });
    }

    // Tool call deltas.
    for (const tc of delta?.tool_calls ?? []) {
      // A tool call always supersedes any open text block.
      this.closeTextBlock();

      let state = this.toolBlocks.get(tc.index);
      if (!state) {
        state = { anthropicIndex: this.nextIndex++, started: false };
        this.toolBlocks.set(tc.index, state);
      }

      if (!state.started) {
        state.started = true;
        this.write("content_block_start", {
          type: "content_block_start",
          index: state.anthropicIndex,
          content_block: {
            type: "tool_use",
            id: tc.id || `toolu_${state.anthropicIndex}`,
            name: tc.function?.name || "",
            input: {},
          },
        });
      }

      const args = tc.function?.arguments;
      if (args) {
        this.write("content_block_delta", {
          type: "content_block_delta",
          index: state.anthropicIndex,
          delta: { type: "input_json_delta", partial_json: args },
        });
      }
    }

    if (choice.finish_reason) {
      this.finishReason = choice.finish_reason;
    }
  }

  /** Emit the closing event sequence. Safe to call exactly once. */
  finish(): void {
    this.ensureStarted();
    this.closeTextBlock();
    for (const oaiIndex of this.toolBlocks.keys()) this.closeToolBlock(oaiIndex);

    this.write("message_delta", {
      type: "message_delta",
      delta: {
        stop_reason: mapStopReason(this.finishReason),
        stop_sequence: null,
      },
      usage: { output_tokens: this.outputTokens },
    });
    this.write("message_stop", { type: "message_stop" });
  }
}
