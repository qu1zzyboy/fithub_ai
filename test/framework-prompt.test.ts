import assert from "node:assert/strict";
import test from "node:test";
import { equipmentMatches, loadMovementLibrary, movementNames } from "../src/framework/library.ts";
import { compileRepair, compileStation, readContract, readPolicy } from "../src/framework/prompt/compile.ts";
import { foldExperience, loadCards, populationOf, resolvedBand, selectCards } from "../src/framework/prompt/select-cards.ts";
import { validateStation } from "../src/framework/prompt/validate.ts";
import type { ConfirmedStrategy } from "../src/tools/read.ts";

function strategy(overrides: Partial<ConfirmedStrategy> = {}): ConfirmedStrategy {
  return {
    trainingType: "力量",
    frequencyPerWeek: 3,
    cycleWeeks: 8,
    level: "6个月-2年",
    equipment: ["杠铃"],
    ...overrides,
  };
}

function caseFile(stationCards: string[]) {
  const current = strategy();
  return {
    athleteName: "甲",
    strategy: current,
    injuries: { joints: ["膝"], chronicConditions: [] },
    assessmentSummary: "已评估",
    tags: { 关节问题: ["膝"], 慢性病: [] },
    resolved: resolvedBand(current),
    ...(stationCards.includes("slots") ? { candidates: [{ id: "bench", name: "卧推", patterns: ["Push"] }] } : {}),
  };
}

const names = ["箱式深蹲", "Box Squat"];

test("五档折成三档，人群从策略里认", () => {
  assert.equal(foldExperience("无训练史"), "beginner");
  assert.equal(foldExperience("<6个月"), "beginner");
  assert.equal(foldExperience("6个月-2年"), "intermediate");
  assert.equal(foldExperience("2-5年"), "advanced");
  assert.equal(foldExperience(">5年"), "advanced");
  assert.equal(populationOf(strategy()), "general");
  assert.equal(populationOf(strategy({ population: "竞技运动员" })), "athlete");
});

test("中级一般人群的需求集只选到这一档的卡", () => {
  const ids = selectCards(loadCards(), {
    station: "demand-set",
    experience: "intermediate",
    population: "general",
  }).map((card) => card.id);
  assert.deepEqual(ids, [
    "share.primary",
    "phase.span",
    "cscs.freq.intermediate.general",
    "cscs.periodization.intermediate",
  ]);
});

test("初学运动员不拿一般人群的频率卡", () => {
  const ids = selectCards(loadCards(), {
    station: "demand-set",
    experience: "beginner",
    population: "athlete",
  }).map((card) => card.id);
  assert.equal(ids.includes("cscs.freq.athlete"), true);
  assert.equal(ids.includes("cscs.freq.beginner.general"), false);
  assert.equal(ids.includes("cscs.periodization.beginner"), true);
});

test("诊断和课表按站拿卡", () => {
  const diagnosis = selectCards(loadCards(), {
    station: "diagnosis",
    experience: "beginner",
    population: "general",
  }).map((card) => card.id);
  assert.deepEqual(diagnosis, ["diagnosis.dimension", "diagnosis.assessment", "diagnosis.beginner"]);
  const slots = selectCards(loadCards(), {
    station: "slots",
    experience: "intermediate",
    population: "general",
  }).map((card) => card.id);
  assert.equal(slots.includes("slots.count.intermediate"), true);
  assert.equal(slots.includes("slots.beginner.regression"), false);
  assert.equal(slots.includes("slots.no-load"), true);
});

test("① 到 ③ 的成稿没有动作名和负荷表，系统头各站相同", () => {
  const policy = readPolicy();
  assert.equal(policy.includes("七步"), false);
  assert.equal(policy.includes("%1RM"), false);
  const systems = new Set<string>();
  for (const station of ["demand-set", "demand-items", "diagnosis"] as const) {
    const band = resolvedBand(strategy());
    const cards = selectCards(loadCards(), { station, experience: band.experience, population: band.population });
    const compiled = compileStation({ station, cards, caseFile: caseFile([]) });
    systems.add(compiled.system);
    assert.equal(compiled.system, policy);
    assert.equal(compiled.user.includes("箱式深蹲"), false);
    assert.equal(compiled.user.includes("%1RM"), false);
    assert.equal(compiled.user.includes(readContract(station).slice(0, 8)), true);
    assert.equal(compiled.user.includes("candidates"), false);
  }
  assert.equal(systems.size, 1);
});

test("④ 只放入这次的候选", () => {
  const band = resolvedBand(strategy());
  const cards = selectCards(loadCards(), { station: "slots", experience: band.experience, population: band.population });
  const compiled = compileStation({
    station: "slots",
    cards,
    caseFile: {
      ...caseFile(["slots"]),
      candidates: [{ id: "bench", name: "卧推", patterns: ["Push"] }],
    },
  });
  assert.equal(compiled.system, readPolicy());
  assert.equal(compiled.user.includes('"bench"'), true);
  assert.equal(compiled.user.includes("箱式深蹲"), false);
  assert.equal(compiled.user.includes('"squat"'), false);
});

test("返工提示只带违规和上一次 JSON", () => {
  const repair = compileRepair(
    [{ code: "V2", field: "text", detail: "出现动作名「箱式深蹲」" }],
    { status: "ok", items: [] },
  );
  assert.equal(repair.includes("V2"), true);
  assert.equal(repair.includes("箱式深蹲"), true);
  assert.equal(repair.includes("判断本周需求集"), false);
});

test("校验器拒绝动作名、负荷、错 id 和越界占比，并丢掉未知规则", () => {
  const share = validateStation("demand-set", {
    status: "ok",
    appliedRuleIds: ["share.primary", "nope"],
    phase: "basic_strength",
    periodization: "linear",
    items: [
      { id: "d1", role: "primary", module: "力量", share: 80 },
      { id: "d2", role: "maintain", module: "维持", share: 20 },
    ],
  }, { cardIds: ["share.primary", "phase.span"], names, frequency: 3, movementsPerSession: [6, 8], injuryJoints: [] });
  assert.equal(share.kind, "violations");
  if (share.kind === "violations") assert.equal(share.violations.some((item) => item.code === "V-share"), true);

  const named = validateStation("demand-items", {
    status: "ok",
    appliedRuleIds: ["demand.no-name"],
    items: [{ id: "d1", pattern: "蹲", reason: "做箱式深蹲" }],
  }, { cardIds: ["demand.no-name"], names, frequency: 3, movementsPerSession: [6, 8], injuryJoints: ["膝"] });
  assert.equal(named.kind, "violations");
  if (named.kind === "violations") assert.equal(named.violations.some((item) => item.code === "V2"), true);

  const loaded = validateStation("slots", {
    status: "ok",
    appliedRuleIds: ["slots.no-load"],
    sessions: 3,
    slots: [{ slotId: "s1", pattern: "推", movementId: "bench", sets: 3 }],
  }, { cardIds: ["slots.no-load"], names, frequency: 3, movementsPerSession: [6, 8], injuryJoints: [] });
  assert.equal(loaded.kind, "violations");
  if (loaded.kind === "violations") assert.equal(loaded.violations.some((item) => item.code === "V-load"), true);

  const kept = validateStation("demand-set", {
    status: "ok",
    appliedRuleIds: ["share.primary", "nope"],
    phase: "basic_strength",
    periodization: "linear",
    items: [
      { id: "d1", role: "primary", module: "力量", share: 65 },
      { id: "d2", role: "maintain", module: "维持", share: 35 },
    ],
  }, { cardIds: ["share.primary"], names, frequency: 3, movementsPerSession: [6, 8], injuryJoints: [] });
  assert.equal(kept.kind, "ok");
  if (kept.kind === "ok" && "demandSet" in kept) assert.deepEqual(kept.demandSet.appliedRuleIds, ["share.primary"]);
});

test("超容退回需求集，动作池字样被拒绝", () => {
  const over = validateStation("slots", {
    status: "ok",
    appliedRuleIds: ["slots.capacity"],
    sessions: 5,
    slots: [{ slotId: "s1", session: 1, pattern: "蹲" }],
  }, { cardIds: ["slots.capacity"], names, frequency: 3, movementsPerSession: [6, 8], injuryJoints: [] });
  assert.equal(over.kind, "return");
  if (over.kind === "return") assert.equal(over.reasonTag, "恢复不足");

  const pool = validateStation("demand-items", {
    status: "ok",
    appliedRuleIds: ["demand.no-name"],
    items: [{ id: "d1", pattern: "蹲", reason: "先建动作池" }],
  }, { cardIds: ["demand.no-name"], names, frequency: 3, movementsPerSession: [6, 8], injuryJoints: [] });
  assert.equal(pool.kind, "violations");
  if (pool.kind === "violations") assert.equal(pool.violations.some((item) => item.code === "V-pool"), true);
});

test("动作库能按杠铃和膝约束读出来", () => {
  const library = loadMovementLibrary();
  assert.equal(library.length, 113);
  assert.equal(movementNames().includes("箱式深蹲"), true);
  const box = library.find((item) => item.id === "H44LJP302");
  assert.equal(box?.contraindications.includes("膝"), true);
  assert.equal(equipmentMatches(box!, ["杠铃"]), true);
  assert.equal(equipmentMatches({ id: "x", name: "x", patterns: [], equipment: ["EQ-GRP"], contraindications: [] }, ["杠铃"]), false);
});
