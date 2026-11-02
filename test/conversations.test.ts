import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { BusinessClient } from "../src/chat/business.ts";
import { createChatService } from "../src/chat/handle.ts";
import { conversationsRoot, listConversations, loadConversation } from "../src/chat/conversations.ts";
import type { Decision } from "../src/parent/ports.ts";

const SESSION_A = "11111111-1111-4111-8111-111111111111";
const SESSION_B = "22222222-2222-4222-8222-222222222222";

function business(): BusinessClient {
  return {
    async searchUsers({ name }) {
      if (name !== "甲") return [];
      return [{ id: "a1", name: "甲", tags: ["关节问题:膝"] }];
    },
    async listUsers() {
      return [{ id: "a1", name: "甲", tags: ["关节问题:膝"] }];
    },
    async readUser() {
      return { id: "a1", name: "甲", tags: ["关节问题:膝", "慢性病:无"] };
    },
    async hasAssessment() {
      return false;
    },
    async listPeriodPlans() {
      return [];
    },
    async createPipelineRun() {
      throw new Error("本测试不走规划会话");
    },
    async appendPipelineHandoff() {
      throw new Error("本测试不写交接物");
    },
    async getPipelineRun() {
      throw new Error("本测试不查 run");
    },
    async listPipelineHandoffs() {
      return [];
    },
    async acceptPipelineHandoff() {
      throw new Error("本测试不确认");
    },
    async listChatSessions() { return []; },
    async getChatSession() { return null; },
    async saveChatSession() { throw new Error("本测试不存会话"); },
    async deleteChatSession() {},
  };
}

test("会话落盘后可 list/get，新进程也能恢复绑定", async () => {
  const root = mkdtempSync(join(tmpdir(), "fithub-ai-conv-"));
  try {
    const decisions: Decision[] = [
      { intent: "unrelated" },
      { intent: "framework", athleteName: "甲" },
    ];
    let step = 0;
    const service = createChatService({
      skipReact: true,
      business: business(),
      memoryRoot: root,
      async classify() {
        const decision = decisions[step];
        step += 1;
        if (!decision) throw new Error("没有下一步");
        return decision;
      },
    });

    await service.handle({
      token: "token",
      body: { sessionId: SESSION_A, coachId: "coach-1", utterance: "今天天气怎么样" },
    });
    const second = await service.handle({
      token: "token",
      body: { sessionId: SESSION_A, coachId: "coach-1", utterance: "给甲排课" },
    });
    assert.equal(second.payload.ok && second.payload.athleteName, "甲");

    const listed = await service.handle({
      token: "token",
      body: { sessionId: SESSION_B, coachId: "coach-1", action: "list" },
    });
    assert.equal(listed.payload.ok && "sessions" in listed.payload, true);
    if (!listed.payload.ok || !("sessions" in listed.payload)) throw new Error("应返回 sessions");
    assert.equal(listed.payload.sessions.length, 1);
    assert.equal(listed.payload.sessions[0].sessionId, SESSION_A);
    assert.match(listed.payload.sessions[0].title, /天气|排课|甲/);

    const onDisk = loadConversation(conversationsRoot(root), "coach-1", SESSION_A);
    assert.equal(onDisk?.state.athlete?.name, "甲");
    assert.equal(listConversations(conversationsRoot(root), "coach-1").length, 1);

    // 模拟服务重启：新 Map，仍能从磁盘 hydrate
    const restarted = createChatService({
      skipReact: true,
      business: business(),
      memoryRoot: root,
      async classify() {
        return { intent: "unclear" };
      },
    });
    const loaded = await restarted.handle({
      token: "token",
      body: { sessionId: SESSION_A, coachId: "coach-1", action: "get" },
    });
    assert.equal(loaded.payload.ok && loaded.payload.athleteName, "甲");
    assert.equal(loaded.payload.ok && (loaded.payload.messages?.length ?? 0) >= 2, true);

    await restarted.handle({
      token: "token",
      body: { sessionId: SESSION_A, coachId: "coach-1", action: "delete" },
    });
    const after = await restarted.handle({
      token: "token",
      body: { sessionId: SESSION_B, coachId: "coach-1", action: "list" },
    });
    assert.equal(after.payload.ok && "sessions" in after.payload && after.payload.sessions.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
