import type { FrameworkResult, PlanChange, TagMerge } from "../parent/state.ts";

/** 只挂在主 agent 上。教练确认之后才调用。 */
export interface ParentWrites {
  mergeTags(athleteId: string, tags: TagMerge): Promise<void>;
  saveFramework(athleteId: string, framework: FrameworkResult): Promise<void>;
  savePlanChange(athleteId: string, change: PlanChange): Promise<void>;
}
