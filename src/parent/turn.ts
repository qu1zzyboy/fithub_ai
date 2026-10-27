import type { CoachDecision, ParentPorts } from "./ports.ts";
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
 * 记忆只在这一轮已经有结论、并且教练看得到回复之后抽取。
 */
export async function runParentTurn(
  state: ParentState,
  utterance: string,
  ports: ParentPorts,
): Promise<TurnResult> {
  const memoryIndex = await ports.loadMemory({ coachId: state.coachId, athleteId: state.athlete?.id ?? null });
  const decision = await ports.classify({ utterance, state, memoryIndex });
  let next = cloneState(state);

  if (decision.intent === "unrelated") return finish(next, spoken(decision, "这件我做不了。"), ports, utterance, true);
  if (decision.intent === "session") return finish(next, spoken(decision, "发这一次课还不在这一版里。"), ports, utterance, true);
  if (decision.intent === "premature-write") return finish(next, spoken(decision, "还没确认，不能写入。"), ports, utterance, true);
  if (decision.intent === "unclear") return finish(next, spoken(decision, "你是要往下排课，还是看已经练过的？"), ports, utterance, false);
  if (decision.intent === "confirm") return confirmPending(next, ports, utterance);
  if (decision.intent === "revise") {
    next.pending = null;
    return finish(next, "还没写入。直接说要改的地方，我再排一次。", ports, utterance, true);
  }

  const athleteName = "athleteName" in decision ? decision.athleteName : undefined;
  const needsAthlete = decision.intent !== "api" || decision.needsAthlete;
  if (needsAthlete) {
    const bound = await bindAthlete(next, athleteName, ports);
    if (bound.stop) return finish(bound.state, bound.stop, ports, utterance, false);
    next = bound.state;
  }

  if (decision.intent === "api") {
    const text = (await ports.callBusinessApi({
      coachId: next.coachId,
      athleteId: next.athlete?.id ?? null,
      utterance,
    })).trim();
    return finish(next, text || spoken(decision, "这个问题还没有接到对应的业务接口。"), ports, utterance, true);
  }

  if (decision.intent === "review") {
    if (!next.athlete) return finish(next, "请先告诉我学员名称。", ports, utterance, false);
    if (!decision.range) return finish(next, "要看哪一次，或哪一段时间？", ports, utterance, false);
    const task: ReviewTask = {
      athleteId: next.athlete.id,
      athleteName: next.athlete.name,
      range: decision.range,
      report: decision.report ?? false,
      chart: decision.chart ?? false,
      proposeChange: decision.proposeChange ?? false,
      memorySummary: await taskMemory(next, ports),
    };
    const result = await ports.runReview(task);
    if (!task.proposeChange) result.change = null;
    next.pending = { kind: "review", task, result };
    return finish(next, result.summary, ports, utterance, true);
  }

  next.strategy = applyStrategy(next.strategy, decision.strategy);
  if (!next.strategy.injuryConfirmed) {
    const tags = await ports.readInjuryTags(next.athlete!.id);
    const joints = tags.joints.length > 0 ? tags.joints.join("、") : "无";
    const chronic = tags.chronicConditions.length > 0 ? tags.chronicConditions.join("、") : "无";
    return finish(next, `档案里的关节问题：${joints}。慢性病：${chronic}。有则改完再确认，没有就确认无。`, ports, utterance, false);
  }

  const gaps = strategyGaps(next.strategy);
  if (gaps.length > 0) return finish(next, `排课还缺：${gaps.join("、")}。`, ports, utterance, false);

  const assessmentInLibrary = await ports.assessmentExists(next.athlete!.id);
  if (!assessmentInLibrary) return finish(next, "评估不在库，不能排课。", ports, utterance, true);

  const task = toFrameworkTask(next, await taskMemory(next, ports));
  await ports.mergeTags(next.athlete!.id, toTagMerge(next.strategy));
  const result = await ports.runFramework(task);
  next.pending = { kind: "framework", task, result };
  return finish(next, result.summary, ports, utterance, true);
}

async function confirmPending(state: ParentState, ports: ParentPorts, utterance: string): Promise<TurnResult> {
  const pending = state.pending;
  if (!pending || !state.athlete) return finish(state, "现在没有待确认的内容。", ports, utterance, false);
  if (pending.kind === "framework") {
    await ports.saveFramework(state.athlete.id, pending.result);
    return finish({ ...state, pending: null }, "框架已写入。", ports, utterance, true);
  }
  if (pending.result.change) {
    await ports.savePlanChange(state.athlete.id, pending.result.change);
    return finish({ ...state, pending: null }, "计划和参数已写入。", ports, utterance, true);
  }
  return finish({ ...state, pending: null }, "这次只作查看，没有要写入的改法。", ports, utterance, true);
}

async function taskMemory(state: ParentState, ports: ParentPorts): Promise<string | undefined> {
  const index = await ports.loadMemory({ coachId: state.coachId, athleteId: state.athlete?.id ?? null });
  const trimmed = index.trim();
  return trimmed || undefined;
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

function toFrameworkTask(state: ParentState, memorySummary: string | undefined): FrameworkTask {
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
    memorySummary,
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

function spoken(decision: CoachDecision, fallback: string): string {
  const reply = decision.reply?.trim();
  return reply || fallback;
}

function cloneState(state: ParentState): ParentState {
  return structuredClone(state);
}

async function finish(
  state: ParentState,
  reply: string,
  ports: ParentPorts,
  utterance: string,
  concluded: boolean,
): Promise<TurnResult> {
  if (concluded) {
    try {
      await ports.remember({
        utterance,
        reply,
        coachId: state.coachId,
        athleteId: state.athlete?.id ?? null,
      });
    } catch {
      // 记忆写失败时，这一轮已经给教练的回复仍然返回。
    }
  }
  return { state, reply };
}
