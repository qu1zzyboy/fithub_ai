import type { FrameworkReads, ParentReads, ReviewReads } from "./read.ts";
import type { ParentWrites } from "./write.ts";

export const WRITE_KEYS = ["mergeTags", "saveFramework", "savePlanChange"] as const;

const FRAMEWORK_KEYS = [
  "readStrategy",
  "readTags",
  "readAssessment",
  "readMovements",
  "readPlanTemplates",
  "readPeriodPlans",
  "readEligibility",
] as const satisfies readonly (keyof FrameworkReads)[];

const REVIEW_KEYS = [
  "readTrainingRecords",
  "readAssessment",
  "readMovementAbility",
  "readStrengthReserve",
  "readCurrentPlan",
] as const satisfies readonly (keyof ReviewReads)[];

const PARENT_KEYS = [
  "resolveAthlete",
  "checkPermission",
  "readInjuryTags",
  "assessmentExists",
  "callBusinessApi",
  "mergeTags",
  "saveFramework",
  "savePlanChange",
] as const;

export interface ParentTools extends ParentReads, ParentWrites {}

export function assertNoWrites(tools: object): void {
  for (const key of WRITE_KEYS) {
    if (Object.hasOwn(tools, key)) throw new Error(`子 agent 不能拿写工具：${key}`);
  }
}

export function frameworkTools(source: FrameworkReads): FrameworkReads {
  return pick(source, FRAMEWORK_KEYS);
}

export function reviewTools(source: ReviewReads): ReviewReads {
  return pick(source, REVIEW_KEYS);
}

export function parentTools(source: ParentTools): ParentTools {
  return pick(source, PARENT_KEYS);
}

function pick<T extends object, K extends readonly (keyof T)[]>(source: T, keys: K): Pick<T, K[number]> {
  const out = {} as Pick<T, K[number]>;
  for (const key of keys) {
    const value = source[key];
    if (typeof value !== "function") throw new Error(`缺少工具：${String(key)}`);
    out[key] = value.bind(source);
  }
  return out;
}
