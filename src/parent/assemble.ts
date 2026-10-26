import { runFrameworkAgent, type FrameworkContext, type FrameworkProposal } from "../framework/run.ts";
import { runReviewAgent, type ReviewDraft, type ReviewFacts } from "../review/run.ts";
import type { FrameworkReads, ReviewReads } from "../tools/read.ts";
import { frameworkTools, parentTools, reviewTools, type ParentTools } from "../tools/sets.ts";
import type { ParentPorts } from "./ports.ts";

export function assembleParentPorts(input: {
  classify: ParentPorts["classify"];
  tools: ParentTools;
  framework: FrameworkReads;
  review: ReviewReads;
  proposeFramework: (context: FrameworkContext) => Promise<FrameworkProposal>;
  composeReview: (facts: ReviewFacts) => Promise<ReviewDraft>;
}): ParentPorts {
  const parent = parentTools(input.tools);
  const framework = frameworkTools(input.framework);
  const review = reviewTools(input.review);
  return {
    classify: input.classify,
    resolveAthlete: parent.resolveAthlete,
    checkPermission: parent.checkPermission,
    readInjuryTags: parent.readInjuryTags,
    assessmentExists: parent.assessmentExists,
    callBusinessApi: parent.callBusinessApi,
    mergeTags: parent.mergeTags,
    saveFramework: parent.saveFramework,
    savePlanChange: parent.savePlanChange,
    runFramework: (task) => runFrameworkAgent(task, framework, input.proposeFramework),
    runReview: (task) => runReviewAgent(task, review, input.composeReview),
  };
}
