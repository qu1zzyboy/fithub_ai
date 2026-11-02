import type { ToolSchema } from "../llm/types.ts";

export const READONLY_TOOLS = [
  "list_my_athletes",
  "get_athlete_tags",
  "check_assessment",
  "list_period_plans",
] as const;

export const DISPATCH_TOOLS = [
  "dispatch_framework",
  "dispatch_review",
  "start_training_pipeline",
  "advance_pipeline_m2",
  "advance_pipeline_m3",
] as const;

/** 写入不进注册表。确认落库仍走主循环门禁。 */
export const WRITE_TOOLS = [
  "merge_tags",
  "save_framework",
  "save_plan_change",
] as const;

export type ReadonlyToolName = (typeof READONLY_TOOLS)[number];
export type DispatchToolName = (typeof DISPATCH_TOOLS)[number];

export interface ToolContext {
  token: string;
  clientId: string;
  athleteId: string | null;
  athleteName: string | null;
  bindAthlete(name: string): Promise<{ id: string; name: string } | null>;
}

export interface RegisteredTool {
  name: string;
  description: string;
  inputSchema: ToolSchema["input_schema"];
  execute(input: unknown, ctx: ToolContext): Promise<string>;
}

export interface ToolRegistry {
  definitions(): ToolSchema[];
  has(name: string): boolean;
  get(name: string): RegisteredTool;
  execute(name: string, input: unknown, ctx: ToolContext): Promise<string>;
}

export function createRegistry(tools: readonly RegisteredTool[]): ToolRegistry {
  const map = new Map<string, RegisteredTool>();
  for (const tool of tools) {
    if ((WRITE_TOOLS as readonly string[]).includes(tool.name)) {
      throw new Error(`写入工具不能进注册表：${tool.name}`);
    }
    map.set(tool.name, tool);
  }
  return {
    definitions() {
      return [...map.values()].map((tool) => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.inputSchema,
      }));
    },
    has(name) {
      return map.has(name);
    },
    get(name) {
      const tool = map.get(name);
      if (!tool) throw new Error(`没有这个工具：${name}`);
      return tool;
    },
    async execute(name, input, ctx) {
      if ((WRITE_TOOLS as readonly string[]).includes(name)) {
        throw new Error(`写入工具不能调用：${name}`);
      }
      return this.get(name).execute(input, ctx);
    },
  };
}

export function isDispatchTool(name: string): name is DispatchToolName {
  return (DISPATCH_TOOLS as readonly string[]).includes(name);
}

export function isReadonlyTool(name: string): name is ReadonlyToolName {
  return (READONLY_TOOLS as readonly string[]).includes(name);
}
