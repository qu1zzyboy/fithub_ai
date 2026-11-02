import assert from "node:assert/strict";
import test from "node:test";
import type { BusinessClient } from "../src/chat/business.ts";
import { buildH1 } from "../src/pipeline/m1.ts";
import { buildH2 } from "../src/pipeline/m2.ts";
import { buildH3, summarizeH3 } from "../src/pipeline/m3.ts";
import { createPipelineTools } from "../src/tools/pipeline.ts";
import { createRegistry } from "../src/tools/registry.ts";

test("M3 合成周计划并剔除红模块", () => {
  const h1 = buildH1({
    utterance: "我想减脂，每周练3次，每次60分钟",
    now: () => "2026-11-02T00:00:00.000Z",
  });
  const h2 = buildH2({
    injuryNote: "右膝急性疼痛",
    jointTags: ["关节问题:膝"],
    mobility: "pass",
    stability: "pass",
    strengthFloor: "pass",
    now: () => "2026-11-02T00:00:00.000Z",
  });
  const h3 = buildH3({
    h1,
    h2,
    frequency: 3,
    sessionMinutes: 60,
    preference: "lean_focus",
    horizon: "short",
    athleteName: "甲",
    now: () => "2026-11-02T00:00:00.000Z",
  });
  assert.equal(h3.handoff_id, "H3");
  assert.equal(h3.module_mix.primary, "m5");
  assert.equal(h3.module_mix.secondary.includes("m6"), false);
  assert.equal(h3.weekly_schedule.length, 3);
  assert.equal(h3.route.type, "A");
  assert.equal(h3.retest_cadence, "end");
  assert.equal(summarizeH3(h3).includes("主方向 m5"), true);
});

test("红线 H2 不能合成 H3", () => {
  const h1 = buildH1({ utterance: "减脂" });
  const h2 = buildH2({ injuryNote: "放射痛到小腿" });
  assert.throws(() => buildH3({ h1, h2 }), /红线/);
});

test("advance_pipeline_m3 读取已采纳 H1/H2 写 H3", async () => {
  const runId = "11111111-1111-4111-8111-111111111111";
  const h1 = buildH1({ utterance: "我想减脂每周3次" });
  const h2 = buildH2({
    injuryNote: "",
    mobility: "pass",
    stability: "pass",
    strengthFloor: "pass",
    hasAssessment: true,
  });
  const calls: string[] = [];
  const business: BusinessClient = {
    async searchUsers() { return []; },
    async listUsers() { return []; },
    async readUser() { return { id: "a1", name: "甲", tags: [] }; },
    async hasAssessment() { return true; },
    async listPeriodPlans() { return []; },
    async createPipelineRun() { throw new Error("不应新建"); },
    async appendPipelineHandoff(input) {
      calls.push(`append:${input.handoffId}:${input.accept ? "accept" : "draft"}`);
      return {
        run: {
          id: runId,
          staffId: "s1",
          userId: "a1",
          status: "awaiting_confirm",
          currentStation: "M3",
        },
        handoff: {
          id: "h3",
          runId,
          handoffId: "H3",
          version: 1,
          status: input.accept ? "accepted" : "draft",
          payload: input.payload,
        },
      };
    },
    async getPipelineRun() {
      calls.push("get");
      return { id: runId, staffId: "s1", userId: "a1", status: "drafting", currentStation: "M3" };
    },
    async listPipelineHandoffs(input) {
      calls.push(`list:${input.handoffId}`);
      if (input.handoffId === "H1") {
        return [{ id: "h1", runId, handoffId: "H1", version: 1, status: "accepted", payload: h1 }];
      }
      return [{ id: "h2", runId, handoffId: "H2", version: 1, status: "accepted", payload: h2 }];
    },
    async acceptPipelineHandoff() { throw new Error("已全部 accepted"); },
    async listChatSessions() { return []; },
    async getChatSession() { return null; },
    async saveChatSession() { throw new Error("本测试不存会话"); },
    async deleteChatSession() {},
  };

  const text = await createRegistry(createPipelineTools(business)).execute(
    "advance_pipeline_m3",
    { athleteName: "甲", frequency: 3, accept: true },
    {
      token: "t",
      clientId: "c",
      athleteId: null,
      athleteName: null,
      async bindAthlete(name) { return { id: "a1", name }; },
    },
  );
  assert.deepEqual(calls, ["get", "list:H1", "list:H2", "append:H3:accept"]);
  assert.equal(text.includes("周安排"), true);
  assert.equal(text.includes("m5") || text.includes("主"), true);
  assert.equal(/\bH[123]\b|\bM[123]\b|pipeline|当前站/.test(text), false);
});
