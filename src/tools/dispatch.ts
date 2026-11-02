import type { RegisteredTool } from "./registry.ts";

export const HANDOFF_PREFIX = "HANDOFF:";

export interface HandoffPayload {
  target: "framework" | "review";
  athleteName?: string;
  note?: string;
  range?: string;
  report?: boolean;
  chart?: boolean;
  proposeChange?: boolean;
}

export function createDispatchTools(): RegisteredTool[] {
  return [
    {
      name: "dispatch_framework",
      description: "往下排课、重排 Slot、更换训练类型或模块。不要用它查名下学员或看标签。",
      inputSchema: {
        type: "object",
        properties: {
          athleteName: { type: "string", description: "学员名称，若已知。" },
          note: { type: "string", description: "一句话说明要排什么。" },
        },
      },
      async execute(input) {
        return encodeHandoff({
          target: "framework",
          athleteName: textField(input, "athleteName") || undefined,
          note: textField(input, "note") || undefined,
        });
      },
    },
    {
      name: "dispatch_review",
      description: "查已经练过的记录、写报告、出图，或提出下一阶段改法。不要用它查名下学员名单。",
      inputSchema: {
        type: "object",
        properties: {
          athleteName: { type: "string", description: "学员名称，若已知。" },
          range: { type: "string", description: "时间范围，如上次、近四周。" },
          note: { type: "string", description: "一句话说明要看什么。" },
          report: { type: "boolean", description: "是否要文字报告。" },
          chart: { type: "boolean", description: "是否要出图。" },
          proposeChange: { type: "boolean", description: "是否提出改法。" },
        },
      },
      async execute(input) {
        return encodeHandoff({
          target: "review",
          athleteName: textField(input, "athleteName") || undefined,
          range: textField(input, "range") || undefined,
          note: textField(input, "note") || undefined,
          report: boolField(input, "report"),
          chart: boolField(input, "chart"),
          proposeChange: boolField(input, "proposeChange"),
        });
      },
    },
  ];
}

export function encodeHandoff(payload: HandoffPayload): string {
  return `${HANDOFF_PREFIX}${JSON.stringify(payload)}`;
}

export function parseHandoff(output: string): HandoffPayload | null {
  if (!output.startsWith(HANDOFF_PREFIX)) return null;
  const rest = output.slice(HANDOFF_PREFIX.length).trim();
  if (rest === "framework" || rest === "review") return { target: rest };
  try {
    const parsed = JSON.parse(rest) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    const target = (parsed as { target?: unknown }).target;
    if (target !== "framework" && target !== "review") return null;
    const row = parsed as Record<string, unknown>;
    return {
      target,
      athleteName: typeof row.athleteName === "string" ? row.athleteName.trim() || undefined : undefined,
      note: typeof row.note === "string" ? row.note.trim() || undefined : undefined,
      range: typeof row.range === "string" ? row.range.trim() || undefined : undefined,
      report: typeof row.report === "boolean" ? row.report : undefined,
      chart: typeof row.chart === "boolean" ? row.chart : undefined,
      proposeChange: typeof row.proposeChange === "boolean" ? row.proposeChange : undefined,
    };
  } catch {
    return null;
  }
}

/** @deprecated 用 parseHandoff */
export function handoffKind(output: string): "framework" | "review" | null {
  return parseHandoff(output)?.target ?? null;
}

function textField(input: unknown, key: string): string {
  if (!input || typeof input !== "object") return "";
  const value = (input as Record<string, unknown>)[key];
  return typeof value === "string" ? value.trim() : "";
}

function boolField(input: unknown, key: string): boolean | undefined {
  if (!input || typeof input !== "object") return undefined;
  const value = (input as Record<string, unknown>)[key];
  return typeof value === "boolean" ? value : undefined;
}
