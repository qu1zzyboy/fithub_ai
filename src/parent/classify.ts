import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Decision } from "./ports.ts";
import type { ParentState } from "./state.ts";

export interface ModelEnv {
  apiKey: string;
  baseUrl: string;
  model: string;
}

const SYSTEM = `你只做主 agent 的意图分类。只返回一个 JSON 对象，不要 Markdown。

intent 只能是：
- unrelated：和运动无关
- unclear：分不清是排课还是复盘
- session：发这一次课，或补热身、进退阶、强度
- premature-write：还没确认就要把框架或改法写入
- api：其他运动问题，不排课也不复盘。needsAthlete 表示要不要读学员
- confirm：确认当前待写入的框架或改法
- revise：不确认，要改口
- framework：往下排课。可带 athleteName，以及 strategy 里已经说清的字段
- review：看已经练过的。range 是时间范围；report、chart、proposeChange 为布尔。只说看看时 proposeChange 必须是 false

strategy.level 只能是：无训练史、<6个月、6个月-2年、2-5年、>5年。
strategy.injuryConfirmed 只有教练明确确认伤病或确认无时才为 true。`;

/** 用环境里的 Anthropic 兼容模型做分类。循环本身不依赖这次调用。 */
export async function classifyWithModel(input: {
  utterance: string;
  state: ParentState;
}, env: ModelEnv = readModelEnv()): Promise<Decision> {
  const response = await fetch(messagesUrl(env.baseUrl), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": env.apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: env.model,
      max_tokens: 1024,
      system: SYSTEM,
      messages: [
        {
          role: "user",
          content: `当前状态：${JSON.stringify(publicState(input.state))}\n教练这句话：${input.utterance}`,
        },
      ],
    }),
  });
  if (!response.ok) {
    throw new Error(`模型分类失败: ${response.status}`);
  }
  const body = await response.json() as { content?: { type?: string; text?: string }[] };
  const text = (body.content ?? []).filter((block) => block.type === "text").map((block) => block.text ?? "").join("\n");
  return parseDecision(text);
}

export function parseDecision(text: string): Decision {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return { intent: "unclear" };
  try {
    const parsed = JSON.parse(text.slice(start, end + 1)) as { intent?: string };
    if (!parsed.intent) return { intent: "unclear" };
    return parsed as Decision;
  } catch {
    return { intent: "unclear" };
  }
}

export function readModelEnv(startDirectory = process.cwd()): ModelEnv {
  const file = findEnvFile(startDirectory);
  const fromFile = file ? parseEnv(readFileSync(file, "utf8")) : {};
  const apiKey = process.env.ANTHROPIC_API_KEY || fromFile.ANTHROPIC_API_KEY;
  const baseUrl = process.env.ANTHROPIC_BASE_URL || fromFile.ANTHROPIC_BASE_URL;
  const model = process.env.CLAUDE_MODEL || fromFile.CLAUDE_MODEL;
  if (!apiKey || !baseUrl || !model) throw new Error("缺少 ANTHROPIC_API_KEY、ANTHROPIC_BASE_URL 或 CLAUDE_MODEL");
  return { apiKey, baseUrl, model };
}

function publicState(state: ParentState): unknown {
  return {
    athleteName: state.athlete?.name ?? null,
    injuryConfirmed: state.strategy?.injuryConfirmed ?? false,
    pending: state.pending?.kind ?? null,
  };
}

function messagesUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/v1/messages`;
}

function findEnvFile(startDirectory: string): string | null {
  let directory = startDirectory;
  for (let depth = 0; depth < 6; depth += 1) {
    const candidate = join(directory, ".env.local");
    try {
      readFileSync(candidate);
      return candidate;
    } catch {
      const parent = dirname(directory);
      if (parent === directory) return null;
      directory = parent;
    }
  }
  return null;
}

function parseEnv(text: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const index = trimmed.indexOf("=");
    const key = trimmed.slice(0, index).trim();
    values[key] = trimmed.slice(index + 1).trim().replace(/^['"]|['"]$/g, "");
  }
  return values;
}
