import type { BusinessClient, PipelineHandoff, PipelineRun } from "../chat/business.ts";
import { buildH1, type H1Payload, type UserType } from "../pipeline/m1.ts";
import { buildH2, summarizeH2, type GateResult, type H2Payload } from "../pipeline/m2.ts";
import { buildH3, summarizeH3, type Horizon, type Preference } from "../pipeline/m3.ts";
import type { RegisteredTool } from "./registry.ts";

/** M1–M3 规划轨工具。写入走后端 ai_pipeline 表，不进本地 WRITE_TOOLS 黑名单。 */
export function createPipelineTools(business: BusinessClient): RegisteredTool[] {
  return [
    {
      name: "start_training_pipeline",
      description:
        "开训练规划：根据需求判断学员类型与主/辅训练方向。用于「做周计划/训练规划」。不要用它查名下学员，也不要用旧的 Slot 排课代替。",
      inputSchema: {
        type: "object",
        properties: {
          athleteName: { type: "string", description: "学员名称。会话未绑定时必填。" },
          utterance: { type: "string", description: "教练原话或需求摘要，用于模块匹配。" },
          userType: {
            type: "string",
            description: "可选：fitness | performance | occupational。不传则从原话推断。",
          },
          accept: {
            type: "boolean",
            description: "是否立刻确认本步并进入伤病/评估定位。默认 false，先给教练看草案。",
          },
        },
        required: ["utterance"],
      },
      async execute(input, ctx) {
        const utterance = textField(input, "utterance");
        if (!utterance) return "请先说清楚训练需求。";
        const bound = await ensureAthlete(input, ctx);
        if ("error" in bound) return bound.error;

        const userType = parseUserType(textField(input, "userType"));
        const h1 = buildH1({ utterance, userType });
        const accept = boolField(input, "accept") === true;

        const run = await business.createPipelineRun({
          token: ctx.token,
          userId: bound.id,
          source: "dialog",
          reuseActive: true,
        });
        await business.appendPipelineHandoff({
          token: ctx.token,
          runId: run.id,
          handoffId: "H1",
          payload: h1,
          note: `M1 for ${bound.name}`,
          accept,
        });

        const secondary = h1.secondary_modules.length > 0
          ? `；辅方向 ${h1.secondary_modules.join("、")}`
          : "";
        return [
          `已为 ${bound.name} 记下规划意向（${accept ? "已确认" : "草案"}）。`,
          `类型：${labelType(h1.user_type)}；主方向 ${h1.primary_module}${secondary}。`,
          accept
            ? "下一步请补伤病与评估信息，我再做安全定位。"
            : "方向没问题的话告诉我，我再按伤病和评估做安全定位。",
        ].join("\n");
      },
    },
    {
      name: "advance_pipeline_m2",
      description:
        "在已有规划上做安全定位：红线转介、伤病相关方向是否可练、评估入口与强度区间。需要学员名称；可带伤病说明与评估结果。上一步草案未确认时会先尝试确认。",
      inputSchema: {
        type: "object",
        properties: {
          athleteName: { type: "string", description: "学员名称。会话未绑定时必填。" },
          injuryNote: { type: "string", description: "伤病自述，如「右膝急性疼痛」「慢性腰不适」。" },
          mobility: { type: "string", description: "关节功能：pass | fail。不传则按是否有评估推断。" },
          stability: { type: "string", description: "动作稳定：pass | fail。" },
          strengthFloor: { type: "string", description: "力量底线：pass | fail。" },
          accept: {
            type: "boolean",
            description: "是否立刻确认本步并进入周安排草案。默认 false。",
          },
        },
      },
      async execute(input, ctx) {
        const bound = await ensureAthlete(input, ctx);
        if ("error" in bound) return bound.error;

        const ready = await loadActiveRun(business, ctx.token, bound.id);
        if ("error" in ready) return ready.error;
        let { run } = ready;

        const ensured = await ensureAccepted(business, ctx.token, run, "H1");
        if ("error" in ensured) return ensured.error;
        run = ensured.run;

        const user = await business.readUser({ token: ctx.token, userId: bound.id });
        const jointTags = (user?.tags ?? []).filter((tag) => tag.startsWith("关节问题:") || ["膝", "肩", "腰", "踝", "髋"].includes(tag));
        const hasAssessment = await business.hasAssessment({ token: ctx.token, userId: bound.id });

        const h2 = buildH2({
          injuryNote: textField(input, "injuryNote"),
          jointTags,
          mobility: parseGate(textField(input, "mobility")),
          stability: parseGate(textField(input, "stability")),
          strengthFloor: parseGate(textField(input, "strengthFloor")),
          hasAssessment,
        });
        const accept = boolField(input, "accept") === true;

        if (h2.redline.result === "refer") {
          await business.appendPipelineHandoff({
            token: ctx.token,
            runId: run.id,
            handoffId: "H2",
            payload: h2,
            note: `M2 redline for ${bound.name}`,
            accept: true,
          });
          return [
            `安全定位结论：建议先就医/康复，本轮先不排训练计划。`,
            summarizeH2(h2),
          ].join("\n");
        }

        await business.appendPipelineHandoff({
          token: ctx.token,
          runId: run.id,
          handoffId: "H2",
          payload: h2,
          note: `M2 for ${bound.name}`,
          accept,
        });

        return [
          `安全定位（${accept ? "已确认" : "草案"}）：${summarizeH2(h2)}`,
          accept
            ? "可以继续排出本周模块安排草案。"
            : "定位没问题的话告诉我，我再排出本周模块安排草案。",
        ].join("\n");
      },
    },
    {
      name: "advance_pipeline_m3",
      description:
        "在目标与安全定位就绪后，写出模块级周安排草案与档案壳。可带每周次数、单次时长、偏好（focus/variety 等）。不选具体动作。",
      inputSchema: {
        type: "object",
        properties: {
          athleteName: { type: "string", description: "学员名称。会话未绑定时必填。" },
          preference: {
            type: "string",
            description: "focus | lean_focus | balanced | lean_variety | variety。不传则从原话推断。",
          },
          frequency: { type: "number", description: "每周训练次数，1–6。" },
          sessionMinutes: { type: "number", description: "单次分钟数，如 30/45/60/90。" },
          horizon: { type: "string", description: "single | short | long。" },
          accept: {
            type: "boolean",
            description: "是否立刻确认周安排草案。默认 false。",
          },
        },
      },
      async execute(input, ctx) {
        const bound = await ensureAthlete(input, ctx);
        if ("error" in bound) return bound.error;

        const ready = await loadActiveRun(business, ctx.token, bound.id);
        if ("error" in ready) return ready.error;
        let { run } = ready;

        const h1Ready = await ensureAccepted(business, ctx.token, run, "H1");
        if ("error" in h1Ready) return h1Ready.error;
        run = h1Ready.run;
        const h1 = asH1(h1Ready.handoff.payload);
        if (!h1) return "上一步目标方向内容异常，请重新说一下训练需求。";

        const h2Ready = await ensureAccepted(business, ctx.token, run, "H2");
        if ("error" in h2Ready) return h2Ready.error;
        run = h2Ready.run;
        const h2 = asH2(h2Ready.handoff.payload);
        if (!h2) return "安全定位内容异常，请重新补一下伤病与评估情况。";
        if (h2.redline.result === "refer") {
          return `仍建议先就医/康复（${h2.redline.reason || "需就医"}），暂不排周计划。`;
        }

        let h3;
        try {
          h3 = buildH3({
            h1,
            h2,
            preference: parsePreference(textField(input, "preference")),
            frequency: numberField(input, "frequency"),
            sessionMinutes: numberField(input, "sessionMinutes"),
            horizon: parseHorizon(textField(input, "horizon")),
            athleteName: bound.name,
          });
        } catch (error) {
          return error instanceof Error ? error.message : "周安排合成失败。";
        }

        const accept = boolField(input, "accept") === true;
        await business.appendPipelineHandoff({
          token: ctx.token,
          runId: run.id,
          handoffId: "H3",
          payload: h3,
          note: `M3 for ${bound.name}`,
          accept,
        });

        return [
          `周安排（${accept ? "已确认" : "草案"}）：${summarizeH3(h3)}`,
          accept
            ? "模块级周安排已确认。具体动作与负荷后续再细化。"
            : "这版周安排可以的话告诉我；具体动作与负荷后续再细化。",
        ].join("\n");
      },
    },
  ];
}

async function loadActiveRun(
  business: BusinessClient,
  token: string,
  userId: string,
): Promise<{ run: PipelineRun } | { error: string }> {
  const run = await business.getPipelineRun({ token, userId, activeOnly: true }).catch(() => null);
  if (!run) return { error: "还没有进行中的规划。请先说清学员和训练目标，开规划意向。" };
  return { run };
}

async function ensureAccepted(
  business: BusinessClient,
  token: string,
  run: PipelineRun,
  handoffId: "H1" | "H2",
): Promise<{ run: PipelineRun; handoff: PipelineHandoff } | { error: string }> {
  const rows = await business.listPipelineHandoffs({ token, runId: run.id, handoffId });
  const accepted = rows.find((item) => item.status === "accepted");
  if (accepted) return { run, handoff: accepted };
  const draft = rows.find((item) => item.status === "draft");
  if (!draft) {
    return {
      error: handoffId === "H1"
        ? "还没有目标方向，请先说清训练需求。"
        : "还没有安全定位，请先补伤病与评估情况。",
    };
  }
  const result = await business.acceptPipelineHandoff({ token, runId: run.id, handoffId });
  return { run: result.run, handoff: result.handoff };
}

function asH1(payload: unknown): H1Payload | null {
  const row = payload && typeof payload === "object" ? payload as Record<string, unknown> : null;
  if (!row || row.handoff_id !== "H1") return null;
  if (typeof row.primary_module !== "string" || typeof row.user_type !== "string") return null;
  return payload as H1Payload;
}

function asH2(payload: unknown): H2Payload | null {
  const row = payload && typeof payload === "object" ? payload as Record<string, unknown> : null;
  if (!row || row.handoff_id !== "H2") return null;
  if (!row.redline || !row.entry_point || !Array.isArray(row.module_states)) return null;
  return payload as H2Payload;
}

async function ensureAthlete(
  input: unknown,
  ctx: {
    athleteId: string | null;
    athleteName: string | null;
    bindAthlete(name: string): Promise<{ id: string; name: string } | null>;
  },
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

function parseUserType(raw: string): UserType | undefined {
  if (raw === "fitness" || raw === "performance" || raw === "occupational") return raw;
  return undefined;
}

function parseGate(raw: string): GateResult | undefined {
  if (raw === "pass" || raw === "fail") return raw;
  return undefined;
}

function parsePreference(raw: string): Preference | undefined {
  if (
    raw === "focus" || raw === "lean_focus" || raw === "balanced"
    || raw === "lean_variety" || raw === "variety"
  ) return raw;
  return undefined;
}

function parseHorizon(raw: string): Horizon | undefined {
  if (raw === "single" || raw === "short" || raw === "long") return raw;
  return undefined;
}

function labelType(type: UserType): string {
  if (type === "performance") return "运动表现";
  if (type === "occupational") return "职业体能";
  return "健身目的";
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

function numberField(input: unknown, key: string): number | undefined {
  if (!input || typeof input !== "object") return undefined;
  const value = (input as Record<string, unknown>)[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
