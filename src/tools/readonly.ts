import { executeCapability } from "../business/execute.ts";
import type { BusinessClient } from "../chat/business.ts";
import type { RegisteredTool, ToolContext } from "./registry.ts";

export function createReadonlyTools(business: BusinessClient): RegisteredTool[] {
  return [
    {
      name: "list_my_athletes",
      description: "列出当前教练名下、当前客户可见的学员。问名下有谁、有哪些学员时用。",
      inputSchema: { type: "object", properties: {} },
      async execute(_input, ctx) {
        return executeCapability({
          capability: "list_my_athletes",
          token: ctx.token,
          clientId: ctx.clientId,
          athleteId: null,
          athleteName: null,
          business,
        });
      },
    },
    {
      name: "get_athlete_tags",
      description: "读取某名学员的档案标签：训练目标、经验、关节问题、慢性病。需要学员名称，或会话里已绑定学员。",
      inputSchema: {
        type: "object",
        properties: {
          athleteName: { type: "string", description: "学员名称。会话未绑定时必填。" },
        },
      },
      async execute(input, ctx) {
        const bound = await ensureAthlete(input, ctx);
        if ("error" in bound) return bound.error;
        return executeCapability({
          capability: "get_athlete_tags",
          token: ctx.token,
          clientId: ctx.clientId,
          athleteId: bound.id,
          athleteName: bound.name,
          business,
        });
      },
    },
    {
      name: "check_assessment",
      description: "查某名学员评估是否在库。需要学员名称，或会话里已绑定学员。",
      inputSchema: {
        type: "object",
        properties: {
          athleteName: { type: "string", description: "学员名称。会话未绑定时必填。" },
        },
      },
      async execute(input, ctx) {
        const bound = await ensureAthlete(input, ctx);
        if ("error" in bound) return bound.error;
        return executeCapability({
          capability: "check_assessment",
          token: ctx.token,
          clientId: ctx.clientId,
          athleteId: bound.id,
          athleteName: bound.name,
          business,
        });
      },
    },
    {
      name: "list_period_plans",
      description: "列出当前客户可见的周期计划名称。",
      inputSchema: { type: "object", properties: {} },
      async execute(_input, ctx) {
        return executeCapability({
          capability: "list_period_plans",
          token: ctx.token,
          clientId: ctx.clientId,
          athleteId: null,
          athleteName: null,
          business,
        });
      },
    },
  ];
}

async function ensureAthlete(
  input: unknown,
  ctx: ToolContext,
): Promise<{ id: string; name: string } | { error: string }> {
  if (ctx.athleteId && ctx.athleteName) return { id: ctx.athleteId, name: ctx.athleteName };
  const name = textField(input, "athleteName");
  if (!name) return { error: "请先告诉我学员名称。" };
  const athlete = await ctx.bindAthlete(name);
  if (!athlete) return { error: "对不上这名学员。" };
  ctx.athleteId = athlete.id;
  ctx.athleteName = athlete.name;
  return athlete;
}

function textField(input: unknown, key: string): string {
  if (!input || typeof input !== "object") return "";
  const value = (input as Record<string, unknown>)[key];
  return typeof value === "string" ? value.trim() : "";
}
