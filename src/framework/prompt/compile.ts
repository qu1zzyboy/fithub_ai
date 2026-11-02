import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { FrameworkTask } from "../../parent/state.ts";
import type { AssessmentRecord, AthleteTags, ConfirmedStrategy, PeriodPlan } from "../../tools/read.ts";
import type { CandidateMovement, ResolvedBand, RuleCard, StationId, Violation } from "./types.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../../agents/framework");

export function readPolicy(): string {
  return readFileSync(join(ROOT, "policy.md"), "utf8").trim();
}

export function readContract(station: StationId): string {
  return readFileSync(join(ROOT, "stations", station, "contract.md"), "utf8").trim();
}

export interface CaseFile {
  athleteName: string;
  strategy: ConfirmedStrategy;
  injuries: FrameworkTask["injuries"];
  assessmentSummary: string;
  tags: AthleteTags;
  resolved: ResolvedBand;
  memorySummary?: string;
  bounceReason?: string;
  demandSet?: unknown;
  demandItems?: unknown;
  diagnosis?: unknown;
  candidates?: CandidateMovement[];
  periodPlans?: PeriodPlan[];
}

export function compileStation(input: {
  station: StationId;
  cards: readonly RuleCard[];
  caseFile: CaseFile;
}): { system: string; user: string; cardIds: string[] } {
  const system = readPolicy();
  const lines = [
    `本站：${input.station}`,
    "",
    readContract(input.station),
    "",
    "规则卡：",
    input.cards.length === 0 ? "无" : input.cards.map((card) => `- ${card.id}: ${card.rule}`).join("\n"),
    "",
    "案卷：",
    JSON.stringify(input.caseFile, null, 2),
  ];
  return { system, user: lines.join("\n"), cardIds: input.cards.map((card) => card.id) };
}

export function compileRepair(violations: readonly Violation[], previous: unknown): string {
  const lines = violations.map((item) => `- ${item.code} ${item.field}: ${item.detail}`);
  return [
    "上次输出未通过校验。只改违规处，字段形状不变。",
    "",
    "违规：",
    lines.join("\n"),
    "",
    "上次 JSON：",
    JSON.stringify(previous, null, 2),
  ].join("\n");
}
