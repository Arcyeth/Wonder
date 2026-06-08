/**
 * ReAct loop — the LLM orchestrates Wonder's tools until it produces a final
 * answer (or hits the step cap). Tool failures are fed back to the model so it
 * can recover. The deterministic cycles do the heavy lifting; this is the brain
 * that decides which to call and synthesizes the result.
 */
import { chat, type ChatMessage } from "../llm";
import { config } from "../config";
import { toolsForRole, executeTool, type Role } from "./tools";
import { buildSystemPrompt } from "./prompt";
import { log } from "../util/log";

export interface AgentResult {
  role: Role;
  goal: string;
  finalText: string;
  steps: number;
  toolCalls: { name: string; args: string }[];
}

export async function runAgent(opts: { goal: string; role?: Role }): Promise<AgentResult> {
  const role = opts.role ?? "GENERAL";
  const tools = toolsForRole(role);
  const messages: ChatMessage[] = [
    { role: "system", content: buildSystemPrompt(role) },
    { role: "user", content: opts.goal },
  ];
  const toolCalls: { name: string; args: string }[] = [];

  for (let step = 0; step < config.llm.maxSteps; step++) {
    const msg = await chat({ messages, tools, toolChoice: "auto" });
    messages.push(msg);

    if (msg.tool_calls && msg.tool_calls.length > 0) {
      for (const tc of msg.tool_calls) {
        toolCalls.push({ name: tc.function.name, args: tc.function.arguments });
        const result = await executeTool(tc.function.name, tc.function.arguments);
        messages.push({
          role: "tool",
          tool_call_id: tc.id,
          name: tc.function.name,
          content: result,
        });
      }
      continue; // let the model observe the tool results
    }

    // No tool calls → the model has produced its final answer.
    return { role, goal: opts.goal, finalText: msg.content ?? "", steps: step + 1, toolCalls };
  }

  log.warn("agent", `hit maxSteps (${config.llm.maxSteps}) without a final answer`);
  return {
    role,
    goal: opts.goal,
    finalText: "(stopped: reached max reasoning steps without concluding)",
    steps: config.llm.maxSteps,
    toolCalls,
  };
}
