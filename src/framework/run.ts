import type {
  DemandSet,
  FrameworkResult,
  FrameworkSlot,
  FrameworkTask,
  SlotDraft,
} from "../parent/state.ts";
import { judgeEligibility } from "../tools/eligibility.ts";
import type {
  AssessmentRecord,
  AthleteTags,
  ConfirmedStrategy,
  FrameworkReads,
  MovementRecord,
} from "../tools/read.ts";
import { assertNoWrites, frameworkTools } from "../tools/sets.ts";
import { movementNames } from "./library.ts";
import { compileRepair, compileStation, readPolicy, type CaseFile } from "./prompt/compile.ts";
import { loadCards, resolvedBand, selectCards } from "./prompt/select-cards.ts";
import type { CandidateMovement, StationCall, StationId } from "./prompt/types.ts";
import { validateStation, type StationVerdict } from "./prompt/validate.ts";

const STATION_LABEL: Record<StationId, string> = {
  "demand-set": "需求集",
  "demand-items": "需求条目",
  diagnosis: "诊断",
  slots: "课表",
};

export interface FrameworkAgentDeps {
  answer(call: StationCall): Promise<unknown>;
}

export async function runFrameworkAgent(
  task: FrameworkTask,
  tools: FrameworkReads,
  deps: FrameworkAgentDeps,
): Promise<FrameworkResult> {
  assertNoWrites(tools);
  const reads = frameworkTools(tools);
  const gaps = frameworkGaps(task);
  if (gaps.length > 0) return { summary: `排课还缺：${gaps.join("、")}。`, slots: [] };

  const [strategyRow, tags, assessment] = await Promise.all([
    reads.readStrategy(task.athleteId),
    reads.readTags(task.athleteId),
    reads.readAssessment(task.athleteId),
  ]);
  if (!assessment) return { summary: "评估不在库，不能排课。", slots: [] };

  const strategy = strategyRow ?? task.strategy;
  const names = movementNames();
  const cards = loadCards();
  let bounceReason: string | undefined;

  for (let pass = 0; pass < 2; pass += 1) {
    const built = await runPass({
      task,
      reads,
      strategy,
      tags,
      assessment,
      names,
      cards,
      bounceReason,
      answer: deps.answer,
    });
    if (built.kind === "stop" || built.kind === "ok") return built.result;
    bounceReason = built.reasonTag;
  }

  return { summary: `容量超出本周频率，原因：${bounceReason}。`, slots: [] };
}

async function runPass(input: {
  task: FrameworkTask;
  reads: FrameworkReads;
  strategy: ConfirmedStrategy;
  tags: AthleteTags;
  assessment: AssessmentRecord;
  names: string[];
  cards: ReturnType<typeof loadCards>;
  bounceReason: string | undefined;
  answer: FrameworkAgentDeps["answer"];
}): Promise<{ kind: "ok" | "stop"; result: FrameworkResult } | { kind: "return"; reasonTag: string }> {
  const band = resolvedBand(input.strategy);
  const base: CaseFile = {
    athleteName: input.task.athleteName,
    strategy: input.strategy,
    injuries: input.task.injuries,
    assessmentSummary: input.assessment.summary,
    tags: input.tags,
    resolved: band,
    ...(input.task.memorySummary ? { memorySummary: input.task.memorySummary } : {}),
    ...(input.bounceReason ? { bounceReason: input.bounceReason } : {}),
  };

  const demand = await ask(input, "demand-set", base);
  if (demand.kind !== "ok" || !("demandSet" in demand)) return stopOrReturn(demand, "demand-set");
  const items = await ask(input, "demand-items", { ...base, demandSet: demand.demandSet });
  if (items.kind !== "ok" || !("demandItems" in items)) return stopOrReturn(items, "demand-items");
  const diagnosis = await ask(input, "diagnosis", { ...base, demandSet: demand.demandSet, demandItems: items.demandItems });
  if (diagnosis.kind !== "ok" || !("diagnosis" in diagnosis)) return stopOrReturn(diagnosis, "diagnosis");

  const [periodPlans, movements] = await Promise.all([
    input.reads.readPeriodPlans({ cycleWeeks: input.strategy.cycleWeeks }),
    input.reads.readMovements({ equipment: input.strategy.equipment, patterns: input.strategy.movementPatterns ?? [] }),
  ]);
  await input.reads.readPlanTemplates({ trainingType: input.strategy.trainingType, modules: input.strategy.trainingModules });
  await input.reads.readEligibility({
    movementIds: movements.map((item) => item.id),
    joints: input.task.injuries.joints,
    chronicConditions: input.task.injuries.chronicConditions,
  });
  const candidates = movements
    .filter((movement) => judgeEligibility(movement, input.task.injuries).allowed)
    .map(toCandidate);
  if (candidates.length === 0) {
    return {
      kind: "stop",
      result: {
        summary: "没有可填的动作。",
        slots: [],
        demandSet: demand.demandSet,
        demandItems: items.demandItems,
        diagnosis: diagnosis.diagnosis,
      },
    };
  }

  const slotted = await ask(input, "slots", {
    ...base,
    demandSet: demand.demandSet,
    demandItems: items.demandItems,
    diagnosis: diagnosis.diagnosis,
    candidates,
    periodPlans,
  });
  if (slotted.kind === "return") return slotted;
  if (slotted.kind !== "ok" || !("slots" in slotted)) return stopOrReturn(slotted, "slots");

  const slots = slotted.slots.map((slot) => acceptSlot(slot, movements, input.task.injuries));
  return {
    kind: "ok",
    result: {
      summary: summarize(slots, demand.demandSet),
      slots,
      demandSet: demand.demandSet,
      demandItems: items.demandItems,
      diagnosis: diagnosis.diagnosis,
      slotRuleIds: slotted.appliedRuleIds,
    },
  };
}

async function ask(input: {
  names: string[];
  cards: ReturnType<typeof loadCards>;
  strategy: ConfirmedStrategy;
  task: FrameworkTask;
  answer: FrameworkAgentDeps["answer"];
}, station: StationId, caseFile: CaseFile): Promise<StationVerdict> {
  const band = caseFile.resolved;
  const selected = selectCards(input.cards, { station, experience: band.experience, population: band.population });
  const compiled = compileStation({ station, cards: selected, caseFile });
  const context = {
    cardIds: compiled.cardIds,
    names: input.names,
    frequency: input.strategy.frequencyPerWeek,
    movementsPerSession: band.movementsPerSession,
    injuryJoints: input.task.injuries.joints,
  };
  let raw = await input.answer({ station, system: compiled.system, user: compiled.user, cardIds: compiled.cardIds, repair: false });
  let verdict = validateStation(station, raw, context);
  if (verdict.kind === "violations") {
    raw = await input.answer({
      station,
      system: readPolicy(),
      user: compileRepair(verdict.violations, raw),
      cardIds: compiled.cardIds,
      repair: true,
    });
    verdict = validateStation(station, raw, context);
  }
  return verdict;
}

function stopOrReturn(
  verdict: StationVerdict,
  station: StationId,
): { kind: "stop"; result: FrameworkResult } | { kind: "return"; reasonTag: string } {
  if (verdict.kind === "return") return verdict;
  if (verdict.kind === "gap") {
    return { kind: "stop", result: { summary: `排课还缺：${verdict.missing.join("、")}。`, slots: [] } };
  }
  if (verdict.kind === "violations") {
    const detail = verdict.violations.map((item) => `${item.code} ${item.detail}`).join("；");
    return { kind: "stop", result: { summary: `框架停在${STATION_LABEL[station]}：${detail}。`, slots: [] } };
  }
  return { kind: "stop", result: { summary: `框架停在${STATION_LABEL[station]}。`, slots: [] } };
}

function acceptSlot(slot: SlotDraft, movements: readonly MovementRecord[], injuries: FrameworkTask["injuries"]): FrameworkSlot {
  const kept = {
    slotId: slot.slotId,
    pattern: slot.pattern,
    ...(slot.session ? { session: slot.session } : {}),
    ...(slot.anchor ? { anchor: slot.anchor } : {}),
    ...(slot.patternFamily ? { patternFamily: slot.patternFamily } : {}),
    ...(slot.constraints ? { constraints: slot.constraints } : {}),
    ...(slot.role ? { role: slot.role } : {}),
  };
  if (!slot.movementId) return { ...kept, unfilledReason: slot.unfilledReason ?? "未填动作" };
  const movement = movements.find((item) => item.id === slot.movementId);
  if (!movement) return { ...kept, unfilledReason: "不在动作库" };
  const verdict = judgeEligibility(movement, injuries);
  if (!verdict.allowed) return { ...kept, unfilledReason: verdict.reason };
  return { ...kept, movementId: movement.id };
}

function summarize(slots: FrameworkSlot[], demandSet: DemandSet): string {
  const primary = demandSet.items.filter((item) => item.role === "primary").reduce((sum, item) => sum + item.share, 0);
  if (slots.length === 0) return `没有排出 Slot。主模块占比 ${primary}%。`;
  const filled = slots.filter((slot) => slot.movementId).length;
  const base = `框架 ${slots.length} 个 Slot，${filled} 个已填动作。主模块占比 ${primary}%。`;
  const unfilled = slots.filter((slot) => !slot.movementId);
  if (unfilled.length === 0) return base;
  const detail = unfilled.map((slot) => `${slot.slotId}（${slot.unfilledReason}）`).join("、");
  return `${base}未填：${detail}。`;
}

function toCandidate(movement: MovementRecord): CandidateMovement {
  return { id: movement.id, name: movement.name, patterns: movement.patterns };
}

function frameworkGaps(task: FrameworkTask): string[] {
  const gaps: string[] = [];
  if (!task.athleteId) gaps.push("学员");
  const hasType = Boolean(task.strategy.trainingType?.trim());
  const hasModules = Boolean(task.strategy.trainingModules && task.strategy.trainingModules.length > 0);
  if (!hasType && !hasModules) gaps.push("训练类型或模块");
  if (!Number.isInteger(task.strategy.frequencyPerWeek) || task.strategy.frequencyPerWeek < 1) gaps.push("每周频率");
  if (!Number.isInteger(task.strategy.cycleWeeks) || task.strategy.cycleWeeks < 1) gaps.push("周期");
  if (!task.strategy.level) gaps.push("训练水平");
  if (!task.strategy.equipment || task.strategy.equipment.length === 0) gaps.push("器械");
  return gaps;
}
