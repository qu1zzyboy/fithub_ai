import assert from "node:assert/strict";
import test from "node:test";
import type { BusinessClient } from "../src/chat/business.ts";
import { buildH1, inferUserType } from "../src/pipeline/m1.ts";
import { createPipelineTools } from "../src/tools/pipeline.ts";
import { createRegistry } from "../src/tools/registry.ts";

test("M1 推断用户类型与模块命中", () => {
  assert.equal(inferUserType("我想减脂还增点力量"), "fitness");
  assert.equal(inferUserType("下周有比赛要冲刺更快"), "performance");
  assert.equal(inferUserType("消防员考核前练负重"), "occupational");

  const h1 = buildH1({
    utterance: "我想减脂，顺便增点力量",
    now: () => "2026-10-30T00:00:00.000Z",
  });
  assert.equal(h1.handoff_id, "H1");
  assert.equal(h1.user_type, "fitness");
  assert.equal(h1.primary_module, "m5");
  assert.equal(h1.secondary_modules.includes("m3"), true);
  assert.equal(h1.raw_quote.includes("减脂"), true);
});

test("start_training_pipeline 开 run 并写 H1", async () => {
  const calls: string[] = [];
  const business: BusinessClient = {
    async searchUsers() { return []; },
    async listUsers() { return []; },
    async readUser() { return null; },
    async hasAssessment() { return false; },
    async listPeriodPlans() { return []; },
    async createPipelineRun(input) {
      calls.push(`create:${input.userId}`);
      return {
        id: "11111111-1111-4111-8111-111111111111",
        staffId: "s1",
        userId: input.userId,
        status: "drafting",
        currentStation: "M1",
      };
    },
    async appendPipelineHandoff(input) {
      calls.push(`append:${input.handoffId}:${input.accept ? "accept" : "draft"}`);
      return {
        run: {
          id: input.runId,
          staffId: "s1",
          userId: "a1",
          status: input.accept ? "drafting" : "awaiting_confirm",
          currentStation: input.accept ? "M2" : "M1",
        },
        handoff: {
          id: "22222222-2222-4222-8222-222222222222",
          runId: input.runId,
          handoffId: input.handoffId,
          version: 1,
          status: input.accept ? "accepted" : "draft",
          payload: input.payload,
        },
      };
    },
    async getPipelineRun() { throw new Error("本测试不查 run"); },
    async listPipelineHandoffs() { return []; },
    async acceptPipelineHandoff() { throw new Error("本测试不确认"); },
    async listChatSessions() { return []; },
    async getChatSession() { return null; },
    async saveChatSession() { throw new Error("本测试不存会话"); },
    async deleteChatSession() {},
  };

  const registry = createRegistry(createPipelineTools(business));
  const text = await registry.execute(
    "start_training_pipeline",
    { athleteName: "甲", utterance: "我想减脂", accept: true },
    {
      token: "t",
      clientId: "c",
      athleteId: null,
      athleteName: null,
      async bindAthlete(name) {
        return { id: "a1", name };
      },
    },
  );
  assert.equal(calls[0], "create:a1");
  assert.equal(calls[1], "append:H1:accept");
  assert.equal(text.includes("甲"), true);
  assert.equal(text.includes("m5"), true);
  assert.equal(text.includes("安全定位"), true);
  assert.equal(/\bH[123]\b|\bM[123]\b|pipeline|当前站/.test(text), false);
});
