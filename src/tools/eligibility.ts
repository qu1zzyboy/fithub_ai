import type { MovementRecord } from "./read.ts";

export interface InjuryContext {
  joints: string[];
  chronicConditions: string[];
}

export type EligibilityVerdict = { allowed: true } | { allowed: false; reason: string };

/** 固定规则。模型、沙盒和记忆都不能改这个结果。 */
export function judgeEligibility(movement: MovementRecord, injuries: InjuryContext): EligibilityVerdict {
  const blocked = [...injuries.joints, ...injuries.chronicConditions];
  const hit = movement.contraindications.find((item) => blocked.includes(item));
  if (hit) return { allowed: false, reason: `禁忌：${hit}` };
  return { allowed: true };
}
