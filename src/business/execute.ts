import type { BusinessClient, BusinessUser } from "../chat/business.ts";
import type { CapabilityId } from "./catalog.ts";

export interface ExecuteInput {
  capability: CapabilityId;
  token: string;
  clientId: string;
  athleteId: string | null;
  athleteName: string | null;
  business: BusinessClient;
}

export async function executeCapability(input: ExecuteInput): Promise<string> {
  if (input.capability === "none") return "";
  if (input.capability === "list_my_athletes") {
    const users = await input.business.listUsers({ token: input.token, clientId: input.clientId });
    return formatAthletes(users);
  }
  if (input.capability === "list_period_plans") {
    const plans = await input.business.listPeriodPlans({ token: input.token, clientId: input.clientId });
    if (plans.length === 0) return "当前没有可见的周期计划。";
    const names = plans.map((plan) => plan.name).join("、");
    return `周期计划：${names}。`;
  }
  if (!input.athleteId) return "请先告诉我学员名称。";
  if (input.capability === "get_athlete_tags") {
    const user = await input.business.readUser({ token: input.token, userId: input.athleteId });
    return formatTags(input.athleteName ?? "这名学员", user?.tags ?? []);
  }
  if (input.capability === "check_assessment") {
    const exists = await input.business.hasAssessment({ token: input.token, userId: input.athleteId });
    const name = input.athleteName ?? "这名学员";
    return exists ? `${name} 的评估在库。` : `${name} 的评估不在库。`;
  }
  return "";
}

function formatAthletes(users: readonly BusinessUser[]): string {
  if (users.length === 0) return "名下暂时没有学员。";
  const names = users.map((user) => user.name).filter(Boolean);
  if (names.length === 0) return "名下暂时没有学员。";
  const shown = names.slice(0, 10);
  const more = names.length > shown.length ? ` 另有 ${names.length - shown.length} 人未列出。` : "";
  return `名下学员：${shown.join("、")}。${more}`.trim();
}

function formatTags(name: string, tags: readonly string[]): string {
  const goals = pick(tags, "训练目标:");
  const experience = first(tags, "训练经验:");
  const joints = pick(tags, "关节问题:").filter((item) => item !== "无");
  const chronic = pick(tags, "慢性病:").filter((item) => item !== "无");
  const parts = [
    goals.length > 0 ? `训练目标 ${goals.join("、")}` : "",
    experience ? `训练经验 ${experience}` : "",
    joints.length > 0 ? `关节问题 ${joints.join("、")}` : "关节问题 无",
    chronic.length > 0 ? `慢性病 ${chronic.join("、")}` : "慢性病 无",
  ].filter(Boolean);
  if (parts.length === 0) return `${name} 还没有训练相关标签。`;
  return `${name}：${parts.join("；")}。`;
}

function pick(tags: readonly string[], prefix: string): string[] {
  return tags
    .filter((tag) => tag.startsWith(prefix))
    .map((tag) => tag.slice(prefix.length).trim())
    .filter(Boolean);
}

function first(tags: readonly string[], prefix: string): string {
  return pick(tags, prefix)[0] ?? "";
}
