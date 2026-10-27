import assert from "node:assert/strict";
import test from "node:test";
import type { BusinessClient } from "../src/chat/business.ts";
import { CHAT_PATH, createChatService, DEFAULT_PORT, routeChat } from "../src/chat/handle.ts";
import type { Decision } from "../src/parent/ports.ts";

const SESSION = "11111111-1111-4111-8111-111111111111";

function business(): BusinessClient & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async searchUsers({ name }) {
      calls.push(`search:${name}`);
      if (name !== "甲") return [];
      return [{ id: "a1", name: "甲", tags: ["关节问题:膝"] }];
    },
    async readUser() {
      calls.push("read");
      return { id: "a1", name: "甲", tags: ["关节问题:膝", "慢性病:无"] };
    },
    async hasAssessment() {
      calls.push("assessment");
      return false;
    },
  };
}

test("只接受带登录态的 /api/v1/ai-chat", async () => {
  assert.equal(DEFAULT_PORT, 4000);
  const service = createChatService({ business: business(), async classify() { throw new Error("不应分类"); } });
  const missing = await routeChat({ method: "GET", path: "/api/v1/other", authorization: undefined, rawBody: "" }, service);
  assert.equal(missing.status, 404);
  const denied = await routeChat({
    method: "POST",
    path: CHAT_PATH,
    authorization: undefined,
    rawBody: JSON.stringify({ sessionId: SESSION, coachId: "c1", utterance: "你好" }),
  }, service);
  assert.equal(denied.status, 401);
});

test("和运动无关时不查学员，会话留在服务里", async () => {
  const fake = business();
  const decisions: Decision[] = [
    { intent: "unrelated" },
    { intent: "framework", athleteName: "甲" },
  ];
  let step = 0;
  const service = createChatService({
    business: fake,
    async classify() {
      const decision = decisions[step];
      step += 1;
      if (!decision) throw new Error("没有下一步");
      return decision;
    },
  });
  const first = await service.handle({
    token: "token",
    body: { sessionId: SESSION, coachId: "c1", utterance: "今天天气怎么样" },
  });
  assert.equal(first.status, 200);
  assert.equal(first.payload.ok && first.payload.reply.includes("做不了"), true);
  assert.deepEqual(fake.calls, []);

  const second = await service.handle({
    token: "token",
    body: { sessionId: SESSION, coachId: "c1", utterance: "给甲排课" },
  });
  assert.equal(second.payload.ok && second.payload.athleteName, "甲");
  assert.equal(second.payload.ok && second.payload.reply.includes("膝"), true);
  assert.deepEqual(fake.calls, ["search:甲", "read"]);

  const reset = await service.handle({ token: "token", body: { sessionId: SESSION, coachId: "c1", reset: true } });
  assert.equal(reset.payload.ok && reset.payload.athleteName, null);
});
