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

export interface ParentPorts {
  classify(input: { utterance: string; state: ParentState }): Promise<Decision>;
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
