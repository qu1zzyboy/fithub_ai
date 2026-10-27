import type {
  AthleteBinding,
  FrameworkResult,
  FrameworkTask,
  ParentState,
  PlanChange,
  ReviewResult,
  ReviewTask,
  StrategyDraft,
  TagMerge,
} from "./state.ts";

/** 分类器交回的决定。循环不把原话交给子 agent。 */
export type Decision =
  | { intent: "unrelated" }
  | { intent: "unclear" }
  | { intent: "session" }
  | { intent: "premature-write" }
  | { intent: "api"; needsAthlete: boolean }
  | { intent: "confirm" }
  | { intent: "revise" }
  | { intent: "framework"; athleteName?: string; strategy?: Partial<StrategyDraft> }
  | {
      intent: "review";
      athleteName?: string;
      range?: string;
      report?: boolean;
      chart?: boolean;
      proposeChange?: boolean;
    };

type WithReply<T> = T & { reply?: string };

export type CoachDecision = WithReply<Decision>;

export interface ParentPorts {
  classify(input: { utterance: string; state: ParentState; memoryIndex: string }): Promise<CoachDecision>;
  loadMemory(input: { coachId: string; athleteId: string | null }): Promise<string>;
  remember(input: { utterance: string; reply: string; coachId: string; athleteId: string | null }): Promise<void>;
  resolveAthlete(name: string): Promise<AthleteBinding | null>;
  checkPermission(coachId: string, athleteId: string): Promise<boolean>;
  readInjuryTags(athleteId: string): Promise<{ joints: string[]; chronicConditions: string[] }>;
  assessmentExists(athleteId: string): Promise<boolean>;
  callBusinessApi(input: { coachId: string; athleteId: string | null; utterance: string }): Promise<string>;
  mergeTags(athleteId: string, tags: TagMerge): Promise<void>;
  saveFramework(athleteId: string, framework: FrameworkResult): Promise<void>;
  savePlanChange(athleteId: string, change: PlanChange): Promise<void>;
  runFramework(task: FrameworkTask): Promise<FrameworkResult>;
  runReview(task: ReviewTask): Promise<ReviewResult>;
}
