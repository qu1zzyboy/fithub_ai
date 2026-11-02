import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export type UserType = "fitness" | "performance" | "occupational";

export interface H1Payload {
  handoff_id: "H1";
  user_type: UserType;
  primary_module: string;
  secondary_modules: string[];
  match_trace: { quote: string; trigger: string; module: string }[];
  source: "dialog" | "survey";
  raw_quote: string;
  timestamp: string;
}

interface LexiconRow {
  module: string;
  fitness: string[];
  performance: string[];
  occupational: string[];
  generic: string[];
}

let cached: LexiconRow[] | null = null;

function lexicon(): LexiconRow[] {
  if (cached) return cached;
  const path = join(dirname(fileURLToPath(import.meta.url)), "../../agents/parent/module-lexicon.json");
  cached = JSON.parse(readFileSync(path, "utf8")) as LexiconRow[];
  return cached;
}

/** 最小 M1：用户类型 + 模块词库命中。判定不了类型时默认 fitness，并在 trace 里标明。 */
export function buildH1(input: {
  utterance: string;
  userType?: UserType;
  source?: "dialog" | "survey";
  now?: () => string;
}): H1Payload {
  const quote = input.utterance.trim();
  const userType = input.userType ?? inferUserType(quote);
  const hits = matchModules(quote, userType);
  const primary = hits[0]?.module ?? "m3";
  const secondary = hits.slice(1, 3).map((item) => item.module);
  return {
    handoff_id: "H1",
    user_type: userType,
    primary_module: primary,
    secondary_modules: secondary,
    match_trace: hits.slice(0, 5).map((item) => ({
      quote,
      trigger: item.trigger,
      module: item.module,
    })),
    source: input.source ?? "dialog",
    raw_quote: quote,
    timestamp: (input.now ?? (() => new Date().toISOString()))(),
  };
}

export function inferUserType(text: string): UserType {
  if (/消防|警察|军人|安保|救援|考核|出任务|岗位/.test(text)) return "occupational";
  if (/比赛|打球|跑步|游泳|滑雪|专项|对手|成绩|爆发|冲刺/.test(text)) return "performance";
  return "fitness";
}

function matchModules(text: string, userType: UserType): { module: string; trigger: string }[] {
  const scored: { module: string; trigger: string; index: number; score: number }[] = [];
  for (const row of lexicon()) {
    const column = [...row[userType], ...row.generic];
    for (const trigger of column) {
      if (!trigger) continue;
      const index = text.indexOf(trigger);
      if (index < 0) continue;
      scored.push({ module: row.module, trigger, index, score: trigger.length });
    }
  }
  // 先按原话出现先后，再按触发词长度
  scored.sort((a, b) => a.index - b.index || b.score - a.score);
  const seen = new Set<string>();
  const out: { module: string; trigger: string }[] = [];
  for (const item of scored) {
    if (seen.has(item.module)) continue;
    seen.add(item.module);
    out.push({ module: item.module, trigger: item.trigger });
  }
  return out;
}
