import type { AthleteBinding, ExperienceLevel } from "../parent/state.ts";

export interface ParentReads {
  resolveAthlete(name: string): Promise<AthleteBinding | null>;
  checkPermission(coachId: string, athleteId: string): Promise<boolean>;
  readInjuryTags(athleteId: string): Promise<{ joints: string[]; chronicConditions: string[] }>;
  assessmentExists(athleteId: string): Promise<boolean>;
  callBusinessApi(input: { coachId: string; athleteId: string | null; utterance: string }): Promise<string>;
}

export interface ConfirmedStrategy {
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
}

export interface AthleteTags {
  训练目标?: string[];
  训练目标备注?: string;
  训练经验?: ExperienceLevel;
  关节问题: string[];
  慢性病: string[];
  慢性病备注?: string;
}

export interface AssessmentRecord {
  id: string;
  joints: string[];
  chronicConditions: string[];
  summary: string;
}

export interface MovementRecord {
  id: string;
  name: string;
  patterns: string[];
  equipment: string[];
  contraindications: string[];
}

export interface MovementQuery {
  equipment: string[];
  patterns: string[];
}

export interface PlanTemplate {
  id: string;
  name: string;
  slots: { slotId: string; pattern: string }[];
}

export interface TemplateQuery {
  trainingType?: string;
  modules?: string[];
}

export interface PeriodPlan {
  id: string;
  name: string;
  cycleWeeks: number;
}

export interface PeriodQuery {
  cycleWeeks: number;
}

export interface EligibilityQuery {
  movementIds: string[];
  joints: string[];
  chronicConditions: string[];
}

export interface EligibilityDecision {
  movementId: string;
  allowed: boolean;
  reason?: string;
}

export interface FrameworkReads {
  readStrategy(athleteId: string): Promise<ConfirmedStrategy | null>;
  readTags(athleteId: string): Promise<AthleteTags>;
  readAssessment(athleteId: string): Promise<AssessmentRecord | null>;
  readMovements(query: MovementQuery): Promise<MovementRecord[]>;
  readPlanTemplates(query: TemplateQuery): Promise<PlanTemplate[]>;
  readPeriodPlans(query: PeriodQuery): Promise<PeriodPlan[]>;
  readEligibility(query: EligibilityQuery): Promise<EligibilityDecision[]>;
}

export interface TrainingRecord {
  id: string;
  athleteId: string;
  at: string;
  note: string;
  load: number;
  volume: number;
  completed: boolean;
}

export interface MovementAbility {
  movementId: string;
  level: string;
}

export interface StrengthReserve {
  movementId: string;
  reserve: number;
}

export interface CurrentPlan {
  id: string;
  summary: string;
  movements: MovementRecord[];
}

export interface ReviewReads {
  readTrainingRecords(athleteId: string, range: string): Promise<TrainingRecord[]>;
  readAssessment(athleteId: string): Promise<AssessmentRecord | null>;
  readMovementAbility(athleteId: string): Promise<MovementAbility[]>;
  readStrengthReserve(athleteId: string): Promise<StrengthReserve[]>;
  readCurrentPlan(athleteId: string): Promise<CurrentPlan | null>;
}
