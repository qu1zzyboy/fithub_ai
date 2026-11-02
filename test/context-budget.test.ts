import assert from "node:assert/strict";
import test from "node:test";
import {
  buildReactSystem,
  clipToolResult,
  estimateMessagesTokens,
  extractiveSummary,
  formatWorkingState,
  maybeRollSummary,
  messagesForModel,
  sliceRecentByTokens,
  TOOL_RESULT_MAX_CHARS,
} from "../src/parent/contextBudget.ts";
import { appendChat, initialParentState, type ChatMessage } from "../src/parent/state.ts";
import { runReactTurn } from "../src/parent/react.ts";
import { createRegistry } from "../src/tools/registry.ts";

test("tool 结果超长会被截断", () => {
  const long = "学".repeat(TOOL_RESULT_MAX_CHARS + 80);
  const clipped = clipToolResult(long);
  assert.equal(clipped.includes("已截断"), true);
  assert.equal(clipped.length < long.length, true);
});

test("近窗按 token 切开并保留尾部", () => {
  const messages: ChatMessage[] = [];
  for (let i = 0; i < 20; i += 1) {
    messages.push({ role: "user", content: `第${i}轮：${"目标减脂与力量".repeat(40)}` });
    messages.push({ role: "assistant", content: `回复${i}：${"先确认伤病再排课".repeat(40)}` });
  }
  const { recent, older } = sliceRecentByTokens(messages, 800);
  assert.equal(recent.length > 0, true);
  assert.equal(older.length > 0, true);
  assert.equal(recent[recent.length - 1]?.content.includes("19"), true);
  assert.equal(estimateMessagesTokens(recent) <= 800 + 200, true);
});

test("超阈值滚动摘要，不删 UI messages", async () => {
  let state = initialParentState("c1");
  for (let i = 0; i < 30; i += 1) {
    state = appendChat(
      state,
      { role: "user", content: `教练说第${i}次：${"右膝不适需要注意".repeat(50)}` },
      { role: "assistant", content: `助手回第${i}次：${"先做安全定位".repeat(50)}` },
    );
  }
  const next = await maybeRollSummary(state, async (older) => {
    assert.equal(older.length > 0, true);
    return "摘要：教练多次提到右膝，需要安全定位。";
  }, { threshold: 500, recentBudget: 400, minFresh: 2 });
  assert.equal(next.sessionSummary?.includes("右膝"), true);
  assert.equal(next.messages.length, state.messages.length);
  assert.equal((next.summaryThrough ?? 0) > 0, true);
  assert.equal(messagesForModel(next, 400).length > 0, true);

  const again = await maybeRollSummary(next, async () => {
    throw new Error("不应重复摘要同一批");
  }, { threshold: 500, recentBudget: 400, minFresh: 2 });
  assert.equal(again.sessionSummary, next.sessionSummary);
});

test("工作态与记忆进入 system", () => {
  const state = {
    ...initialParentState("c1"),
    athlete: { id: "a1", name: "甲" },
    activeGate: "framework" as const,
    sessionSummary: "Earlier: 甲想减脂",
  };
  const system = buildReactSystem({
    policy: "策略",
    memoryIndex: "教练\n- 短回复 | 要短一点",
    workingState: formatWorkingState(state),
    sessionSummary: state.sessionSummary,
  });
  assert.equal(system.includes("甲"), true);
  assert.equal(system.includes("短回复"), true);
  assert.equal(system.includes("Earlier"), true);
  assert.equal(extractiveSummary([{ role: "user", content: "给甲排课" }]).includes("甲"), true);
});

test("ReAct 会把记忆索引交给模型 system", async () => {
  const seen: string[] = [];
  await runReactTurn(initialParentState("c1"), "你好", {
    registry: createRegistry([]),
    context: {
      token: "t",
      clientId: "c",
      athleteId: null,
      athleteName: null,
      async bindAthlete() { return null; },
    },
    async loadMemory() {
      return "教练\n- 短回复 | 以后短一点";
    },
    async runModel(input) {
      seen.push(input.system);
      return { text: "好的。", toolUses: [], stopReason: "end_turn" };
    },
  });
  assert.equal(seen[0]?.includes("短回复"), true);
  assert.equal(seen[0]?.includes("本轮工作态"), true);
});
