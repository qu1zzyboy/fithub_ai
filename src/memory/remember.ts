import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readModelEnv, type ModelEnv } from "../parent/classify.ts";
import {
  acceptMemory,
  parseMemoryNotes,
  readMemoryIndex,
  writeMemory,
  type MemoryCandidate,
} from "./store.ts";

const EXTRACT = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../agents/parent/memory-extract.md"), "utf8");

export interface RememberInput {
  utterance: string;
  reply: string;
  coachId: string;
  athleteId: string | null;
}

export async function rememberTurn(input: RememberInput & {
  root: string;
  today: string;
  propose: (context: ProposeContext) => Promise<MemoryCandidate[]>;
}): Promise<void> {
  const index = readMemoryIndex(input.root, input, input.today);
  let notes: MemoryCandidate[] = [];
  try {
    notes = await input.propose({
      utterance: input.utterance,
      reply: input.reply,
      athleteBound: Boolean(input.athleteId),
      index,
    });
  } catch {
    return;
  }
  for (const candidate of notes.slice(0, 3)) {
    const verdict = acceptMemory(candidate, input);
    if (!verdict.ok) continue;
    writeMemory(input.root, input, verdict.note);
  }
}

export interface ProposeContext {
  utterance: string;
  reply: string;
  athleteBound: boolean;
  index: string;
}

export async function proposeMemories(context: ProposeContext, env: ModelEnv = readModelEnv()): Promise<MemoryCandidate[]> {
  const response = await fetch(`${env.baseUrl.replace(/\/+$/, "")}/v1/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": env.apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: env.model,
      max_tokens: 1024,
      system: EXTRACT,
      messages: [{ role: "user", content: proposeText(context) }],
    }),
  });
  if (!response.ok) throw new Error(`记忆抽取失败: ${response.status}`);
  const body = await response.json() as { content?: { type?: string; text?: string }[] };
  const text = (body.content ?? []).filter((block) => block.type === "text").map((block) => block.text ?? "").join("\n");
  return parseMemoryNotes(text);
}

function proposeText(context: ProposeContext): string {
  return [
    `已有索引：\n${context.index.trim() || "无"}`,
    `这一轮绑了学员：${context.athleteBound ? "是" : "否"}`,
    `教练原话：\n${context.utterance}`,
    `给教练的回复：\n${context.reply}`,
  ].join("\n\n");
}
