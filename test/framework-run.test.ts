import assert from "node:assert/strict";
import test from "node:test";
import { runFrameworkAgent } from "../src/framework/run.ts";
import type { StationCall } from "../src/framework/prompt/types.ts";
import type { FrameworkTask } from "../src/parent/state.ts";
import type { FrameworkReads, MovementRecord } from "../src/tools/read.ts";

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

function reads(): FrameworkReads {
  const bench: MovementRecord = { id: "bench", name: "卧推", patterns: ["Push"], equipment: ["杠铃"], contraindications: [] };
  return {
    async readStrategy() { return null; },
    async readTags() { return { 关节问题: ["膝"], 慢性病: [] }; },
    async readAssessment() { return { id: "as1", joints: ["膝"], chronicConditions: [], summary: "已评估" }; },
    async readMovements() { return [bench]; },
    async readPlanTemplates() { return []; },
    async readPeriodPlans() { return []; },
    async readEligibility() { return [{ movementId: "bench", allowed: true }]; },
  };
}

function okAnswer(call: StationCall, sessions = 3) {
  if (call.station === "demand-set") {
    return {
      status: "ok",
      appliedRuleIds: call.cardIds,
      phase: "basic_strength",
      periodization: "linear",
      items: [
        { id: "d1", role: "primary", module: "力量", share: 65 },
        { id: "d2", role: "maintain", module: "维持", share: 35 },
      ],
    };
  }
  if (call.station === "demand-items") {
    return {
      status: "ok",
      appliedRuleIds: call.cardIds,
      items: [{ id: "d1", pattern: "蹲", reason: call.repair ? "下肢力量" : "做箱式深蹲" }],
    };
  }
  if (call.station === "diagnosis") {
    return {
      status: "ok",
      appliedRuleIds: call.cardIds,
      constraints: [{ joint: "膝", dimension: "减小膝前负荷" }],
      breakpoints: [],
    };
  }
  return {
    status: "ok",
    appliedRuleIds: call.cardIds,
    sessions,
    slots: [{ slotId: "s1", session: 1, pattern: "推", movementId: "bench" }],
  };
}

test("需求条目出现动作名时只返工一次", async () => {
  let repairs = 0;
  let asks = 0;
  const result = await runFrameworkAgent(task(), reads(), {
    async answer(call) {
      asks += 1;
      if (call.repair) repairs += 1;
      return okAnswer(call);
    },
  });
  assert.equal(repairs, 1);
  assert.equal(asks, 5);
  assert.equal(result.slots?.[0]?.movementId, "bench");
  assert.equal(result.summary.includes("主模块占比 65%"), true);
  assert.equal(result.demandItems?.items[0]?.reason, "下肢力量");
});

test("课次数超过频率时退回需求集再排一次", async () => {
  let demandSets = 0;
  const result = await runFrameworkAgent(task(), reads(), {
    async answer(call) {
      if (call.station === "demand-set") demandSets += 1;
      if (call.station === "slots" && !call.user.includes("bounceReason")) return okAnswer(call, 5);
      if (call.station === "demand-items") {
        return {
          status: "ok",
          appliedRuleIds: call.cardIds,
          items: [{ id: "d1", pattern: "蹲", reason: "下肢力量" }],
        };
      }
      return okAnswer(call, 3);
    },
  });
  assert.equal(demandSets, 2);
  assert.equal(result.slots?.[0]?.movementId, "bench");
  assert.equal(result.demandSet?.items[0]?.share, 65);
});
