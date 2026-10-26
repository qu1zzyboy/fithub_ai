import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runFrameworkAgent } from "../src/framework/run.ts";
import { assembleParentPorts } from "../src/parent/assemble.ts";
import type { Decision } from "../src/parent/ports.ts";
import { initialParentState, type FrameworkTask } from "../src/parent/state.ts";
import { runParentTurn } from "../src/parent/turn.ts";
import { runReviewAgent } from "../src/review/run.ts";
import type { FrameworkReads, MovementRecord, ReviewReads } from "../src/tools/read.ts";
import { frameworkTools, parentTools, reviewTools } from "../src/tools/sets.ts";
import type { ParentTools } from "../src/tools/sets.ts";

const FRAMEWORK_KEYS = [
  "readAssessment",
  "readEligibility",
  "readMovements",
  "readPeriodPlans",
  "readPlanTemplates",
  "readStrategy",
  "readTags",
];

const REVIEW_KEYS = [
  "readAssessment",
  "readCurrentPlan",
  "readMovementAbility",
  "readStrengthReserve",
  "readTrainingRecords",
];

function movement(id: string, blocks: string[]): MovementRecord {
  return { id, name: id, patterns: [], equipment: ["杠铃"], contraindications: blocks };
}

function task(): FrameworkTask {
  return {
    athleteId: "a1",
    athleteName: "甲",
    strategy: {
      trainingType: "力量",
      frequencyPerWeek: 3,
      cycleWeeks: 8,
      level: "6个月-2年",
      equipment: ["杠铃"],
    },
    injuries: { joints: ["膝"], chronicConditions: [] },
    assessmentInLibrary: true,
  };
}

function frameworkReads(movements: MovementRecord[] = [movement("squat", ["膝"]), movement("bench", [])]): FrameworkReads {
  return {
    async readStrategy() {
      return null;
    },
    async readTags() {
      return { 关节问题: ["膝"], 慢性病: [] };
    },
    async readAssessment() {
      return { id: "as1", joints: ["膝"], chronicConditions: [], summary: "已评估" };
    },
    async readMovements() {
      return movements;
    },
    async readPlanTemplates() {
      return [];
    },
    async readPeriodPlans() {
      return [];
    },
    async readEligibility() {
      return movements.map((item) => ({ movementId: item.id, allowed: true }));
    },
  };
}

function reviewReads(): ReviewReads {
  const squat = movement("squat", ["膝"]);
  const bench = movement("bench", []);
  return {
    async readTrainingRecords(athleteId) {
      assert.equal(athleteId, "a1");
      return [
        { id: "r1", athleteId, at: "d1", note: "第一课", load: 10, volume: 1, completed: true },
        { id: "r2", athleteId, at: "d2", note: "第二课", load: 20, volume: 2, completed: false },
      ];
    },
    async readAssessment() {
      return { id: "as1", joints: ["膝"], chronicConditions: [], summary: "已评估" };
    },
    async readMovementAbility() {
      return [];
    },
    async readStrengthReserve() {
      return [];
    },
    async readCurrentPlan() {
      return { id: "p1", summary: "当前计划", movements: [squat, bench] };
    },
  };
}

function parentBundle(): ParentTools & { saved: unknown[] } {
  const saved: unknown[] = [];
  return {
    saved,
    async resolveAthlete(name) {
      return { id: "a1", name };
    },
    async checkPermission() {
      return true;
    },
    async readInjuryTags() {
      return { joints: ["膝"], chronicConditions: [] };
    },
    async assessmentExists() {
      return true;
    },
    async callBusinessApi() {
      return "接口结果";
    },
    async mergeTags() {},
    async saveFramework(_athleteId, framework) {
      saved.push(framework);
    },
    async savePlanChange() {},
  };
}

test("三组工具只保留各自的读写", () => {
  const framework = frameworkTools({ ...frameworkReads(), saveFramework: async () => {} } as FrameworkReads);
  const review = reviewTools({ ...reviewReads(), mergeTags: async () => {} } as ReviewReads);
  const parent = parentTools({ ...parentBundle(), readMovements: async () => [] } as ParentTools);
  assert.deepEqual(Object.keys(framework).sort(), FRAMEWORK_KEYS);
  assert.deepEqual(Object.keys(review).sort(), REVIEW_KEYS);
  assert.equal("saveFramework" in framework, false);
  assert.equal("mergeTags" in review, false);
  assert.equal("readMovements" in parent, false);
  assert.equal("saveFramework" in parent, true);
});

test("框架子 agent 拿到写工具时直接停下", async () => {
  const tools = frameworkReads();
  let read = false;
  tools.readStrategy = async () => {
    read = true;
    return null;
  };
  Object.assign(tools, { saveFramework: async () => {} });
  await assert.rejects(() => runFrameworkAgent(task(), tools, async () => ({ slots: [] })), /不能拿写工具/);
  assert.equal(read, false);
});

test("评估不在库时不读动作库，也不提议", async () => {
  const tools = frameworkReads();
  let movements = 0;
  tools.readAssessment = async () => null;
  tools.readMovements = async () => {
    movements += 1;
    return [];
  };
  const result = await runFrameworkAgent(task(), tools, async () => {
    throw new Error("不应提议");
  });
  assert.equal(result.summary, "评估不在库，不能排课。");
  assert.equal(movements, 0);
});

test("禁忌规则盖过工具返回的允许，库外动作填不进去", async () => {
  let sawUtterance = false;
  const result = await runFrameworkAgent(task(), frameworkReads(), async (context) => {
    sawUtterance = "utterance" in context || JSON.stringify(context).includes("秘密原话");
    return {
      slots: [
        { slotId: "s1", pattern: "蹲", movementId: "squat" },
        { slotId: "s2", pattern: "推", movementId: "bench", params: { sets: 3, reps: "5" } },
        { slotId: "s3", pattern: "拉", movementId: "ghost" },
      ],
    };
  });
  assert.equal(sawUtterance, false);
  assert.equal(result.slots?.[0]?.movementId, undefined);
  assert.equal(result.slots?.[0]?.unfilledReason, "禁忌：膝");
  assert.equal(result.slots?.[1]?.movementId, "bench");
  assert.equal(result.slots?.[2]?.unfilledReason, "不在动作库");
});

test("复盘用固定算法算负荷，沙盒拿不到这三项", async () => {
  const seen: object[] = [];
  const result = await runReviewAgent(
    { athleteId: "a1", athleteName: "甲", range: "近四周", report: true, chart: true, proposeChange: true },
    reviewReads(),
    async (facts) => {
      assert.deepEqual(facts.metrics, { load: 30, volume: 3, completion: 0.5 });
      return { summary: "看过了", report: "报告", change: { summary: "调整", movementIds: ["squat", "bench"] } };
    },
    (rows) => {
      seen.push(...rows);
      return { figure: "图" };
    },
  );
  assert.deepEqual(seen, [
    { id: "r1", at: "d1", note: "第一课" },
    { id: "r2", at: "d2", note: "第二课" },
  ]);
  assert.equal(result.chart, "图");
  assert.equal(result.report, "报告");
  assert.deepEqual(result.change, { summary: "调整", movementIds: ["bench"] });
});

test("只查看时不交改法，也不打开沙盒", async () => {
  const result = await runReviewAgent(
    { athleteId: "a1", athleteName: "甲", range: "上次", report: false, chart: false, proposeChange: false },
    reviewReads(),
    async () => ({ summary: "只看负荷", change: { summary: "加重", movementIds: ["squat"] } }),
    () => {
      throw new Error("不应打开沙盒");
    },
  );
  assert.equal(result.summary, "只看负荷");
  assert.equal(result.change, null);
  assert.equal(result.chart, undefined);
  assert.equal(result.report, undefined);
});

test("改法里的动作都被禁忌拒绝时，不留下可写入的改法", async () => {
  const result = await runReviewAgent(
    { athleteId: "a1", athleteName: "甲", range: "近四周", report: false, chart: false, proposeChange: true },
    reviewReads(),
    async () => ({ summary: "想换成深蹲", change: { summary: "换成深蹲", movementIds: ["squat"] } }),
  );
  assert.equal(result.change, null);
  assert.equal(result.summary.includes("没有可写入的改法"), true);
});

test("沙盒文件不连接数据库", () => {
  const source = readFileSync(new URL("../src/review/sandbox.ts", import.meta.url), "utf8");
  assert.equal(source.includes("import"), false);
  assert.equal(source.includes("fetch"), false);
});

test("确认之前主循环不写框架，确认后写入的是过滤过的 Slot", async () => {
  const bundle = parentBundle();
  const decisions: Decision[] = [
    {
      intent: "framework",
      athleteName: "甲",
      strategy: {
        trainingType: "力量",
        frequencyPerWeek: 3,
        cycleWeeks: 8,
        level: "6个月-2年",
        equipment: ["杠铃"],
        goals: ["力量"],
        injuryConfirmed: true,
        joints: ["膝"],
        chronicConditions: [],
      },
    },
    { intent: "confirm" },
  ];
  let step = 0;
  const ports = assembleParentPorts({
    async classify() {
      const decision = decisions[step];
      step += 1;
      if (!decision) throw new Error("没有下一步决定");
      return decision;
    },
    tools: bundle,
    framework: frameworkReads(),
    review: reviewReads(),
    async proposeFramework() {
      return { slots: [{ slotId: "s1", pattern: "蹲", movementId: "squat" }] };
    },
    async composeReview() {
      return { summary: "无", change: null };
    },
  });
  const draft = await runParentTurn(initialParentState("c1"), "秘密原话：排个力量课", ports);
  assert.equal(bundle.saved.length, 0);
  assert.equal(draft.state.pending?.kind, "framework");
  if (draft.state.pending?.kind !== "framework") return;
  assert.equal(draft.state.pending.result.slots?.[0]?.unfilledReason, "禁忌：膝");
  assert.equal(JSON.stringify(draft.state.pending.task).includes("秘密原话"), false);

  const saved = await runParentTurn(draft.state, "确认", ports);
  assert.equal(saved.reply, "框架已写入。");
  assert.equal(bundle.saved.length, 1);
  assert.equal(JSON.stringify(bundle.saved[0]).includes("squat"), false);
});
