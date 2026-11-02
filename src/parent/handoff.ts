import type { HandoffPayload } from "../tools/dispatch.ts";
import type { CoachDecision } from "./ports.ts";

/** 把 ReAct dispatch 载荷折成旧主循环能吃的决定，不再二次分类。 */
export function decisionFromHandoff(payload: HandoffPayload): CoachDecision {
  if (payload.target === "framework") {
    return {
      intent: "framework",
      athleteName: payload.athleteName,
      strategy: strategyHint(payload.note),
    };
  }
  return {
    intent: "review",
    athleteName: payload.athleteName,
    range: payload.range,
    report: payload.report ?? false,
    chart: payload.chart ?? false,
    proposeChange: payload.proposeChange ?? false,
  };
}

function strategyHint(note: string | undefined): { trainingType?: string } | undefined {
  const text = note?.trim();
  if (!text) return undefined;
  // 只从 note 里认一眼训练类型，其余仍走策略门禁追问。
  const types = ["力量", "体能", "康复", "减脂", "增肌", "有氧", "爆发力"];
  const hit = types.find((item) => text.includes(item));
  return hit ? { trainingType: hit } : undefined;
}
