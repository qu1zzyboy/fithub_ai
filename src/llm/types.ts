export interface ToolSchema {
  name: string;
  description: string;
  input_schema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export interface ToolUse {
  id: string;
  name: string;
  input: unknown;
}

export interface AssistantTurn {
  text: string;
  toolUses: ToolUse[];
  stopReason: string;
}

export type LlmContent =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; tool_use_id: string; content: string };

export interface LlmMessage {
  role: "user" | "assistant";
  content: string | LlmContent[];
}
