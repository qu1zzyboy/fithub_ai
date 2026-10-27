import type { FrameworkResult, FrameworkSlot, FrameworkTask, MovementParams } from "../parent/state.ts";
import { judgeEligibility } from "../tools/eligibility.ts";
import type {
  AssessmentRecord,
  AthleteTags,
  ConfirmedStrategy,
  FrameworkReads,
  MovementRecord,
  PeriodPlan,
  PlanTemplate,
} from "../tools/read.ts";
import { assertNoWrites, frameworkTools } from "../tools/sets.ts";

export interface FrameworkContext {
  athleteId: string;
  athleteName: string;
  strategy: ConfirmedStrategy;
  injuries: FrameworkTask["injuries"];
  tags: AthleteTags;
  assessment: AssessmentRecord;
  templates: PlanTemplate[];
  periodPlans: PeriodPlan[];
  movements: MovementRecord[];
  memorySummary?: string;
}

export interface ProposedSlot {
  slotId: string;
  pattern: string;
  movementId?: string;
  params?: MovementParams;
}

export interface FrameworkProposal {
  slots: ProposedSlot[];
}

export async function runFrameworkAgent(
  task: FrameworkTask,
  tools: FrameworkReads,
  propose: (context: FrameworkContext) => Promise<FrameworkProposal>,
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
  const [templates, periodPlans, movements] = await Promise.all([
    reads.readPlanTemplates({ trainingType: strategy.trainingType, modules: strategy.trainingModules }),
    reads.readPeriodPlans({ cycleWeeks: strategy.cycleWeeks }),
    reads.readMovements({ equipment: strategy.equipment, patterns: strategy.movementPatterns ?? [] }),
  ]);
  await reads.readEligibility({
    movementIds: movements.map((item) => item.id),
    joints: task.injuries.joints,
    chronicConditions: task.injuries.chronicConditions,
  });

  const context: FrameworkContext = {
    athleteId: task.athleteId,
    athleteName: task.athleteName,
    strategy,
    injuries: task.injuries,
    tags,
    assessment,
    templates,
    periodPlans,
    movements,
    memorySummary: task.memorySummary,
  };
  const proposal = await propose(structuredClone(context));
  const slots = proposal.slots.map((slot) => acceptSlot(slot, movements, task.injuries));
  return { summary: summarize(slots), slots };
}

function acceptSlot(
  slot: ProposedSlot,
  movements: readonly MovementRecord[],
  injuries: FrameworkTask["injuries"],
): FrameworkSlot {
  if (!slot.movementId) return { slotId: slot.slotId, pattern: slot.pattern, unfilledReason: "未填动作" };
  const movement = movements.find((item) => item.id === slot.movementId);
  if (!movement) return { slotId: slot.slotId, pattern: slot.pattern, unfilledReason: "不在动作库" };
  const verdict = judgeEligibility(movement, injuries);
  if (!verdict.allowed) return { slotId: slot.slotId, pattern: slot.pattern, unfilledReason: verdict.reason };
  return { slotId: slot.slotId, pattern: slot.pattern, movementId: movement.id, params: slot.params };
}

function summarize(slots: FrameworkSlot[]): string {
  if (slots.length === 0) return "没有排出 Slot。";
  const filled = slots.filter((slot) => slot.movementId).length;
  const base = `框架 ${slots.length} 个 Slot，${filled} 个已填动作。`;
  const unfilled = slots.filter((slot) => !slot.movementId);
  if (unfilled.length === 0) return base;
  const detail = unfilled.map((slot) => `${slot.slotId}（${slot.unfilledReason}）`).join("、");
  return `${base}未填：${detail}。`;
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
