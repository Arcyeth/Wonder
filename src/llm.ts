/**
 * Provider-agnostic OpenAI-compatible chat client (fetch-based, no SDK dep).
 * Works with OpenRouter (default), a local LM Studio endpoint, OpenAI, etc.
 * Configure via LLM_BASE_URL / LLM_API_KEY (or OPENROUTER_API_KEY) / LLM_MODEL.
 */
import { config } from "./config";

export interface ToolDef {
  type: "function";
  function: { name: string; description: string; parameters: object };
}

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
}

function isLocal(url: string): boolean {
  return /localhost|127\.0\.0\.1|0\.0\.0\.0/.test(url);
}

/** True if an LLM can actually be called (key present, or local endpoint). */
export function llmAvailable(): boolean {
  return Boolean(config.llm.apiKey) || isLocal(config.llm.baseUrl);
}

export function assertLlm(): void {
  if (!llmAvailable()) {
    throw new Error(
      "No LLM configured. Set LLM_API_KEY (or OPENROUTER_API_KEY) in .env, " +
        "or point LLM_BASE_URL at a local endpoint (e.g. http://localhost:1234/v1).",
    );
  }
}

export async function chat(opts: {
  messages: ChatMessage[];
  tools?: ToolDef[];
  toolChoice?: "auto" | "none" | "required";
}): Promise<ChatMessage> {
  assertLlm();
  const { baseUrl, apiKey, model, temperature, maxTokens } = config.llm;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;

  const body: Record<string, unknown> = {
    model,
    messages: opts.messages,
    temperature,
    max_tokens: maxTokens,
  };
  if (opts.tools?.length) {
    body.tools = opts.tools;
    body.tool_choice = opts.toolChoice ?? "auto";
  }

  const res = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`LLM HTTP ${res.status}: ${text.slice(0, 300)}`);
  }
  const data: any = await res.json();
  const msg = data?.choices?.[0]?.message;
  if (!msg) throw new Error("LLM returned no message");
  return msg as ChatMessage;
}
