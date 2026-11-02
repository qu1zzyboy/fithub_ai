/** M3 周计划合成：目标/偏好/时间 → 模块级周计划 + 档案壳。不选动作、不定组次。 */

import type { H1Payload, UserType } from "./m1.ts";
import type { H2Payload } from "./m2.ts";

export type Preference = "focus" | "lean_focus" | "balanced" | "lean_variety" | "variety";
export type Horizon = "single" | "short" | "long";

export interface H3Payload {
  handoff_id: "H3";
  entry_module: string;
  module_mix: {
    primary: string;
    secondary: string[];
    flagged: { module: string; state: "yellow" }[];
  };
  route: { type: "A" | "B"; main_ratio: number };
  plan_scheme: string;
  weekly_schedule: { session: string; type: string; modules: string[] }[];
  intensity_range: { module: string; range: [number, number] }[];
  maintenance_dose: { module: string; dose: string }[];
  retest_cadence: "4-8w" | "end" | "none";
  injury_ref: string;
  profile: {
    basic_info: Record<string, unknown>;
    goals_needs: { quote: string; user_type: UserType; primary_module: string };
    preference: { preference: Preference; frequency: number; session_minutes: number; horizon: Horizon };
    assessment_report: string;
    strength_profile: string;
    injury_profile: string;
    training_position: { entry_module: string; gates: H2Payload["entry_point"]["gates"] };
    meta: {
      version: string;
      updated_at: string;
      update_mechanism: string;
      progress_compare: string;
    };
  };
  timestamp: string;
}

export interface M3Input {
  h1: H1Payload;
  h2: H2Payload;
  preference?: Preference;
  frequency?: number;
  sessionMinutes?: number;
  horizon?: Horizon;
  athleteName?: string;
  now?: () => string;
}

export function buildH3(input: M3Input): H3Payload {
  const now = (input.now ?? (() => new Date().toISOString()))();
  if (input.h2.redline.result === "refer") {
    throw new Error("红线转介中，不能合成周计划。");
  }

  const preference = input.preference ?? inferPreference(input.h1.raw_quote, input.h1.user_type);
  const frequency = clampInt(input.frequency ?? inferFrequency(input.h1.raw_quote), 1, 6);
  const sessionMinutes = input.sessionMinutes ?? inferMinutes(input.h1.raw_quote);
  const horizon = input.horizon ?? inferHorizon(input.h1.raw_quote);

  const red = new Set(
    input.h2.module_states.filter((item) => item.state === "red").map((item) => item.module),
  );
  const yellow = input.h2.module_states
    .filter((item) => item.state === "yellow")
    .map((item) => ({ module: item.module, state: "yellow" as const }));

  const entry = input.h2.entry_point.module || "m3";
  let primary = pickOpenModule(input.h1.primary_module, red, input.h2) || entry;
  // 仅当门禁未过、必须先补基础层时，入口模块压过目标主模块
  const gates = input.h2.entry_point.gates;
  const needsRemediation = gates.mobility === "fail"
    || gates.stability === "fail"
    || (gates.strength_floor === "fail" && ["m5", "m6", "m7"].includes(primary));
  if (needsRemediation && moduleRank(entry) < moduleRank(primary)) primary = entry;

  const secondary = unique([
    ...input.h1.secondary_modules,
    ...goalSecondary(input.h1.user_type, input.h1.raw_quote),
  ])
    .filter((module) => module !== primary && !red.has(module))
    .slice(0, 3);

  const route = routeFromPreference(preference);
  const planScheme = pickScheme({
    preference,
    frequency,
    sessionMinutes,
    horizon,
    userType: input.h1.user_type,
    quote: input.h1.raw_quote,
  });
  const weekly = buildWeeklySchedule({
    primary,
    secondary,
    entry,
    frequency,
    sessionMinutes,
    planScheme,
    route: route.type,
  });
  const intensity = intensityForModules([primary, ...secondary, entry], input.h2);
  const maintenance = maintenanceFor(yellow.map((item) => item.module), entry, primary);
  const retest = horizon === "single" ? "none" : horizon === "short" ? "end" : "4-8w";

  return {
    handoff_id: "H3",
    entry_module: entry,
    module_mix: { primary, secondary, flagged: yellow },
    route,
    plan_scheme: planScheme,
    weekly_schedule: weekly,
    intensity_range: intensity,
    maintenance_dose: maintenance,
    retest_cadence: retest,
    injury_ref: "H2.injury_profile",
    profile: {
      basic_info: { athlete_name: input.athleteName ?? "" },
      goals_needs: {
        quote: input.h1.raw_quote,
        user_type: input.h1.user_type,
        primary_module: primary,
      },
      preference: {
        preference,
        frequency,
        session_minutes: sessionMinutes,
        horizon,
      },
      assessment_report: input.h2.report_ref || "",
      strength_profile: JSON.stringify(input.h2.intensity_baseline),
      injury_profile: "H2.injury_profile",
      training_position: {
        entry_module: entry,
        gates: input.h2.entry_point.gates,
      },
      meta: {
        version: "m3-v1",
        updated_at: now,
        update_mechanism: "weekly_feedback",
        progress_compare: "",
      },
    },
    timestamp: now,
  };
}

export function summarizeH3(h3: H3Payload): string {
  const days = h3.weekly_schedule.map((item) => item.session).join("/");
  const flagged = h3.module_mix.flagged.length
    ? `；需谨慎 ${h3.module_mix.flagged.map((item) => item.module).join("、")}`
    : "";
  return [
    `切入 ${h3.entry_module}`,
    `主方向 ${h3.module_mix.primary}`,
    `辅方向 ${h3.module_mix.secondary.join("、") || "无"}`,
    `配比 ${h3.route.type}(${Math.round(h3.route.main_ratio * 100)}%)`,
    `方案 ${h3.plan_scheme}`,
    `本周 ${days || "暂无课次"}`,
    `复测节奏 ${h3.retest_cadence}`,
  ].join("；") + flagged + "。";
}

function pickOpenModule(
  wanted: string,
  red: Set<string>,
  h2: H2Payload,
): string {
  if (!red.has(wanted)) return wanted;
  const sub = h2.module_states.find((item) => item.module === wanted)?.substitute;
  if (sub && !red.has(sub)) return sub;
  for (const module of ["m1", "m2", "m3", "m5", "m8"]) {
    if (!red.has(module)) return module;
  }
  return "m1";
}

function goalSecondary(userType: UserType, quote: string): string[] {
  if (userType === "fitness") {
    if (/减脂/.test(quote)) return ["m3", "m9"];
    if (/增肌|塑形/.test(quote)) return ["m5", "m2"];
    if (/体态|健康|习惯/.test(quote)) return ["m5", "m8", "m9"];
    return ["m5"];
  }
  if (userType === "performance") {
    if (/耐力|有氧/.test(quote)) return ["m3"];
    if (/球|格斗|对抗|间歇/.test(quote)) return ["m5", "m3"];
    return ["m3", "m6"];
  }
  if (/考核/.test(quote)) return ["m5"];
  return ["m1", "m8"];
}

function routeFromPreference(preference: Preference): H3Payload["route"] {
  switch (preference) {
    case "focus":
      return { type: "A", main_ratio: 0.65 };
    case "lean_focus":
      return { type: "A", main_ratio: 0.6 };
    case "balanced":
      return { type: "A", main_ratio: 0.5 };
    case "lean_variety":
      return { type: "B", main_ratio: 0.45 };
    case "variety":
      return { type: "B", main_ratio: 0.35 };
  }
}

function pickScheme(input: {
  preference: Preference;
  frequency: number;
  sessionMinutes: number;
  horizon: Horizon;
  userType: UserType;
  quote: string;
}): string {
  if (/考核|比赛/.test(input.quote) || input.userType === "occupational" && /考核/.test(input.quote)) {
    return "C3";
  }
  if (input.horizon === "single") return "A3";
  if (input.frequency <= 1) return "A3";
  if (input.frequency === 2) return input.sessionMinutes >= 90 ? "A4" : "A1";
  if (input.preference === "focus" || input.preference === "lean_focus") {
    return input.frequency >= 4 ? "B4" : "B1";
  }
  if (input.preference === "variety" || input.preference === "lean_variety") {
    return input.frequency >= 4 ? "B2" : "A2";
  }
  if (/减脂/.test(input.quote) && /力量|增肌/.test(input.quote)) return "E1";
  return input.frequency >= 3 ? "B1" : "A1";
}

function buildWeeklySchedule(input: {
  primary: string;
  secondary: string[];
  entry: string;
  frequency: number;
  sessionMinutes: number;
  planScheme: string;
  route: "A" | "B";
}): H3Payload["weekly_schedule"] {
  const aux = input.secondary[0] ?? input.entry;
  const flavor = input.secondary[1] ?? "m8";
  const sessions: H3Payload["weekly_schedule"] = [];

  if (input.frequency <= 1) {
    sessions.push({
      session: "D1",
      type: input.sessionMinutes <= 45 ? "复合精简" : "混合循环",
      modules: unique([input.entry, input.primary, aux]).slice(0, 3),
    });
    return sessions;
  }

  for (let i = 1; i <= input.frequency; i += 1) {
    const isMain = input.route === "A" ? i <= Math.ceil(input.frequency * 0.66) : i % 2 === 1;
    if (isMain) {
      sessions.push({
        session: `D${i}`,
        type: input.planScheme.startsWith("A") ? "主课" : "主模块日",
        modules: unique([input.primary, input.sessionMinutes >= 60 ? aux : ""].filter(Boolean)),
      });
    } else {
      sessions.push({
        session: `D${i}`,
        type: "辅/维持",
        modules: unique([aux, flavor, input.entry]).slice(0, 2),
      });
    }
  }
  return sessions;
}

function intensityForModules(modules: string[], h2: H2Payload): H3Payload["intensity_range"] {
  const base = h2.intensity_baseline[0]?.range ?? [15, 35];
  const soft: [number, number] = [base[0], Math.max(base[0] + 5, Math.round(base[1] * 0.7))];
  return unique(modules).map((module) => ({
    module,
    range: module === "m1" || module === "m2" || module === "m8" || module === "m9" ? soft : [base[0], base[1]],
  }));
}

function maintenanceFor(yellow: string[], entry: string, primary: string): H3Payload["maintenance_dose"] {
  const rows = unique([...yellow, entry].filter((module) => module !== primary));
  return rows.map((module) => ({
    module,
    dose: module === entry ? "入口补强 1/2 主量" : "维持 1/3–1/2 主量",
  }));
}

function inferPreference(quote: string, userType: UserType): Preference {
  if (/怕枯燥|换着练|丰富|新鲜/.test(quote)) return "variety";
  if (/专注|出成绩|接受重复|要结果/.test(quote)) return "focus";
  if (userType === "performance" || userType === "occupational") return "lean_focus";
  return "balanced";
}

function inferFrequency(quote: string): number {
  const hit = quote.match(/每周\s*(\d)\s*次/) || quote.match(/(\d)\s*次\/周/) || quote.match(/练\s*(\d)\s*天/);
  if (hit) return Number(hit[1]);
  if (/很少|只能来一次/.test(quote)) return 1;
  if (/天天|五次|六次/.test(quote)) return 5;
  return 3;
}

function inferMinutes(quote: string): number {
  if (/90\s*分钟|一个半小时/.test(quote)) return 90;
  if (/30\s*分钟|半小时/.test(quote)) return 30;
  if (/45\s*分钟/.test(quote)) return 45;
  return 60;
}

function inferHorizon(quote: string): Horizon {
  if (/体验|单次|试一次/.test(quote)) return "single";
  if (/长期|三个月|赛季|季度/.test(quote)) return "long";
  if (/四周|八周|一个月|短期/.test(quote)) return "short";
  return "short";
}

function moduleRank(module: string): number {
  const order = ["m1", "m2", "m3", "m4", "m5", "m6", "m7", "m8", "m9"];
  const index = order.indexOf(module);
  return index < 0 ? 99 : index;
}

function unique(items: string[]): string[] {
  const out: string[] = [];
  for (const item of items) {
    if (!item || out.includes(item)) continue;
    out.push(item);
  }
  return out;
}

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.round(value)));
}
