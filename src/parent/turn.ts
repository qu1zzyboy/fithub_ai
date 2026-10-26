import type { Decision, ParentPorts } from "./ports.ts";
import {
  isExperienceLevel,
  type FrameworkTask,
  type ParentState,
  type ReviewTask,
  type StrategyDraft,
  type TagMerge,
} from "./state.ts";

export interface TurnResult {
  state: ParentState;
  reply: string;
}

/**
 * 主 agent 的一轮。
 * 分类、读写和子 agent 都从 ports 进来。写库只发生在策略确认和教练确认之后。
 */
export async function runParentTurn(
  state: ParentState,
  utterance: string,
  ports: ParentPorts,
): Promise<TurnResult> {
  const decision = await ports.classify({ utterance, state });
  let next = cloneState(state);

  if (decision.intent === "unrelated") {
    return done(next, "这件我做不了。");
  }
  if (decision.intent === "session") {
    return done(next, "发这一次课还不在这一版里。");
  }
  if (decision.intent === "premature-write") {
    return done(next, "还没确认，不能写入。");
  }
  if (decision.intent === "unclear") {
    return done(next, "你是要往下排课，还是看已经练过的？");
  }
  if (decision.intent === "confirm") return confirmPending(next, ports);
  if (decision.intent === "revise") {
    next.pending = null;
    return done(next, "还没写入。直接说要改的地方，我再排一次。");
  }

  const athleteName = "athleteName" in decision ? decision.athleteName : undefined;
  const needsAthlete = decision.intent !== "api" || decision.needsAthlete;
  if (needsAthlete) {
    const bound = await bindAthlete(next, athleteName, ports);
    if (bound.stop) return done(bound.state, bound.stop);
    next = bound.state;
  }

  if (decision.intent === "api") {
    const text = await ports.callBusinessApi({
      coachId: next.coachId,
      athleteId: next.athlete?.id ?? null,
      utterance,
    });
    return done(next, text);
  }

  if (decision.intent === "review") {
    if (!next.athlete) return done(next, "请先告诉我学员名称。");
    if (!decision.range) return done(next, "要看哪一次，或哪一段时间？");
    const task: ReviewTask = {
      athleteId: next.athlete.id,
      athleteName: next.athlete.name,
      range: decision.range,
      report: decision.report ?? false,
      chart: decision.chart ?? false,
      proposeChange: decision.proposeChange ?? false,
    };
    const result = await ports.runReview(task);
    if (!task.proposeChange) result.change = null;
    next.pending = { kind: "review", task, result };
    return done(next, result.summary);
  }

  next.strategy = applyStrategy(next.strategy, decision.strategy);
  if (!next.strategy.injuryConfirmed) {
    const tags = await ports.readInjuryTags(next.athlete!.id);
    const joints = tags.joints.length > 0 ? tags.joints.join("、") : "无";
    const chronic = tags.chronicConditions.length > 0 ? tags.chronicConditions.join("、") : "无";
    return done(next, `档案里的关节问题：${joints}。慢性病：${chronic}。有则改完再确认，没有就确认无。`);
  }

  const gaps = strategyGaps(next.strategy);
  if (gaps.length > 0) return done(next, `排课还缺：${gaps.join("、")}。`);

  const assessmentInLibrary = await ports.assessmentExists(next.athlete!.id);
  if (!assessmentInLibrary) return done(next, "评估不在库，不能排课。");

  const task = toFrameworkTask(next);
  await ports.mergeTags(next.athlete!.id, toTagMerge(next.strategy));
  const result = await ports.runFramework(task);
  next.pending = { kind: "framework", task, result };
  return done(next, result.summary);
}

async function confirmPending(state: ParentState, ports: ParentPorts): Promise<TurnResult> {
  const pending = state.pending;
  if (!pending || !state.athlete) return done(state, "现在没有待确认的内容。");
  if (pending.kind === "framework") {
    await ports.saveFramework(state.athlete.id, pending.result);
    return done({ ...state, pending: null }, "框架已写入。");
  }
  if (pending.result.change) {
    await ports.savePlanChange(state.athlete.id, pending.result.change);
    return done({ ...state, pending: null }, "计划和参数已写入。");
  }
  return done({ ...state, pending: null }, "这次只作查看，没有要写入的改法。");
}

async function bindAthlete(
  state: ParentState,
  athleteName: string | undefined,
  ports: ParentPorts,
): Promise<{ state: ParentState; stop?: string }> {
  if (!athleteName) {
    if (state.athlete) return { state };
    return { state, stop: "请先告诉我学员名称。" };
  }
  const athlete = await ports.resolveAthlete(athleteName);
  if (!athlete) return { state, stop: "对不上这名学员。" };
  const allowed = await ports.checkPermission(state.coachId, athlete.id);
  if (!allowed) return { state, stop: "没有这名学员的权限。" };
  return { state: { ...state, athlete } };
}

function applyStrategy(current: StrategyDraft | null, patch: Partial<StrategyDraft> | undefined): StrategyDraft {
  const base: StrategyDraft = current ?? { injuryConfirmed: false, joints: [], chronicConditions: [] };
  if (!patch) return base;
  return {
    ...base,
    ...patch,
    joints: patch.joints ?? base.joints,
    chronicConditions: patch.chronicConditions ?? base.chronicConditions,
    injuryConfirmed: patch.injuryConfirmed ?? base.injuryConfirmed,
  };
}

function strategyGaps(strategy: StrategyDraft): string[] {
  const gaps: string[] = [];
  const hasType = Boolean(strategy.trainingType?.trim());
  const hasModules = Boolean(strategy.trainingModules && strategy.trainingModules.length > 0);
  if (!hasType && !hasModules) gaps.push("训练类型或模块");
  if (!Number.isInteger(strategy.frequencyPerWeek) || (strategy.frequencyPerWeek ?? 0) < 1) gaps.push("每周频率");
  if (!Number.isInteger(strategy.cycleWeeks) || (strategy.cycleWeeks ?? 0) < 1) gaps.push("周期");
  if (!isExperienceLevel(strategy.level)) gaps.push("训练水平");
  if (!strategy.equipment || strategy.equipment.length === 0) gaps.push("器械");
  return gaps;
}

function toFrameworkTask(state: ParentState): FrameworkTask {
  const strategy = state.strategy!;
  const athlete = state.athlete!;
  return {
    athleteId: athlete.id,
    athleteName: athlete.name,
    strategy: {
      trainingType: strategy.trainingType,
      trainingModules: strategy.trainingModules,
      population: strategy.population,
      teachingForm: strategy.teachingForm,
      frequencyPerWeek: strategy.frequencyPerWeek!,
      cycleWeeks: strategy.cycleWeeks!,
      level: strategy.level!,
      equipment: strategy.equipment!,
      bodyParts: strategy.bodyParts,
      movementPatterns: strategy.movementPatterns,
      goals: strategy.goals,
      sport: strategy.sport,
    },
    injuries: {
      joints: strategy.joints,
      chronicConditions: strategy.chronicConditions,
      chronicNote: strategy.chronicNote,
    },
    assessmentInLibrary: true,
  };
}

function toTagMerge(strategy: StrategyDraft): TagMerge {
  return {
    训练目标: strategy.goals,
    训练目标备注: strategy.goalNote,
    训练经验: strategy.level!,
    关节问题: strategy.joints,
    慢性病: strategy.chronicConditions,
    慢性病备注: strategy.chronicNote,
  };
}

function cloneState(state: ParentState): ParentState {
  return structuredClone(state);
}

function done(state: ParentState, reply: string): TurnResult {
  return { state, reply };
}
