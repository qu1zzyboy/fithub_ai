import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { CoachDecision } from "./ports.ts";
import type { ParentState } from "./state.ts";

export interface ModelEnv {
  apiKey: string;
  baseUrl: string;
  model: string;
}

const SYSTEM = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../agents/parent/prompt.md"), "utf8");

/** 用环境里的 Anthropic 兼容模型做分类。循环本身不依赖这次调用。 */
export async function classifyWithModel(input: {
  utterance: string;
  state: ParentState;
  memoryIndex?: string;
}, env: ModelEnv = readModelEnv()): Promise<CoachDecision> {
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
          content: classifyUserText(input),
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

export function parseDecision(text: string): CoachDecision {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return { intent: "unclear" };
  try {
    const parsed = JSON.parse(text.slice(start, end + 1)) as { intent?: string; reply?: unknown };
    if (!parsed.intent) return { intent: "unclear" };
    const decision = parsed as CoachDecision;
    if (typeof parsed.reply === "string") decision.reply = parsed.reply.trim();
    else delete decision.reply;
    return decision;
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

export function classifyUserText(input: {
  utterance: string;
  state: ParentState;
  memoryIndex?: string;
}): string {
  const index = input.memoryIndex?.trim() || "无";
  return `当前状态：${JSON.stringify(publicState(input.state))}\n记忆索引：\n${index}\n教练这句话：${input.utterance}`;
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
