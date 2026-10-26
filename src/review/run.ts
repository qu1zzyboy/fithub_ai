import type { PlanChange, ReviewResult, ReviewTask } from "../parent/state.ts";
import { judgeEligibility, type InjuryContext } from "../tools/eligibility.ts";
import type {
  AssessmentRecord,
  CurrentPlan,
  MovementAbility,
  ReviewReads,
  StrengthReserve,
  TrainingRecord,
} from "../tools/read.ts";
import { assertNoWrites, reviewTools } from "../tools/sets.ts";
import { summarizeTraining, type TrainingMetrics } from "./metrics.ts";
import { runSandbox, type SandboxRow } from "./sandbox.ts";

export interface ReviewFacts {
  athleteId: string;
  athleteName: string;
  range: string;
  report: boolean;
  chart: boolean;
  proposeChange: boolean;
  memorySummary?: string;
  metrics: TrainingMetrics;
  figure?: string;
  assessment: AssessmentRecord | null;
  movementAbility: MovementAbility[];
  strengthReserve: StrengthReserve[];
  currentPlan: CurrentPlan | null;
  records: TrainingRecord[];
}

export interface ReviewDraft {
  summary: string;
  report?: string;
  change: PlanChange | null;
}

export async function runReviewAgent(
  task: ReviewTask,
  tools: ReviewReads,
  compose: (facts: ReviewFacts) => Promise<ReviewDraft>,
  sandbox: (rows: readonly SandboxRow[]) => { figure: string } = runSandbox,
): Promise<ReviewResult> {
  assertNoWrites(tools);
  const reads = reviewTools(tools);
  const [records, assessment, movementAbility, strengthReserve, currentPlan] = await Promise.all([
    reads.readTrainingRecords(task.athleteId, task.range),
    reads.readAssessment(task.athleteId),
    reads.readMovementAbility(task.athleteId),
    reads.readStrengthReserve(task.athleteId),
    reads.readCurrentPlan(task.athleteId),
  ]);
  const metrics = summarizeTraining(records);
  const figure = task.chart ? sandbox(records.map(({ id, at, note }) => ({ id, at, note }))).figure : undefined;
  const facts: ReviewFacts = {
    athleteId: task.athleteId,
    athleteName: task.athleteName,
    range: task.range,
    report: task.report,
    chart: task.chart,
    proposeChange: task.proposeChange,
    memorySummary: task.memorySummary,
    metrics,
    figure,
    assessment,
    movementAbility,
    strengthReserve,
    currentPlan,
    records,
  };
  const drafted = await compose(structuredClone(facts));
  const change = task.proposeChange ? filterChange(drafted.change, assessment, currentPlan) : null;
  const rejected = Boolean(task.proposeChange && drafted.change?.movementIds?.length && change === null);
  const summary = rejected
    ? `${drafted.summary} 禁忌规则拒绝了改法里的动作，没有可写入的改法。`
    : drafted.summary;
  return {
    summary,
    report: task.report ? drafted.report : undefined,
    chart: figure,
    change,
  };
}

function filterChange(
  change: PlanChange | null,
  assessment: AssessmentRecord | null,
  plan: CurrentPlan | null,
): PlanChange | null {
  if (!change) return null;
  if (!change.movementIds) return change;
  if (!assessment) return null;
  const injuries: InjuryContext = { joints: assessment.joints, chronicConditions: assessment.chronicConditions };
  const kept = change.movementIds.filter((id) => {
    const movement = plan?.movements.find((item) => item.id === id);
    return Boolean(movement && judgeEligibility(movement, injuries).allowed);
  });
  if (kept.length === 0) return null;
  return { ...change, movementIds: kept };
}
