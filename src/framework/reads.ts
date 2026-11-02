import { isExperienceLevel, type ExperienceLevel } from "../parent/state.ts";
import { judgeEligibility } from "../tools/eligibility.ts";
import type {
  AssessmentRecord,
  AthleteTags,
  FrameworkReads,
  MovementQuery,
  MovementRecord,
} from "../tools/read.ts";
import { equipmentMatches, loadMovementLibrary } from "./library.ts";

const PATTERN_CODES: Record<string, string[]> = {
  蹲: ["SQUAT"],
  弓步: ["LUNGE"],
  核心: ["CORE"],
  推: ["PUSH", "PRESS"],
  拉: ["PULL", "ROW"],
  铰链: ["HINGE"],
  旋转: ["ROTATION"],
  跳: ["JUMP"],
};

export interface ChatReads {
  readUser(input: { token: string; userId: string }): Promise<{ tags: string[] } | null>;
  hasAssessment(input: { token: string; userId: string }): Promise<boolean>;
  listPeriodPlans(input: { token: string; clientId: string }): Promise<{ id: string; name: string; days: number }[]>;
}

export function createChatFrameworkReads(input: {
  token: string;
  clientId: string;
  business: ChatReads;
  library?: readonly MovementRecord[];
}): FrameworkReads {
  const library = input.library ? [...input.library] : loadMovementLibrary();
  return {
    async readStrategy() {
      return null;
    },
    async readTags(athleteId) {
      const user = await input.business.readUser({ token: input.token, userId: athleteId });
      return tagsFrom(user?.tags ?? []);
    },
    async readAssessment(athleteId) {
      const exists = await input.business.hasAssessment({ token: input.token, userId: athleteId });
      if (!exists) return null;
      const tags = tagsFrom((await input.business.readUser({ token: input.token, userId: athleteId }))?.tags ?? []);
      const record: AssessmentRecord = {
        id: athleteId,
        joints: tags.关节问题,
        chronicConditions: tags.慢性病,
        summary: "评估在库。详情未接入，断点只根据已写明的约束来写。",
      };
      return record;
    },
    async readMovements(query) {
      return filterMovements(library, query);
    },
    async readPlanTemplates() {
      return [];
    },
    async readPeriodPlans(query) {
      try {
        const plans = await input.business.listPeriodPlans({ token: input.token, clientId: input.clientId });
        return plans
          .map((plan) => ({ id: plan.id, name: plan.name, cycleWeeks: weeksOf(plan.days) }))
          .filter((plan) => Math.abs(plan.cycleWeeks - query.cycleWeeks) <= 2)
          .slice(0, 8);
      } catch {
        return [];
      }
    },
    async readEligibility(query) {
      const injuries = { joints: [...query.joints], chronicConditions: [...query.chronicConditions] };
      return query.movementIds.map((movementId) => {
        const movement = library.find((item) => item.id === movementId);
        if (!movement) return { movementId, allowed: false, reason: "不在动作库" };
        const verdict = judgeEligibility(movement, injuries);
        return verdict.allowed ? { movementId, allowed: true } : { movementId, allowed: false, reason: verdict.reason };
      });
    },
  };
}

export function filterMovements(library: readonly MovementRecord[], query: MovementQuery): MovementRecord[] {
  const byEquipment = library.filter((movement) => equipmentMatches(movement, query.equipment));
  if (query.patterns.length === 0) return byEquipment;
  const codes = query.patterns.flatMap((pattern) => PATTERN_CODES[pattern] ?? []);
  if (codes.length === 0) return byEquipment;
  const matched = byEquipment.filter((movement) => movement.patterns.some((pattern) => codes.includes(pattern.toUpperCase())));
  return matched.length > 0 ? matched : byEquipment;
}

function tagsFrom(tags: string[]): AthleteTags {
  const joints: string[] = [];
  const chronicConditions: string[] = [];
  const goals: string[] = [];
  let level: ExperienceLevel | undefined;
  let goalNote: string | undefined;
  let chronicNote: string | undefined;
  for (const tag of tags) {
    if (tag.startsWith("关节问题:") && tag !== "关节问题:无") joints.push(tag.slice("关节问题:".length));
    else if (tag.startsWith("慢性病:") && tag !== "慢性病:无") chronicConditions.push(tag.slice("慢性病:".length));
    else if (tag.startsWith("慢性病备注:")) chronicNote = tag.slice("慢性病备注:".length);
    else if (tag.startsWith("训练目标:")) goals.push(tag.slice("训练目标:".length));
    else if (tag.startsWith("训练目标备注:")) goalNote = tag.slice("训练目标备注:".length);
    else if (tag.startsWith("训练经验:")) {
      const value = tag.slice("训练经验:".length);
      if (isExperienceLevel(value)) level = value;
    }
  }
  return {
    关节问题: joints,
    慢性病: chronicConditions,
    ...(goals.length > 0 ? { 训练目标: goals } : {}),
    ...(goalNote ? { 训练目标备注: goalNote } : {}),
    ...(level ? { 训练经验: level } : {}),
    ...(chronicNote ? { 慢性病备注: chronicNote } : {}),
  };
}

function weeksOf(days: number): number {
  if (!Number.isInteger(days) || days < 1) return 1;
  return Math.max(1, Math.round(days / 7));
}
