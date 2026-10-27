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
}

export interface FrameworkResult {
  summary: string;
  slots?: FrameworkSlot[];
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

export interface ParentState {
  coachId: string;
  athlete: AthleteBinding | null;
  strategy: StrategyDraft | null;
  pending: Pending | null;
}

export function initialParentState(coachId: string): ParentState {
  return { coachId, athlete: null, strategy: null, pending: null };
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
