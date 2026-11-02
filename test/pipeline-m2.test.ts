import assert from "node:assert/strict";
import test from "node:test";
import type { BusinessClient, PipelineHandoff, PipelineRun } from "../src/chat/business.ts";
import { buildH2, evaluateRedline, summarizeH2 } from "../src/pipeline/m2.ts";
import { createPipelineTools } from "../src/tools/pipeline.ts";
import { createRegistry } from "../src/tools/registry.ts";

test("M2 红线与下肢急性三态", () => {
  assert.equal(evaluateRedline("放射痛到小腿").result, "refer");
  assert.equal(evaluateRedline("右膝有点酸").result, "pass");

  const h2 = buildH2({
    injuryNote: "右膝急性疼痛，蹲不下去",
    jointTags: ["关节问题:膝"],
    mobility: "pass",
    stability: "pass",
    strengthFloor: "fail",
    now: () => "2026-11-02T00:00:00.000Z",
  });
  assert.equal(h2.handoff_id, "H2");
  assert.equal(h2.redline.result, "pass");
  assert.equal(h2.entry_point.module, "m3");
  assert.equal(h2.module_states.find((item) => item.module === "m6")?.state, "red");
  assert.equal(h2.module_states.find((item) => item.module === "m3")?.state, "yellow");
  assert.equal(h2.injury_profile[0]?.site, "膝");
  assert.equal(summarizeH2(h2).includes("暂不安排"), true);
});

test("M2 门禁失败落入口①", () => {
  const h2 = buildH2({ hasAssessment: false, mobility: "fail" });
  assert.equal(h2.entry_point.module, "m1");
  assert.equal(h2.entry_point.gates.mobility, "fail");
});

test("advance_pipeline_m2 在 H1 已采纳后写 H2", async () => {
  const runId = "11111111-1111-4111-8111-111111111111";
  const calls: string[] = [];
  const h1Accepted: PipelineHandoff = {
    id: "h1",
    runId,
    handoffId: "H1",
    version: 1,
    status: "accepted",
    payload: { primary_module: "m5" },
  };
  const business: BusinessClient = {
    async searchUsers() { return []; },
    async listUsers() { return []; },
    async readUser() {
      return { id: "a1", name: "甲", tags: ["关节问题:膝"] };
    },
    async hasAssessment() { return true; },
    async listPeriodPlans() { return []; },
    async createPipelineRun() { throw new Error("不应新建"); },
    async appendPipelineHandoff(input) {
      calls.push(`append:${input.handoffId}:${input.accept ? "accept" : "draft"}`);
      const run: PipelineRun = {
        id: runId,
        staffId: "s1",
        userId: "a1",
        status: "drafting",
        currentStation: input.accept ? "M3" : "M2",
      };
      return {
        run,
        handoff: {
          id: "h2",
          runId,
          handoffId: "H2",
          version: 1,
          status: input.accept ? "accepted" : "draft",
          payload: input.payload,
        },
      };
    },
    async getPipelineRun() {
      calls.push("get");
      return { id: runId, staffId: "s1", userId: "a1", status: "drafting", currentStation: "M2" };
    },
    async listPipelineHandoffs() {
      calls.push("listH1");
      return [h1Accepted];
    },
    async acceptPipelineHandoff() { throw new Error("已有 accepted H1"); },
    async listChatSessions() { return []; },
    async getChatSession() { return null; },
    async saveChatSession() { throw new Error("本测试不存会话"); },
    async deleteChatSession() {},
  };

  const text = await createRegistry(createPipelineTools(business)).execute(
    "advance_pipeline_m2",
    { athleteName: "甲", injuryNote: "右膝慢性不适", accept: true },
    {
      token: "t",
      clientId: "c",
      athleteId: null,
      athleteName: null,
      async bindAthlete(name) { return { id: "a1", name }; },
    },
  );
  assert.deepEqual(calls, ["get", "listH1", "append:H2:accept"]);
  assert.equal(text.includes("安全定位"), true);
  assert.equal(text.includes("模块安排"), true);
  assert.equal(/\bH[123]\b|\bM[123]\b|pipeline|当前站/.test(text), false);
});
