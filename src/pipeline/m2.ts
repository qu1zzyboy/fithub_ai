/** M2 评估与定位：红线 / 模块三态 / 门禁入口 / 强度区间骨架。 */

export type GateResult = "pass" | "fail";
export type ModuleState = "green" | "yellow" | "red";
export type InjuryStage = "acute" | "subacute" | "late_recovery" | "healed";

export interface H2Payload {
  handoff_id: "H2";
  redline: { result: "pass" | "refer"; reason: string };
  module_states: {
    module: string;
    state: ModuleState;
    reason: string;
    substitute?: string;
    release_condition?: string;
  }[];
  injury_profile: {
    id: string;
    site: string;
    type: string;
    stage: InjuryStage;
    pain: { score: number; trigger_movement: string; pattern: "intermittent" | "constant" };
    medical_restriction: string;
    info_source: string;
    release_condition: string;
    updated_at: string;
  }[];
  entry_point: {
    module: string;
    gates: { mobility: GateResult; stability: GateResult; strength_floor: GateResult };
  };
  intensity_baseline: { pattern: "squat" | "push" | "hinge" | "pull"; range: [number, number] }[];
  diag_card: {
    line: "squat" | "hinge" | "push_pull" | "rotation" | "trunk";
    current_level: string;
    dose_position: string;
    breakpoint: string;
    output_expression: string;
    constraints: string;
  }[];
  report_ref: string;
  timestamp: string;
}

export interface M2Input {
  injuryNote?: string;
  /** 档案标签里的关节问题，如 ["膝","肩"] */
  jointTags?: string[];
  mobility?: GateResult;
  stability?: GateResult;
  strengthFloor?: GateResult;
  /** 有评估在库时默认门禁全过（除非显式传入 fail） */
  hasAssessment?: boolean;
  experienceHint?: "novice" | "intermediate" | "advanced";
  now?: () => string;
}

const ALL_MODULES = ["m1", "m2", "m3", "m4", "m5", "m6", "m7", "m8", "m9"] as const;

const REDLINE_PATTERNS: { reason: string; re: RegExp }[] = [
  { reason: "neuro_symptoms", re: /放射痛|麻木|无力|神经症状/ },
  { reason: "acute_trauma", re: /明显肿胀|畸形|无法承重|急性外伤/ },
  { reason: "post_op_no_clearance", re: /术后|治疗期|未获.*许可|医生.*禁止/ },
  { reason: "night_pain_systemic", re: /夜间痛|全身症状|不明原因.*痛/ },
  { reason: "cardio_acute", re: /胸痛|晕厥|异常气促|心慌.*运动/ },
];

export function buildH2(input: M2Input = {}): H2Payload {
  const now = (input.now ?? (() => new Date().toISOString()))();
  const note = (input.injuryNote ?? "").trim();
  const redline = evaluateRedline(note);
  const profile = buildInjuryProfile(note, input.jointTags ?? [], now);
  const moduleStates = buildModuleStates(profile, note);
  const gates = resolveGates(input);
  const entryModule = entryFromGates(gates, input.experienceHint);

  return {
    handoff_id: "H2",
    redline,
    module_states: moduleStates,
    injury_profile: profile,
    entry_point: { module: entryModule, gates },
    intensity_baseline: defaultBaselines(gates.strength_floor),
    diag_card: defaultDiagCard(gates),
    report_ref: "",
    timestamp: now,
  };
}

export function evaluateRedline(note: string): H2Payload["redline"] {
  for (const row of REDLINE_PATTERNS) {
    if (row.re.test(note)) return { result: "refer", reason: row.reason };
  }
  return { result: "pass", reason: "" };
}

function resolveGates(input: M2Input): H2Payload["entry_point"]["gates"] {
  const fallback: GateResult = input.hasAssessment ? "pass" : "fail";
  return {
    mobility: input.mobility ?? fallback,
    stability: input.stability ?? fallback,
    strength_floor: input.strengthFloor ?? fallback,
  };
}

function entryFromGates(
  gates: H2Payload["entry_point"]["gates"],
  experience?: M2Input["experienceHint"],
): string {
  if (gates.mobility === "fail") return "m1";
  if (gates.stability === "fail") return "m2";
  if (gates.strength_floor === "fail") return "m3";
  // 新手评估全过仍建议②打底
  if (experience === "novice") return "m2";
  return "m3";
}

function buildInjuryProfile(
  note: string,
  jointTags: string[],
  now: string,
): H2Payload["injury_profile"] {
  const sites = new Set<string>();
  for (const tag of jointTags) {
    const cleaned = tag.replace(/^关节问题:/, "").trim();
    if (cleaned && cleaned !== "无") sites.add(cleaned);
  }
  const siteFromNote = detectSite(note);
  if (siteFromNote) sites.add(siteFromNote);
  if (sites.size === 0 && !note) return [];

  if (sites.size === 0) {
    return [{
      id: "inj-1",
      site: "未指明",
      type: "self_report",
      stage: detectStage(note),
      pain: { score: estimatePain(note), trigger_movement: "", pattern: /持续/.test(note) ? "constant" : "intermittent" },
      medical_restriction: "",
      info_source: "dialog",
      release_condition: "无痛完成功能测试后复评",
      updated_at: now,
    }];
  }

  return [...sites].map((site, index) => ({
    id: `inj-${index + 1}`,
    site,
    type: "self_report",
    stage: detectStage(note),
    pain: {
      score: estimatePain(note),
      trigger_movement: "",
      pattern: /持续/.test(note) ? "constant" as const : "intermittent" as const,
    },
    medical_restriction: "",
    info_source: jointTags.length > 0 ? "tags+dialog" : "dialog",
    release_condition: releaseFor(site, detectStage(note)),
    updated_at: now,
  }));
}

function buildModuleStates(
  profile: H2Payload["injury_profile"],
  note: string,
): H2Payload["module_states"] {
  const base = ALL_MODULES.map((module) => ({
    module,
    state: "green" as ModuleState,
    reason: "无冲突",
  }));

  if (profile.length === 0) return [...base];

  const stage = profile[0]?.stage ?? detectStage(note);
  const sites = profile.map((item) => item.site).join("、");
  const acute = stage === "acute" || stage === "subacute";

  const paint = (module: string, state: ModuleState, reason: string, substitute?: string, release?: string) => {
    const row = base.find((item) => item.module === module);
    if (!row) return;
    row.state = state;
    row.reason = reason;
    if (substitute) (row as { substitute?: string }).substitute = substitute;
    if (release) (row as { release_condition?: string }).release_condition = release;
  };

  if (/心肺|全身|胸痛|晕厥/.test(note) && acute) {
    for (const module of ["m5", "m6", "m7"]) {
      paint(module, "red", "全身/心肺急性问题，关闭高强度", "m1", "遵医嘱后复评");
    }
    return base;
  }

  if (/腰|腰椎|神经/.test(sites + note) && acute) {
    paint("m3", "red", "急性腰椎/神经症状，关闭高负荷", "m1", "无痛+功能测试+必要时医生许可");
    paint("m4", "red", "急性腰椎/神经症状，关闭爆发", "m1", "无痛+功能测试+必要时医生许可");
    paint("m6", "red", "急性腰椎/神经症状，关闭跑跳", "m1", "无痛+功能测试+必要时医生许可");
    return base;
  }

  if (/膝|踝|髋|下肢/.test(sites) && acute) {
    paint("m6", "red", "下肢急性损伤，关闭跑跳冲刺", "m1", "无痛+功能测试通过后先转黄");
    paint("m3", "yellow", "下肢急性期，下肢高负荷谨慎下沉", undefined, "连续无痛完成+功能达标");
    paint("m4", "yellow", "下肢急性期，爆发谨慎", undefined, "连续无痛完成+功能达标");
    return base;
  }

  if (/肩|肘|腕|上肢/.test(sites) && acute) {
    paint("m4", "red", "上肢急性损伤，关闭上肢爆发", "m3", "无痛+功能测试通过");
    paint("m3", "yellow", "上肢急性期，上肢力量成分谨慎", undefined, "连续无痛完成+功能达标");
    if (/过顶|肩/.test(sites + note)) {
      paint("m4", "red", "过顶肩急性症状，关闭过顶爆发", "m3", "无痛+功能测试通过");
    }
    return base;
  }

  // 慢性/已愈合：相关模块打黄，不轻易关
  if (sites) {
    paint("m3", "yellow", `伤病部位 ${sites}（${stage}），力量模块谨慎下沉`, undefined, "连续无痛完成+功能达标");
    paint("m4", "yellow", `伤病部位 ${sites}（${stage}），爆发模块谨慎`, undefined, "连续无痛完成+功能达标");
    if (/膝|踝|髋|下肢/.test(sites)) {
      paint("m6", "yellow", `下肢陈伤，跑跳谨慎`, undefined, "连续无痛完成+功能达标");
    }
  }
  return base;
}

function detectSite(note: string): string {
  if (/腰|腰椎/.test(note)) return "腰";
  if (/膝/.test(note)) return "膝";
  if (/肩/.test(note)) return "肩";
  if (/踝/.test(note)) return "踝";
  if (/髋/.test(note)) return "髋";
  if (/肘/.test(note)) return "肘";
  return "";
}

function detectStage(note: string): InjuryStage {
  if (/急性|术后早期|刚伤|刚做完手术/.test(note)) return "acute";
  if (/亚急性|两周内|近期伤/.test(note)) return "subacute";
  if (/恢复后期|快好了/.test(note)) return "late_recovery";
  if (/已愈合|旧伤|慢性|陈伤/.test(note)) return "healed";
  if (/疼|痛|伤/.test(note)) return "subacute";
  return "healed";
}

function estimatePain(note: string): number {
  const hit = note.match(/(\d)\s*分/);
  if (hit) return Number(hit[1]);
  if (/剧痛|很疼|疼得/.test(note)) return 7;
  if (/不适|酸|隐痛/.test(note)) return 3;
  if (/疼|痛/.test(note)) return 4;
  return 0;
}

function releaseFor(site: string, stage: InjuryStage): string {
  if (stage === "acute" || stage === "subacute") {
    return `${site}：无痛+功能测试通过后先转黄，必要时医生许可`;
  }
  return `${site}：连续无痛完成+功能测试达标`;
}

function defaultBaselines(strength: GateResult): H2Payload["intensity_baseline"] {
  const low: [number, number] = strength === "pass" ? [20, 40] : [10, 25];
  return [
    { pattern: "squat", range: low },
    { pattern: "push", range: low },
    { pattern: "hinge", range: low },
    { pattern: "pull", range: low },
  ];
}

function defaultDiagCard(gates: H2Payload["entry_point"]["gates"]): H2Payload["diag_card"] {
  return [
    {
      line: "squat",
      current_level: gates.mobility === "pass" ? "entry_ok" : "mobility_limit",
      dose_position: "0",
      breakpoint: gates.stability === "fail" ? "stability" : "",
      output_expression: "",
      constraints: gates.strength_floor === "fail" ? "strength_floor" : "",
    },
  ];
}

/** 给教练看的短摘要（避免流程代号） */
export function summarizeH2(h2: H2Payload): string {
  if (h2.redline.result === "refer") {
    return `建议先就医（${h2.redline.reason || "需排查"}），本轮先不排训练。`;
  }
  const reds = h2.module_states.filter((item) => item.state === "red").map((item) => item.module);
  const yellows = h2.module_states.filter((item) => item.state === "yellow").map((item) => item.module);
  const parts = [
    `建议从 ${h2.entry_point.module} 切入`,
    `评估 关节${h2.entry_point.gates.mobility}/稳定${h2.entry_point.gates.stability}/力量${h2.entry_point.gates.strength_floor}`,
  ];
  if (reds.length) parts.push(`暂不安排 ${reds.join("、")}`);
  if (yellows.length) parts.push(`需谨慎 ${yellows.join("、")}`);
  if (h2.injury_profile.length) {
    parts.push(`关注部位 ${h2.injury_profile.map((item) => item.site).join("、")}`);
  }
  return parts.join("；") + "。";
}
