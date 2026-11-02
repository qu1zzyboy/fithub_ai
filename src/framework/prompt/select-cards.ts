import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExperienceLevel } from "../../parent/state.ts";
import type { ConfirmedStrategy } from "../../tools/read.ts";
import type { FoldedExperience, Population, ResolvedBand, RuleCard, StationId } from "./types.ts";

const FOLD: Record<ExperienceLevel, FoldedExperience> = {
  无训练史: "beginner",
  "<6个月": "beginner",
  "6个月-2年": "intermediate",
  "2-5年": "advanced",
  ">5年": "advanced",
};

const FREQUENCY_BAND: Record<FoldedExperience, [number, number]> = {
  beginner: [2, 3],
  intermediate: [3, 4],
  advanced: [4, 7],
};

const MOVEMENTS_PER_SESSION: Record<FoldedExperience, [number, number]> = {
  beginner: [4, 6],
  intermediate: [6, 8],
  advanced: [6, 10],
};

export function foldExperience(level: ExperienceLevel): FoldedExperience {
  return FOLD[level];
}

export function populationOf(strategy: ConfirmedStrategy): Population {
  const text = `${strategy.population ?? ""} ${strategy.teachingForm ?? ""}`;
  if (/竞技|运动员/.test(text)) return "athlete";
  return "general";
}

export function resolvedBand(strategy: ConfirmedStrategy): ResolvedBand {
  const experience = foldExperience(strategy.level);
  const population = populationOf(strategy);
  return {
    experience,
    population,
    frequency: strategy.frequencyPerWeek,
    frequencyBand: population === "athlete"
      ? [strategy.frequencyPerWeek, strategy.frequencyPerWeek]
      : FREQUENCY_BAND[experience],
    movementsPerSession: MOVEMENTS_PER_SESSION[experience],
    primaryShare: [60, 70],
  };
}

export function loadCards(): RuleCard[] {
  const path = join(dirname(fileURLToPath(import.meta.url)), "../../../agents/framework/knowledge/cards.json");
  const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (!Array.isArray(parsed)) throw new Error("规则卡格式不对");
  return parsed.map(asCard);
}

export function selectCards(cards: readonly RuleCard[], input: {
  station: StationId;
  experience: FoldedExperience;
  population: Population;
}): RuleCard[] {
  return cards.filter((card) => card.stations.includes(input.station) && whenMatches(card, input));
}

function whenMatches(card: RuleCard, input: { experience: FoldedExperience; population: Population }): boolean {
  const when = card.when;
  if (!when) return true;
  if (when.experience && !when.experience.includes(input.experience)) return false;
  if (when.population && !when.population.includes(input.population)) return false;
  return true;
}

function asCard(value: unknown): RuleCard {
  if (!value || typeof value !== "object") throw new Error("规则卡格式不对");
  const row = value as Record<string, unknown>;
  const id = text(row.id);
  const rule = text(row.rule);
  const source = text(row.source);
  const stations = Array.isArray(row.stations) ? row.stations.filter(isStation) : [];
  if (!id || !rule || !source || stations.length === 0) throw new Error("规则卡格式不对");
  const when = whenFrom(row.when);
  return { id, stations, rule, source, ...(when ? { when } : {}) };
}

function whenFrom(value: unknown): RuleCard["when"] | undefined {
  if (!value || typeof value !== "object") return undefined;
  const row = value as Record<string, unknown>;
  const experience = arrayOf(row.experience).filter(isExperience);
  const population = arrayOf(row.population).filter(isPopulation);
  if (experience.length === 0 && population.length === 0) return undefined;
  return {
    ...(experience.length > 0 ? { experience } : {}),
    ...(population.length > 0 ? { population } : {}),
  };
}

function isStation(value: unknown): value is StationId {
  return value === "demand-set" || value === "demand-items" || value === "diagnosis" || value === "slots";
}

function isExperience(value: string): value is FoldedExperience {
  return value === "beginner" || value === "intermediate" || value === "advanced";
}

function isPopulation(value: string): value is Population {
  return value === "general" || value === "athlete";
}

function arrayOf(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
