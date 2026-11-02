import { runFrameworkAgent } from "../framework/run.ts";
import type { StationCall } from "../framework/prompt/types.ts";
import { rememberTurn } from "../memory/remember.ts";
import { defaultMemoryRoot, readMemoryIndex, todayIso, type MemoryCandidate } from "../memory/store.ts";
import { runReviewAgent, type ReviewDraft, type ReviewFacts } from "../review/run.ts";
import type { FrameworkReads, ReviewReads } from "../tools/read.ts";
import { frameworkTools, parentTools, reviewTools, type ParentTools } from "../tools/sets.ts";
import type { ParentPorts } from "./ports.ts";

export function assembleParentPorts(input: {
  classify: ParentPorts["classify"];
  tools: ParentTools;
  framework: FrameworkReads;
  review: ReviewReads;
  answerStation: (call: StationCall) => Promise<unknown>;
  composeReview: (facts: ReviewFacts) => Promise<ReviewDraft>;
  memoryRoot?: string;
  proposeMemories?: (context: {
    utterance: string;
    reply: string;
    athleteBound: boolean;
    index: string;
  }) => Promise<MemoryCandidate[]>;
}): ParentPorts {
  const parent = parentTools(input.tools);
  const framework = frameworkTools(input.framework);
  const review = reviewTools(input.review);
  const root = input.memoryRoot ?? defaultMemoryRoot();
  const propose = input.proposeMemories ?? (async () => []);
  return {
    classify: input.classify,
    async loadMemory(query) {
      return readMemoryIndex(root, query, todayIso());
    },
    async remember(turn) {
      await rememberTurn({ ...turn, root, today: todayIso(), propose });
    },
    resolveAthlete: parent.resolveAthlete,
    checkPermission: parent.checkPermission,
    readInjuryTags: parent.readInjuryTags,
    assessmentExists: parent.assessmentExists,
    callBusinessApi: parent.callBusinessApi,
    mergeTags: parent.mergeTags,
    saveFramework: parent.saveFramework,
    savePlanChange: parent.savePlanChange,
    runFramework: (task) => runFrameworkAgent(task, framework, { answer: input.answerStation }),
    runReview: (task) => runReviewAgent(task, review, input.composeReview),
  };
}
