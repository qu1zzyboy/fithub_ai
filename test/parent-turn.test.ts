import assert from "node:assert/strict";
import test from "node:test";
import type { Decision, ParentPorts } from "../src/parent/ports.ts";
import { initialParentState, type ParentState } from "../src/parent/state.ts";
import { runParentTurn } from "../src/parent/turn.ts";

const PHRASE = "秘密原话：这句不能进任务说明";

function readyStrategy() {
  return {
    trainingType: "力量",
    frequencyPerWeek: 3,
    cycleWeeks: 8,
    level: "6个月-2年" as const,
    equipment: ["杠铃"],
    goals: ["力量"],
    injuryConfirmed: true,
    joints: ["膝"],
    chronicConditions: [] as string[],
  };
}

function ports(decision: Decision, overrides: Partial<ParentPorts> = {}) {
  const calls: string[] = [];
  const frameworkTasks: unknown[] = [];
  const reviewTasks: unknown[] = [];
  const base: ParentPorts = {
    async classify() {
      calls.push("classify");
      return decision;
    },
    async resolveAthlete(name) {
      calls.push(`resolve:${name}`);
      return { id: "a1", name };
    },
    async checkPermission() {
      calls.push("permission");
      return true;
    },
    async readInjuryTags() {
      calls.push("injuries");
      return { joints: ["膝"], chronicConditions: [] };
    },
    async assessmentExists() {
      calls.push("assessment");
      return true;
    },
    async callBusinessApi() {
      calls.push("api");
      return "接口结果";
    },
    async mergeTags() {
      calls.push("mergeTags");
    },
    async saveFramework() {
      calls.push("saveFramework");
    },
    async savePlanChange() {
      calls.push("savePlanChange");
    },
    async runFramework(task) {
      calls.push("runFramework");
      frameworkTasks.push(task);
      return { summary: "框架草案" };
    },
    async runReview(task) {
      calls.push("runReview");
      reviewTasks.push(task);
      return { summary: "复盘结论", change: task.proposeChange ? { summary: "加重" } : null };
    },
    ...overrides,
  };
  return { ports: base, calls, frameworkTasks, reviewTasks };
}

test("和运动无关时停下，不读档案也不写库", async () => {
  const fake = ports({ intent: "unrelated" });
  const result = await runParentTurn(initialParentState("c1"), "今天天气怎么样", fake.ports);
  assert.equal(result.reply.includes("做不了"), true);
  assert.deepEqual(fake.calls, ["classify"]);
});

test("还没有学员时只问名称", async () => {
  const fake = ports({ intent: "framework" });
  const result = await runParentTurn(initialParentState("c1"), PHRASE, fake.ports);
  assert.equal(result.reply.includes("学员名称"), true);
  assert.equal(fake.calls.includes("resolve:"), false);
  assert.equal(fake.calls.some((call) => call.startsWith("resolve")), false);
});

test("没有权限时不读档案", async () => {
  const fake = ports(
    { intent: "framework", athleteName: "张三" },
    { async checkPermission() { fake.calls.push("permission"); return false; } },
  );
  const result = await runParentTurn(initialParentState("c1"), PHRASE, fake.ports);
  assert.equal(result.reply.includes("权限"), true);
  assert.equal(fake.calls.includes("injuries"), false);
  assert.equal(fake.calls.includes("assessment"), false);
  assert.equal(fake.calls.includes("runFramework"), false);
});

test("说不清时追问，不拉起子 agent", async () => {
  const fake = ports({ intent: "unclear" });
  const result = await runParentTurn(initialParentState("c1"), PHRASE, fake.ports);
  assert.equal(result.reply.includes("排课"), true);
  assert.equal(fake.calls.includes("runFramework"), false);
  assert.equal(fake.calls.includes("runReview"), false);
});

test("一般运动问题只走接口", async () => {
  const state = { ...initialParentState("c1"), athlete: { id: "a1", name: "张三" } };
  const fake = ports({ intent: "api", needsAthlete: true });
  const result = await runParentTurn(state, "卧推怎么做", fake.ports);
  assert.equal(result.reply, "接口结果");
  assert.equal(fake.calls.includes("api"), true);
  assert.equal(fake.calls.includes("runFramework"), false);
  assert.equal(fake.calls.includes("mergeTags"), false);
  assert.equal(fake.calls.includes("saveFramework"), false);
});

test("伤病没确认时不拉起框架", async () => {
  const fake = ports({
    intent: "framework",
    athleteName: "张三",
    strategy: { ...readyStrategy(), injuryConfirmed: false },
  });
  const result = await runParentTurn(initialParentState("c1"), PHRASE, fake.ports);
  assert.equal(result.reply.includes("关节问题"), true);
  assert.equal(fake.calls.includes("injuries"), true);
  assert.equal(fake.calls.includes("runFramework"), false);
  assert.equal(fake.calls.includes("mergeTags"), false);
});

test("评估不在库时不拉起框架", async () => {
  const fake = ports(
    { intent: "framework", athleteName: "张三", strategy: readyStrategy() },
    { async assessmentExists() { fake.calls.push("assessment"); return false; } },
  );
  const result = await runParentTurn(initialParentState("c1"), PHRASE, fake.ports);
  assert.equal(result.reply.includes("评估不在库"), true);
  assert.equal(fake.calls.includes("runFramework"), false);
});

test("框架任务不含原话，确认后才写入", async () => {
  const fake = ports({ intent: "framework", athleteName: "张三", strategy: readyStrategy() });
  const drafted = await runParentTurn(initialParentState("c1"), PHRASE, fake.ports);
  assert.equal(drafted.state.pending?.kind, "framework");
  assert.equal(JSON.stringify(fake.frameworkTasks[0]).includes(PHRASE), false);
  assert.equal(fake.calls.includes("mergeTags"), true);
  assert.equal(fake.calls.includes("saveFramework"), false);

  const confirm = ports({ intent: "confirm" });
  const saved = await runParentTurn(drafted.state, "确认", confirm.ports);
  assert.equal(saved.reply.includes("框架已写入"), true);
  assert.equal(saved.state.pending, null);
  assert.equal(confirm.calls.includes("saveFramework"), true);
  assert.equal(confirm.calls.includes("runFramework"), false);
});

test("只查看时复盘任务不要求改法", async () => {
  const state: ParentState = { ...initialParentState("c1"), athlete: { id: "a1", name: "张三" } };
  const fake = ports({
    intent: "review",
    range: "最近两周",
    report: true,
    chart: false,
    proposeChange: false,
  });
  const result = await runParentTurn(state, "看看最近练得怎么样", fake.ports);
  assert.equal(result.state.pending?.kind, "review");
  assert.equal((fake.reviewTasks[0] as { proposeChange: boolean }).proposeChange, false);
  if (result.state.pending?.kind === "review") assert.equal(result.state.pending.result.change, null);
  assert.equal(fake.calls.includes("savePlanChange"), false);
});

test("确认改法才写入计划和参数", async () => {
  const state: ParentState = { ...initialParentState("c1"), athlete: { id: "a1", name: "张三" } };
  const fake = ports({
    intent: "review",
    range: "上一课",
    report: false,
    proposeChange: true,
  });
  const drafted = await runParentTurn(state, "上一课太轻了，给个改法", fake.ports);
  assert.equal(fake.calls.includes("savePlanChange"), false);
  const confirm = ports({ intent: "confirm" });
  const saved = await runParentTurn(drafted.state, "确认", confirm.ports);
  assert.equal(confirm.calls.includes("savePlanChange"), true);
  assert.equal(saved.state.pending, null);
});

test("发这一次课直接停下", async () => {
  const state: ParentState = { ...initialParentState("c1"), athlete: { id: "a1", name: "张三" } };
  const fake = ports({ intent: "session" });
  const result = await runParentTurn(state, "把这一次课发了", fake.ports);
  assert.equal(result.reply.includes("这一次课"), true);
  assert.deepEqual(fake.calls, ["classify"]);
});
