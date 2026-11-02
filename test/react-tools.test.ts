import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { BusinessClient } from "../src/chat/business.ts";
import { createChatService } from "../src/chat/handle.ts";
import { parseAssistantTurn, toLlmMessages } from "../src/llm/messages.ts";
import { runReactTurn } from "../src/parent/react.ts";
import { appendChat, initialParentState } from "../src/parent/state.ts";
import { decisionFromHandoff } from "../src/parent/handoff.ts";
import { createDispatchTools, handoffKind, parseHandoff } from "../src/tools/dispatch.ts";
import { createReadonlyTools } from "../src/tools/readonly.ts";
import { createRegistry, WRITE_TOOLS } from "../src/tools/registry.ts";

const SESSION = "22222222-2222-4222-8222-222222222222";

function tempMemoryRoot(): { root: string; cleanup(): void } {
  const root = mkdtempSync(join(tmpdir(), "fithub-ai-react-"));
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function business(): BusinessClient {
  return {
    async searchUsers({ name }) {
      if (name !== "甲") return [];
      return [{ id: "a1", name: "甲", tags: ["训练目标:力量"] }];
    },
    async listUsers() {
      return [
        { id: "a1", name: "甲", tags: [] },
        { id: "a2", name: "乙", tags: [] },
      ];
    },
    async readUser() {
      return { id: "a1", name: "甲", tags: ["训练目标:力量", "关节问题:膝", "慢性病:无"] };
    },
    async hasAssessment() {
      return true;
    },
    async listPeriodPlans() {
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

test("历史裁剪和 Anthropic 消息转换", () => {
  let state = initialParentState("c1");
  for (let i = 0; i < 70; i += 1) {
    state = appendChat(state, { role: "user", content: `u${i}` }, { role: "assistant", content: `a${i}` });
  }
  assert.equal(state.messages.length, 120);
  assert.equal(state.messages[0]?.content, "u10");

  const withTools = appendChat(initialParentState("c1"),
    { role: "user", content: "名下有谁" },
    {
      role: "assistant",
      content: "",
      toolUses: [{ id: "1", name: "list_my_athletes", input: {} }],
    },
    { role: "tool", content: "名下学员：甲。", toolUseId: "1", toolName: "list_my_athletes" },
  );
  const llm = toLlmMessages(withTools.messages);
  assert.equal(llm[0]?.role, "user");
  assert.equal(llm[1]?.role, "assistant");
  assert.equal(Array.isArray(llm[1]?.content), true);
  assert.equal(llm[2]?.role, "user");
});

test("解析 tool_use，注册表拒绝写入", () => {
  const turn = parseAssistantTurn({
    stop_reason: "tool_use",
    content: [
      { type: "text", text: "我查一下。" },
      { type: "tool_use", id: "tu1", name: "list_my_athletes", input: {} },
    ],
  });
  assert.equal(turn.text, "我查一下。");
  assert.equal(turn.toolUses[0]?.name, "list_my_athletes");

  assert.throws(
    () => createRegistry([{
      name: WRITE_TOOLS[0],
      description: "no",
      inputSchema: { type: "object", properties: {} },
      async execute() { return ""; },
    }]),
    /写入工具不能进注册表/,
  );
  const registry = createRegistry([...createReadonlyTools(business()), ...createDispatchTools()]);
  assert.equal(registry.has("list_my_athletes"), true);
  assert.equal(registry.has("save_framework"), false);
  assert.equal(handoffKind("HANDOFF:framework"), "framework");
  const payload = parseHandoff('HANDOFF:{"target":"framework","athleteName":"甲","note":"排力量"}');
  assert.equal(payload?.target, "framework");
  assert.equal(payload?.athleteName, "甲");
  assert.equal(decisionFromHandoff(payload!).intent, "framework");
});

test("ReAct 查名下学员，不再问排课还是复盘", async () => {
  const registry = createRegistry([...createReadonlyTools(business()), ...createDispatchTools()]);
  const turns = [
    {
      text: "",
      toolUses: [{ id: "1", name: "list_my_athletes", input: {} }],
      stopReason: "tool_use",
    },
    {
      text: "名下学员：甲、乙。",
      toolUses: [],
      stopReason: "end_turn",
    },
  ];
  let step = 0;
  const result = await runReactTurn(initialParentState("c1"), "帮我查一下我名下有哪些学员", {
    registry,
    context: {
      token: "t",
      clientId: "c",
      athleteId: null,
      athleteName: null,
      async bindAthlete() { return null; },
    },
    async runModel() {
      const turn = turns[step];
      step += 1;
      if (!turn) throw new Error("没有下一步模型输出");
      return turn;
    },
  });
  assert.equal(result.kind, "done");
  if (result.kind === "done") {
    assert.equal(result.reply.includes("甲"), true);
    assert.equal(result.reply.includes("排课"), false);
    assert.equal(result.concluded, true);
    assert.equal(result.state.messages.some((item) => item.role === "tool"), true);
  }
});

test("ReAct 遇到 dispatch_framework 交回旧路", async () => {
  const registry = createRegistry([...createReadonlyTools(business()), ...createDispatchTools()]);
  const result = await runReactTurn(initialParentState("c1"), "给甲排力量课", {
    registry,
    context: {
      token: "t",
      clientId: "c",
      athleteId: null,
      athleteName: null,
      async bindAthlete(name) { return { id: "a1", name }; },
    },
    async runModel() {
      return {
        text: "",
        toolUses: [{ id: "1", name: "dispatch_framework", input: { athleteName: "甲", note: "排力量" } }],
        stopReason: "tool_use",
      };
    },
  });
  assert.equal(result.kind, "handoff");
  if (result.kind === "handoff") {
    assert.equal(result.target, "framework");
    assert.equal(result.payload.athleteName, "甲");
    assert.equal(result.decision.intent, "framework");
    if (result.decision.intent === "framework") {
      assert.equal(result.decision.athleteName, "甲");
      assert.equal(result.decision.strategy?.trainingType, "力量");
    }
  }
});

test("对话服务 dispatch 后跳过分类，直接进排课门禁", async () => {
  const { root, cleanup } = tempMemoryRoot();
  try {
    let classified = 0;
    const service = createChatService({
      business: business(),
      memoryRoot: root,
      async classify() {
        classified += 1;
        throw new Error("dispatch 后不应再分类");
      },
      async runModel() {
        return {
          text: "",
          toolUses: [{ id: "1", name: "dispatch_framework", input: { athleteName: "甲", note: "排力量" } }],
          stopReason: "tool_use",
        };
      },
    });
    const first = await service.handle({
      token: "token",
      body: { sessionId: SESSION, coachId: "c1", clientId: "client", utterance: "给甲排力量课" },
    });
    assert.equal(classified, 0);
    assert.equal(first.payload.ok, true);
    if (first.payload.ok) {
      assert.equal(first.payload.athleteName, "甲");
      // 伤病未确认：门禁问关节/慢性病，而不是「排课还是复盘」
      assert.equal(first.payload.reply.includes("关节问题"), true);
      assert.equal(first.payload.reply.includes("排课还是"), false);
    }
  } finally {
    cleanup();
  }
});

test("门禁续聊不再走 ReAct，确认伤病后继续追问策略", async () => {
  const { root, cleanup } = tempMemoryRoot();
  try {
    const turns = [
      {
        text: "",
        toolUses: [{ id: "1", name: "dispatch_framework", input: { athleteName: "甲", note: "排力量" } }],
        stopReason: "tool_use",
      },
    ];
    let step = 0;
    let classified = 0;
    const service = createChatService({
      business: business(),
      memoryRoot: root,
      async classify() {
        classified += 1;
        return {
          intent: "framework",
          athleteName: "甲",
          strategy: {
            injuryConfirmed: true,
            joints: ["膝"],
            chronicConditions: [],
            trainingType: "力量",
          },
        };
      },
      async runModel() {
        const turn = turns[step];
        step += 1;
        if (!turn) throw new Error("门禁续聊不应再调 ReAct 模型");
        return turn;
      },
    });
    const first = await service.handle({
      token: "token",
      body: { sessionId: SESSION, coachId: "c1", clientId: "client", utterance: "给甲排力量课" },
    });
    assert.equal(first.payload.ok && first.payload.reply.includes("关节问题"), true);
    assert.equal(classified, 0);

    const second = await service.handle({
      token: "token",
      body: { sessionId: SESSION, coachId: "c1", clientId: "client", utterance: "确认无，就这些" },
    });
    assert.equal(classified, 1);
    assert.equal(step, 1);
    assert.equal(second.payload.ok && second.payload.reply.includes("排课还缺"), true);
  } finally {
    cleanup();
  }
});

test("对话服务走 ReAct 列出学员，第二句带着历史", async () => {
  const { root, cleanup } = tempMemoryRoot();
  try {
    const turns = [
      {
        text: "",
        toolUses: [{ id: "1", name: "list_my_athletes", input: {} }],
        stopReason: "tool_use",
      },
      { text: "名下学员：甲、乙。", toolUses: [], stopReason: "end_turn" },
      { text: "还是这两位：甲、乙。", toolUses: [], stopReason: "end_turn" },
    ];
    let step = 0;
    const service = createChatService({
      business: business(),
      memoryRoot: root,
      async classify() {
        throw new Error("只读查询不应退回分类");
      },
      async runModel() {
        const turn = turns[step];
        step += 1;
        if (!turn) throw new Error("没有下一步");
        return turn;
      },
    });
    const first = await service.handle({
      token: "token",
      body: { sessionId: SESSION, coachId: "c1", clientId: "client", utterance: "你能帮我看下我名下有哪些学员吗" },
    });
    assert.equal(first.payload.ok && first.payload.reply.includes("甲"), true);
    assert.equal(first.payload.ok && first.payload.reply.includes("排课"), false);

    const second = await service.handle({
      token: "token",
      body: { sessionId: SESSION, coachId: "c1", clientId: "client", utterance: "我就是要看一下我名下有哪些学员" },
    });
    assert.equal(second.payload.ok && second.payload.reply.includes("甲"), true);
    assert.equal(step, 3);
  } finally {
    cleanup();
  }
});
