export const EXPERIENCE_LEVELS = ["无训练史", "<6个月", "6个月-2年", "2-5年", ">5年"] as const;

export type ExperienceLevel = (typeof EXPERIENCE_LEVELS)[number];

export function isExperienceLevel(value: unknown): value is ExperienceLevel {
  return typeof value === "string" && (EXPERIENCE_LEVELS as readonly string[]).includes(value);
}

export interface AthleteBinding {
  id: string;
  name: string;
}

/** 留在策略里、不写入 user.tags 的安排。 */
export interface StrategyDraft {
  trainingType?: string;
  trainingModules?: string[];
  population?: string;
  teachingForm?: string;
  frequencyPerWeek?: number;
  cycleWeeks?: number;
  level?: ExperienceLevel;
  equipment?: string[];
  bodyParts?: string[];
  movementPatterns?: string[];
  goals?: string[];
  goalNote?: string;
  sport?: string;
  injuryConfirmed: boolean;
  joints: string[];
  chronicConditions: string[];
  chronicNote?: string;
}

export interface FrameworkTask {
  athleteId: string;
  athleteName: string;
  strategy: {
    trainingType?: string;
    trainingModules?: string[];
    population?: string;
    teachingForm?: string;
    frequencyPerWeek: number;
    cycleWeeks: number;
    level: ExperienceLevel;
    equipment: string[];
    bodyParts?: string[];
    movementPatterns?: string[];
    goals?: string[];
    sport?: string;
  };
  injuries: {
    joints: string[];
    chronicConditions: string[];
    chronicNote?: string;
  };
  assessmentInLibrary: true;
  memorySummary?: string;
}

export interface MovementParams {
  sets?: number;
  reps?: string;
  load?: string;
}

export interface FrameworkSlot {
  slotId: string;
  pattern: string;
  movementId?: string;
  params?: MovementParams;
  unfilledReason?: string;
  session?: number;
  anchor?: string;
  patternFamily?: string;
  constraints?: string[];
  role?: "primary" | "maintain" | "flavor";
}

export interface DemandSetItem {
  id: string;
  role: "primary" | "maintain" | "flavor";
  module: string;
  share: number;
}

export interface DemandSet {
  phase: string;
  periodization: "linear" | "undulating";
  items: DemandSetItem[];
  appliedRuleIds: string[];
}

export interface DemandEntry {
  id: string;
  pattern: string;
  reason: string;
}

export interface DemandItems {
  items: DemandEntry[];
  appliedRuleIds: string[];
}

export interface DiagnosisCard {
  constraints: { joint: string; dimension: string }[];
  breakpoints: { direction: string }[];
  appliedRuleIds: string[];
}

export type SlotDraft = FrameworkSlot;

export interface FrameworkResult {
  summary: string;
  slots?: FrameworkSlot[];
  demandSet?: DemandSet;
  demandItems?: DemandItems;
  diagnosis?: DiagnosisCard;
  slotRuleIds?: string[];
}

export interface ReviewTask {
  athleteId: string;
  athleteName: string;
  range: string;
  report: boolean;
  chart: boolean;
  proposeChange: boolean;
  memorySummary?: string;
}

export interface PlanChange {
  summary: string;
  movementIds?: string[];
}

export interface ReviewResult {
  summary: string;
  report?: string;
  chart?: string;
  change: PlanChange | null;
}

export type Pending =
  | { kind: "framework"; task: FrameworkTask; result: FrameworkResult }
  | { kind: "review"; task: ReviewTask; result: ReviewResult };

export interface ToolUseRecord {
  id: string;
  name: string;
  input: unknown;
}

/** 会话里给主 agent 看的消息。tool 行对应一次工具结果。 */
export interface ChatMessage {
  role: "user" | "assistant" | "tool";
  content: string;
  toolUseId?: string;
  toolName?: string;
  toolUses?: ToolUseRecord[];
}

export type ActiveGate = "framework" | "review";

export interface ParentState {
  coachId: string;
  athlete: AthleteBinding | null;
  strategy: StrategyDraft | null;
  pending: Pending | null;
  /** 已进入排课/复盘门禁；续聊走分类器补策略，不再开新的只读 ReAct。 */
  activeGate: ActiveGate | null;
  messages: ChatMessage[];
  /** 近窗外更早对话的滚动摘要，只给模型看；UI 仍看 messages。 */
  sessionSummary?: string | null;
  /** 已折进 sessionSummary 的消息前缀长度（从 0 起算）。 */
  summaryThrough?: number;
}

/** 落盘/UI 保留条数；模型侧另按 token 近窗裁剪。 */
export const HISTORY_LIMIT = 120;

export function initialParentState(coachId: string): ParentState {
  return {
    coachId,
    athlete: null,
    strategy: null,
    pending: null,
    activeGate: null,
    messages: [],
    sessionSummary: null,
    summaryThrough: 0,
  };
}

/** 有待确认草案、未完成策略，或已拉起门禁时，下一轮交给分类续聊。 */
export function needsGateContinuation(state: ParentState): boolean {
  return Boolean(state.pending) || Boolean(state.strategy) || Boolean(state.activeGate);
}

export function appendChat(state: ParentState, ...messages: ChatMessage[]): ParentState {
  const next = [...state.messages, ...messages];
  if (next.length <= HISTORY_LIMIT) return { ...state, messages: next };
  const overflow = next.length - HISTORY_LIMIT;
  const through = Math.max(0, (state.summaryThrough ?? 0) - overflow);
  return { ...state, messages: next.slice(-HISTORY_LIMIT), summaryThrough: through };
}

/** 确认策略后并进 user.tags 的键。频率、周期、模块留在策略里。 */
export interface TagMerge {
  训练目标?: string[];
  训练目标备注?: string;
  训练经验: ExperienceLevel;
  关节问题: string[];
  慢性病: string[];
  慢性病备注?: string;
}
