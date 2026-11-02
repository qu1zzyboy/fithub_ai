import { readModelEnv, type ModelEnv } from "../parent/classify.ts";
import type { ChatMessage } from "../parent/state.ts";
import type { AssistantTurn, LlmContent, LlmMessage, ToolSchema } from "./types.ts";

export function toLlmMessages(history: readonly ChatMessage[]): LlmMessage[] {
  const out: LlmMessage[] = [];
  for (const message of history) {
    if (message.role === "user") {
      out.push({ role: "user", content: message.content });
      continue;
    }
    if (message.role === "assistant") {
      const blocks: LlmContent[] = [];
      if (message.content.trim()) blocks.push({ type: "text", text: message.content });
      for (const use of message.toolUses ?? []) {
        blocks.push({ type: "tool_use", id: use.id, name: use.name, input: use.input });
      }
      out.push({ role: "assistant", content: blocks.length > 0 ? blocks : message.content });
      continue;
    }
    const last = out[out.length - 1];
    const block: LlmContent = {
      type: "tool_result",
      tool_use_id: message.toolUseId || "",
      content: message.content,
    };
    if (last && last.role === "user" && Array.isArray(last.content)) {
      last.content.push(block);
    } else {
      out.push({ role: "user", content: [block] });
    }
  }
  return out;
}

export function parseAssistantTurn(body: unknown): AssistantTurn {
  const row = body && typeof body === "object" ? body as Record<string, unknown> : {};
  const content = Array.isArray(row.content) ? row.content : [];
  const textParts: string[] = [];
  const toolUses: AssistantTurn["toolUses"] = [];
  for (const item of content) {
    if (!item || typeof item !== "object") continue;
    const block = item as Record<string, unknown>;
    if (block.type === "text" && typeof block.text === "string") textParts.push(block.text);
    if (block.type === "tool_use" && typeof block.id === "string" && typeof block.name === "string") {
      toolUses.push({ id: block.id, name: block.name, input: block.input ?? {} });
    }
  }
  return {
    text: textParts.join("\n").trim(),
    toolUses,
    stopReason: typeof row.stop_reason === "string" ? row.stop_reason : "",
  };
}

export async function runModelTurn(input: {
  system: string;
  messages: readonly ChatMessage[];
  tools: readonly ToolSchema[];
  maxTokens?: number;
}, env: ModelEnv = readModelEnv()): Promise<AssistantTurn> {
  const response = await fetch(`${env.baseUrl.replace(/\/+$/, "")}/v1/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": env.apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: env.model,
      max_tokens: input.maxTokens ?? 2048,
      system: input.system,
      tools: input.tools,
      messages: toLlmMessages(input.messages),
    }),
  });
  if (!response.ok) throw new Error(`主循环模型失败: ${response.status}`);
  return parseAssistantTurn(await response.json());
}
