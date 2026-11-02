export const STATIONS = ["demand-set", "demand-items", "diagnosis", "slots"] as const;

export type StationId = (typeof STATIONS)[number];

export type FoldedExperience = "beginner" | "intermediate" | "advanced";

export type Population = "general" | "athlete";

export interface RuleCard {
  id: string;
  stations: StationId[];
  when?: {
    experience?: FoldedExperience[];
    population?: Population[];
  };
  rule: string;
  source: string;
}

export interface StationCall {
  station: StationId;
  system: string;
  user: string;
  cardIds: string[];
  repair: boolean;
}

export interface CandidateMovement {
  id: string;
  name: string;
  patterns: string[];
}

export interface ResolvedBand {
  experience: FoldedExperience;
  population: Population;
  frequency: number;
  frequencyBand: [number, number];
  movementsPerSession: [number, number];
  primaryShare: [number, number];
}

export interface Violation {
  code: string;
  field: string;
  detail: string;
}
