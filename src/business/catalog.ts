import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface Capability {
  id: string;
  needsAthlete: boolean;
  description: string;
  args: string[];
}

const CAPABILITY_IDS = [
  "list_my_athletes",
  "get_athlete_tags",
  "check_assessment",
  "list_period_plans",
  "none",
] as const;

export type CapabilityId = (typeof CAPABILITY_IDS)[number];

export function loadCapabilities(): Capability[] {
  const path = join(dirname(fileURLToPath(import.meta.url)), "../../agents/parent/capabilities.json");
  const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (!Array.isArray(parsed)) throw new Error("能力目录格式不对");
  return parsed.map(asCapability);
}

export function isCapabilityId(value: unknown): value is CapabilityId {
  return typeof value === "string" && (CAPABILITY_IDS as readonly string[]).includes(value);
}

export function catalogForPrompt(capabilities: readonly Capability[] = loadCapabilities()): string {
  return capabilities
    .map((item) => `- ${item.id}: ${item.description}（needsAthlete=${item.needsAthlete ? "true" : "false"}）`)
    .join("\n");
}

export function normalizeCapability(value: unknown): CapabilityId {
  return isCapabilityId(value) ? value : "none";
}

function asCapability(value: unknown): Capability {
  if (!value || typeof value !== "object") throw new Error("能力目录格式不对");
  const row = value as Record<string, unknown>;
  const id = typeof row.id === "string" ? row.id : "";
  const description = typeof row.description === "string" ? row.description.trim() : "";
  if (!isCapabilityId(id) || !description) throw new Error("能力目录格式不对");
  return {
    id,
    needsAthlete: row.needsAthlete === true,
    description,
    args: Array.isArray(row.args) ? row.args.filter((item): item is string => typeof item === "string") : [],
  };
}
