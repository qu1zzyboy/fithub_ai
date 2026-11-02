import type {
  DemandEntry,
  DemandSet,
  DiagnosisCard,
  SlotDraft,
} from "../../parent/state.ts";
import type { StationId, Violation } from "./types.ts";

const REASON_TAGS = ["时间不足", "恢复不足", "偏好抵触", "依从性波动", "伤病变化", "设备受限", "状态波动"];
const LOAD_KEYS = new Set(["sets", "reps", "load", "rest", "params", "组数", "次数", "负荷", "休息", "格位", "进阶步"]);
const ROLES = new Set(["primary", "maintain", "flavor"]);

export type StationVerdict =
  | { kind: "ok"; demandSet: DemandSet }
  | { kind: "ok"; demandItems: { items: DemandEntry[]; appliedRuleIds: string[] } }
  | { kind: "ok"; diagnosis: DiagnosisCard }
  | { kind: "ok"; slots: SlotDraft[]; sessions: number; appliedRuleIds: string[] }
  | { kind: "gap"; missing: string[] }
  | { kind: "return"; reasonTag: string }
  | { kind: "violations"; violations: Violation[] };

export function validateStation(station: StationId, raw: unknown, input: {
  cardIds: readonly string[];
  names: readonly string[];
  frequency: number;
  movementsPerSession: readonly [number, number];
  injuryJoints: readonly string[];
}): StationVerdict {
  const body = typeof raw === "string" ? parseJson(raw) : raw;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { kind: "violations", violations: [{ code: "V-json", field: "json", detail: "不是一个 JSON 对象" }] };
  }
  const row = body as Record<string, unknown>;
  if (row.status === "gap") {
    const missing = strings(row.missing);
    return { kind: "gap", missing: missing.length > 0 ? missing : ["本站材料"] };
  }
  if (row.status === "return") {
    if (station !== "slots") {
      return { kind: "violations", violations: [{ code: "V-status", field: "status", detail: "这一站不能退回" }] };
    }
    const reason = text(row.reasonTag);
    return { kind: "return", reasonTag: REASON_TAGS.includes(reason) ? reason : "恢复不足" };
  }
  if (row.status !== "ok") {
    return { kind: "violations", violations: [{ code: "V-status", field: "status", detail: "status 只能是 ok、gap 或 return" }] };
  }

  const violations: Violation[] = [];
  const appliedRuleIds = keepRuleIds(row.appliedRuleIds, input.cardIds, violations);
  collectLoadKeys(row, "", violations);
  if (station !== "slots") collectNames(row, input.names, violations);
  collectPool(row, violations);

  if (station === "demand-set") return demandSet(row, appliedRuleIds, input.cardIds, violations);
  if (station === "demand-items") return demandItems(row, appliedRuleIds, violations);
  if (station === "diagnosis") return diagnosis(row, appliedRuleIds, input.injuryJoints, violations);
  return slots(row, appliedRuleIds, input, violations);
}

function demandSet(
  row: Record<string, unknown>,
  appliedRuleIds: string[],
  cardIds: readonly string[],
  violations: Violation[],
): StationVerdict {
  const phase = text(row.phase);
  const periodization = text(row.periodization);
  if (!phase) violations.push({ code: "V-field", field: "phase", detail: "缺少阶段侧重" });
  if (periodization !== "linear" && periodization !== "undulating") {
    violations.push({ code: "V-field", field: "periodization", detail: "只能是 linear 或 undulating" });
  } else if (cardIds.includes("cscs.periodization.advanced") && periodization !== "undulating") {
    violations.push({ code: "V-model", field: "periodization", detail: "高级用波动安排" });
  } else if (
    (cardIds.includes("cscs.periodization.beginner") || cardIds.includes("cscs.periodization.intermediate"))
    && periodization !== "linear"
  ) {
    violations.push({ code: "V-model", field: "periodization", detail: "这一档用线性安排" });
  }

  const items = Array.isArray(row.items) ? row.items : [];
  const parsed = items.flatMap((item) => {
    const demand = asDemand(item, violations);
    return demand ? [demand] : [];
  });
  if (parsed.length === 0) violations.push({ code: "V-field", field: "items", detail: "需求集是空的" });
  const primary = parsed.filter((item) => item.role === "primary").reduce((sum, item) => sum + item.share, 0);
  const total = parsed.reduce((sum, item) => sum + item.share, 0);
  if (parsed.length > 0 && (primary < 60 || primary > 70)) {
    violations.push({ code: "V-share", field: "items", detail: "主模块占比要在 60 到 70" });
  }
  if (parsed.length > 0 && total !== 100) {
    violations.push({ code: "V-share", field: "items", detail: "占比合计要为 100" });
  }
  if (violations.length > 0) return { kind: "violations", violations };
  return {
    kind: "ok",
    demandSet: { phase, periodization: periodization as DemandSet["periodization"], items: parsed, appliedRuleIds },
  };
}

function demandItems(row: Record<string, unknown>, appliedRuleIds: string[], violations: Violation[]): StationVerdict {
  const items = Array.isArray(row.items) ? row.items : [];
  const parsed = items.flatMap((item) => {
    const entry = asEntry(item, violations);
    return entry ? [entry] : [];
  });
  if (parsed.length === 0) violations.push({ code: "V-field", field: "items", detail: "需求条目是空的" });
  if (violations.length > 0) return { kind: "violations", violations };
  return { kind: "ok", demandItems: { items: parsed, appliedRuleIds } };
}

function diagnosis(
  row: Record<string, unknown>,
  appliedRuleIds: string[],
  injuryJoints: readonly string[],
  violations: Violation[],
): StationVerdict {
  const constraints = Array.isArray(row.constraints) ? row.constraints.flatMap(asConstraint) : [];
  const breakpoints = Array.isArray(row.breakpoints) ? row.breakpoints.flatMap(asBreakpoint) : [];
  if (!Array.isArray(row.constraints) || !Array.isArray(row.breakpoints)) {
    violations.push({ code: "V-field", field: "constraints", detail: "约束和断点都要是数组" });
  } else if (row.constraints.length > 0 && constraints.length === 0) {
    violations.push({ code: "V-field", field: "constraints", detail: "约束要有 joint 和 dimension" });
  }
  if (violations.length > 0) return { kind: "violations", violations };
  if (injuryJoints.length > 0 && constraints.length === 0) {
    return { kind: "gap", missing: ["维度约束"] };
  }
  return { kind: "ok", diagnosis: { constraints, breakpoints, appliedRuleIds } };
}

function slots(
  row: Record<string, unknown>,
  appliedRuleIds: string[],
  input: { frequency: number; movementsPerSession: readonly [number, number] },
  violations: Violation[],
): StationVerdict {
  const sessions = row.sessions;
  const slotRows = Array.isArray(row.slots) ? row.slots : [];
  const parsed = slotRows.flatMap((item) => {
    const slot = asSlot(item, violations);
    return slot ? [slot] : [];
  });
  if (typeof sessions !== "number" || !Number.isInteger(sessions) || sessions < 1) {
    violations.push({ code: "V-field", field: "sessions", detail: "sessions 要是正整数" });
  }
  if (parsed.length === 0) violations.push({ code: "V-field", field: "slots", detail: "没有 slot" });
  const sessionCount = typeof sessions === "number" ? sessions : 0;
  const highest = parsed.reduce((max, slot) => Math.max(max, slot.session ?? 0), 0);
  const perSession = new Map<number, number>();
  for (const slot of parsed) {
    const key = slot.session ?? 1;
    perSession.set(key, (perSession.get(key) ?? 0) + 1);
  }
  const cap = input.movementsPerSession[1];
  for (const [session, count] of perSession) {
    if (count > cap) {
      violations.push({ code: "V-count", field: `slots.session.${session}`, detail: `这一课超过 ${cap} 个动作` });
    }
  }
  if (violations.length > 0) return { kind: "violations", violations };
  if (sessionCount > input.frequency || highest > input.frequency) {
    return { kind: "return", reasonTag: "恢复不足" };
  }
  return { kind: "ok", slots: parsed, sessions: sessionCount, appliedRuleIds };
}

function asDemand(value: unknown, violations: Violation[]): DemandSet["items"][number] | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  const id = text(row.id);
  const moduleName = text(row.module);
  const role = text(row.role);
  const share = row.share;
  if (!id || !moduleName || !ROLES.has(role) || typeof share !== "number" || !Number.isInteger(share)) {
    violations.push({ code: "V-field", field: "items", detail: "需求条目要有 id、module、role 和整数 share" });
    return null;
  }
  return { id, module: moduleName, role: role as DemandSet["items"][number]["role"], share };
}

function asEntry(value: unknown, violations: Violation[]): DemandEntry | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  const id = text(row.id);
  const pattern = text(row.pattern);
  const reason = text(row.reason);
  if (!id || !pattern || !reason) {
    violations.push({ code: "V-field", field: "items", detail: "需求条目要有 id、pattern 和 reason" });
    return null;
  }
  return { id, pattern, reason };
}

function asConstraint(value: unknown): { joint: string; dimension: string } | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  const joint = text(row.joint);
  const dimension = text(row.dimension);
  if (!joint || !dimension) return null;
  return { joint, dimension };
}

function asBreakpoint(value: unknown): { direction: string } | null {
  if (!value || typeof value !== "object") return null;
  const direction = text((value as Record<string, unknown>).direction);
  return direction ? { direction } : null;
}

function asSlot(value: unknown, violations: Violation[]): SlotDraft | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  const slotId = text(row.slotId);
  const pattern = text(row.pattern);
  if (!slotId || !pattern) {
    violations.push({ code: "V-field", field: "slots", detail: "slot 要有 slotId 和 pattern" });
    return null;
  }
  const movementId = text(row.movementId);
  const unfilledReason = text(row.unfilledReason);
  const session = typeof row.session === "number" && Number.isInteger(row.session) ? row.session : undefined;
  const constraints = Array.isArray(row.constraints) ? row.constraints.filter((item): item is string => typeof item === "string") : undefined;
  const role = text(row.role);
  return {
    slotId,
    pattern,
    ...(movementId ? { movementId } : {}),
    ...(unfilledReason ? { unfilledReason } : {}),
    ...(session ? { session } : {}),
    ...(text(row.anchor) ? { anchor: text(row.anchor) } : {}),
    ...(text(row.patternFamily) ? { patternFamily: text(row.patternFamily) } : {}),
    ...(constraints && constraints.length > 0 ? { constraints } : {}),
    ...(ROLES.has(role) ? { role: role as SlotDraft["role"] } : {}),
  };
}

function keepRuleIds(value: unknown, cardIds: readonly string[], violations: Violation[]): string[] {
  if (!Array.isArray(value)) {
    violations.push({ code: "V-rule", field: "appliedRuleIds", detail: "缺少 appliedRuleIds" });
    return [];
  }
  const known = new Set(cardIds);
  const ids = value.filter((item): item is string => typeof item === "string");
  const kept = ids.filter((id) => known.has(id));
  if (ids.length > 0 && kept.length === 0) {
    violations.push({ code: "V-rule", field: "appliedRuleIds", detail: "没有一条是这次给出的规则卡" });
  }
  return kept;
}

function collectLoadKeys(value: unknown, path: string, violations: Violation[]): void {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectLoadKeys(item, `${path}[${index}]`, violations));
    return;
  }
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (LOAD_KEYS.has(key)) {
      violations.push({ code: "V-load", field: path ? `${path}.${key}` : key, detail: "这一站不写负荷、组次或格位" });
    } else {
      collectLoadKeys(item, path ? `${path}.${key}` : key, violations);
    }
  }
}

function collectNames(value: unknown, names: readonly string[], violations: Violation[]): void {
  const haystack = stringsOf(value).join("\n");
  for (const name of names) {
    if (name.length < 2) continue;
    if (haystack.includes(name)) {
      violations.push({ code: "V2", field: "text", detail: `出现动作名「${name}」` });
      return;
    }
  }
}

function collectPool(value: unknown, violations: Violation[]): void {
  const haystack = stringsOf(value).join("\n");
  if (/动作池|rotation_pool|泳道/.test(haystack)) {
    violations.push({ code: "V-pool", field: "text", detail: "这一站不写动作池" });
  }
}

function stringsOf(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap((item) => stringsOf(item));
  if (value && typeof value === "object") {
    return Object.entries(value as Record<string, unknown>).flatMap(([key, item]) => {
      if (key === "appliedRuleIds") return [];
      return stringsOf(item);
    });
  }
  return [];
}

function parseJson(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1)) as unknown;
  } catch {
    return null;
  }
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim() !== "") : [];
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
