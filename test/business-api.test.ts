import assert from "node:assert/strict";
import test from "node:test";
import { catalogForPrompt, loadCapabilities, normalizeCapability } from "../src/business/catalog.ts";
import { executeCapability } from "../src/business/execute.ts";
import type { BusinessClient } from "../src/chat/business.ts";
import { parseDecision, classifyUserText } from "../src/parent/classify.ts";
import { initialParentState } from "../src/parent/state.ts";
import { runParentTurn } from "../src/parent/turn.ts";
import type { Decision, ParentPorts } from "../src/parent/ports.ts";

function business(): BusinessClient & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async searchUsers() {
      return [];
    },
    async listUsers() {
      calls.push("listUsers");
      return [
        { id: "a1", name: "甲", tags: [] },
        { id: "a2", name: "乙", tags: ["训练目标:力量"] },
      ];
    },
    async readUser({ userId }) {
      calls.push(`read:${userId}`);
      return { id: userId, name: "甲", tags: ["训练目标:力量", "训练经验:6个月-2年", "关节问题:膝", "慢性病:无"] };
    },
    async hasAssessment({ userId }) {
      calls.push(`assessment:${userId}`);
      return userId === "a1";
    },
    async listPeriodPlans() {
      calls.push("plans");
      return [{ id: "p1", name: "八周力量", days: 56 }];
    },
    async createPipelineRun() {
      throw new Error("本测试不走规划会话");
    },
    async appendPipelineHandoff() {
      throw new Error("本测试不写交接物");
    },
    async getPipelineRun() { throw new Error("本测试不查 run"); },
    async listPipelineHandoffs() { return []; },
    async acceptPipelineHandoff() { throw new Error("本测试不确认"); },
    async listChatSessions() { return []; },
    async getChatSession() { return null; },
    async saveChatSession() { throw new Error("本测试不存会话"); },
    async deleteChatSession() {},
  };
}

function ports(decision: Decision, overrides: Partial<ParentPorts> = {}) {
  const calls: string[] = [];
  const client = business();
  const base: ParentPorts = {
    async classify() {
      return decision;
    },
    async resolveAthlete(name) {
      calls.push(`resolve:${name}`);
      return { id: "a1", name };
    },
    async checkPermission() {
      return true;
    },
    async readInjuryTags() {
      return { joints: [], chronicConditions: [] };
    },
    async assessmentExists() {
      return true;
    },
    async callBusinessApi(input) {
      calls.push(`api:${input.capability ?? ""}`);
      return executeCapability({
        capability: normalizeCapability(input.capability),
        token: "t",
        clientId: "c",
        athleteId: input.athleteId,
        athleteName: input.athleteName,
        business: client,
      });
    },
    async mergeTags() {},
    async saveFramework() {},
    async savePlanChange() {},
    async runFramework() {
      return { summary: "框架" };
    },
    async runReview() {
      return { summary: "复盘", change: null };
    },
    async loadMemory() {
      return "";
    },
    async remember() {},
    ...overrides,
  };
  return { ports: base, calls, client };
}

test("能力目录只有白名单只读项", () => {
  const ids = loadCapabilities().map((item) => item.id);
  assert.deepEqual(ids, [
    "list_my_athletes",
    "get_athlete_tags",
    "check_assessment",
    "list_period_plans",
    "none",
  ]);
  assert.equal(normalizeCapability("hack"), "none");
  assert.equal(catalogForPrompt().includes("list_my_athletes"), true);
});

test("分类用户消息带上只读能力目录", () => {
  const text = classifyUserText({ utterance: "名下有谁", state: initialParentState("c1") });
  assert.equal(text.includes("只读能力"), true);
  assert.equal(text.includes("list_my_athletes"), true);
});

test("api 决定会归一化 capability", () => {
  const decision = parseDecision('{"intent":"api","needsAthlete":false,"capability":"list_my_athletes"}');
  assert.equal(decision.intent, "api");
  if (decision.intent === "api") {
    assert.equal(decision.capability, "list_my_athletes");
    assert.equal(decision.needsAthlete, false);
  }
  const bad = parseDecision('{"intent":"api","needsAthlete":true,"capability":"drop_table"}');
  if (bad.intent === "api") assert.equal(bad.capability, "none");
});

test("名下学员走 list_my_athletes，不绑学员", async () => {
  const fake = ports({ intent: "api", needsAthlete: true, capability: "list_my_athletes" });
  const result = await runParentTurn(initialParentState("c1"), "帮我查一下我名下有哪些学员", fake.ports);
  assert.equal(result.reply.includes("甲"), true);
  assert.equal(result.reply.includes("乙"), true);
  assert.equal(fake.calls.some((call) => call.startsWith("resolve")), false);
  assert.equal(fake.client.calls.includes("listUsers"), true);
});

test("学员标签要先绑学员", async () => {
  const fake = ports({
    intent: "api",
    needsAthlete: false,
    capability: "get_athlete_tags",
    athleteName: "甲",
  });
  const result = await runParentTurn(initialParentState("c1"), "甲的标签呢", fake.ports);
  assert.equal(fake.calls.includes("resolve:甲"), true);
  assert.equal(result.reply.includes("训练目标 力量"), true);
  assert.equal(result.reply.includes("关节问题 膝"), true);
});

test("none 用分类器的 reply", async () => {
  const fake = ports({
    intent: "api",
    needsAthlete: false,
    capability: "none",
    reply: "卧推先练控制，再加重。",
  });
  const result = await runParentTurn(initialParentState("c1"), "卧推怎么做", fake.ports);
  assert.equal(result.reply, "卧推先练控制，再加重。");
  assert.equal(fake.client.calls.length, 0);
});

test("执行层直接格式化周期计划和评估", async () => {
  const client = business();
  assert.equal(
    await executeCapability({
      capability: "list_period_plans",
      token: "t",
      clientId: "c",
      athleteId: null,
      athleteName: null,
      business: client,
    }),
    "周期计划：八周力量。",
  );
  assert.equal(
    await executeCapability({
      capability: "check_assessment",
      token: "t",
      clientId: "c",
      athleteId: "a1",
      athleteName: "甲",
      business: client,
    }),
    "甲 的评估在库。",
  );
});
