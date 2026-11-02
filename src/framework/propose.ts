import { readModelEnv, type ModelEnv } from "../parent/classify.ts";
import type { StationCall } from "./prompt/types.ts";

export async function answerWithModel(call: StationCall, env: ModelEnv = readModelEnv()): Promise<unknown> {
  const response = await fetch(`${env.baseUrl.replace(/\/+$/, "")}/v1/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": env.apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: env.model,
      max_tokens: 2048,
      system: call.system,
      messages: [{ role: "user", content: call.user }],
    }),
  });
  if (!response.ok) throw new Error(`框架判断失败: ${response.status}`);
  const body = await response.json() as { content?: { type?: string; text?: string }[] };
  const text = (body.content ?? []).filter((block) => block.type === "text").map((block) => block.text ?? "").join("\n");
  return parseJson(text);
}

function parseJson(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1)) as unknown;
  } catch {
    return null;
  }
}
