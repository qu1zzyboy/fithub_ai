import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createChatService } from "../src/chat/handle.ts";
import { rememberTurn } from "../src/memory/remember.ts";
import {
  acceptMemory,
  parseMemoryNotes,
  readMemoryIndex,
  writeMemory,
  type MemoryNote,
} from "../src/memory/store.ts";

const TODAY = "2026-10-27";

function note(overrides: Partial<MemoryNote> = {}): MemoryNote {
  return {
    layer: "coach",
    name: "短回复",
    description: "以后回复短一点",
    body: "教练说以后回复短一点。",
    quote: "以后回复短一点",
    ...overrides,
  };
}

test("代码拒绝业务表、回复反推、未绑定学员和被放行的动作", () => {
  const said = "以后回复短一点";
  const reply = "好的，之后我会写短。";
  assert.equal(acceptMemory({
    layer: "coach",
    name: "短回复",
    description: "以后回复短一点",
    body: "教练说以后回复短一点。",
    quote: "模型自己补的",
  }, { utterance: said, reply, athleteId: null, today: TODAY }).ok, false);

  assert.equal(acceptMemory({
    layer: "coach",
    name: "短回复",
    description: "好的，之后我会写短。",
    body: "好的，之后我会写短。",
    quote: "短一点",
  }, { utterance: said, reply, athleteId: null, today: TODAY }).ok, false);

  assert.equal(acceptMemory({
    layer: "athlete",
    name: "本周膝不适",
    description: "这周膝不适",
    body: "教练说这周膝不适。",
    quote: "这周膝不适",
    expires: "2026-11-03",
  }, { utterance: "这周膝不适", reply: "", athleteId: null, today: TODAY }).ok, false);

  for (const word of ["可以做", "关节问题", "训练记录", "重量"]) {
    const verdict = acceptMemory({
      layer: "coach",
      name: "一条",
      description: `记一下${word}`,
      body: `教练原话里提到${word}。`,
      quote: "记一下",
    }, { utterance: `记一下${word}`, reply: "", athleteId: "a1", today: TODAY });
    assert.equal(verdict.ok, false, word);
  }

  const kept = acceptMemory(note(), { utterance: said, reply, athleteId: null, today: TODAY });
  assert.equal(kept.ok, true);
});

test("索引和正文分开，只带这位教练和未过期的学员", () => {
  const root = mkdtempSync(join(tmpdir(), "fithub-memory-"));
  writeMemory(root, { coachId: "c1", athleteId: null }, note());
  writeMemory(root, { coachId: "c2", athleteId: null }, note({ name: "另一位", description: "不要带上", body: "不要带上这位。", quote: "不要带上" }));
  writeMemory(root, { coachId: "c1", athleteId: "a1" }, note({
    layer: "athlete",
    name: "本周膝不适",
    description: "这周膝不适",
    body: "正文标记不应进索引",
    quote: "这周膝不适",
    expires: "2026-11-03",
  }));
  writeMemory(root, { coachId: "c1", athleteId: "a1" }, note({
    layer: "athlete",
    name: "上周肩紧",
    description: "上周肩紧",
    body: "已经过期",
    quote: "上周肩紧",
    expires: "2026-10-01",
  }));
  writeMemory(root, { coachId: "../system", athleteId: null }, note({ name: "越界", description: "不能写到系统层", body: "不能写到系统层。", quote: "不能" }));
  writeMemory(root, { coachId: "c1", athleteId: "../system" }, note({
    layer: "athlete",
    name: "越界学员",
    description: "不能写到系统层",
    body: "不能写到系统层。",
    quote: "不能",
  }));

  const coachOnly = readMemoryIndex(root, { coachId: "c1", athleteId: null }, TODAY);
  assert.equal(coachOnly, "教练\n- 短回复 | 以后回复短一点");
  assert.equal(coachOnly.includes("另一位"), false);
  assert.equal(coachOnly.includes("正文标记"), false);

  const bound = readMemoryIndex(root, { coachId: "c1", athleteId: "a1" }, TODAY);
  assert.equal(bound.includes("- 本周膝不适 | 这周膝不适 | 至 2026-11-03"), true);
  assert.equal(bound.includes("上周肩紧"), false);
  assert.equal(bound.includes("正文标记"), false);
  assert.equal(readMemoryIndex(root, { coachId: "c1", athleteId: "a2" }, TODAY).includes("本周膝不适"), false);
  assert.equal(readMemoryIndex(root, { coachId: "../system", athleteId: null }, TODAY), "");
  assert.equal(existsSync(join(root, "..", "system", "MEMORY.md")), false);
});

test("抽取只留下过了代码的条目", async () => {
  const root = mkdtempSync(join(tmpdir(), "fithub-memory-"));
  await rememberTurn({
    root,
    today: TODAY,
    utterance: "以后回复短一点，另外深蹲可以做",
    reply: "好的，之后我会写短。",
    coachId: "c1",
    athleteId: null,
    async propose() {
      return [
        note(),
        { layer: "coach", name: "放行", description: "深蹲可以做", body: "把深蹲写成可以做。", quote: "可以做" },
        { layer: "athlete", name: "本周膝不适", description: "这周膝不适", body: "这周膝不适。", quote: "这周膝不适", expires: "2026-11-03" },
      ];
    },
  });
  const index = readMemoryIndex(root, { coachId: "c1", athleteId: null }, TODAY);
  assert.equal(index, "教练\n- 短回复 | 以后回复短一点");
  assert.equal(parseMemoryNotes('说明\n{"notes":[{"layer":"coach","name":"短回复"}]}').length, 1);
});

test("对话有结论才写入这位教练的目录", async () => {
  const root = mkdtempSync(join(tmpdir(), "fithub-memory-"));
  let proposals = 0;
  const service = createChatService({
    memoryRoot: root,
    today: () => TODAY,
    async classify() {
      return { intent: "unrelated" };
    },
    async proposeMemories() {
      proposals += 1;
      return [note()];
    },
  });
  const saved = await service.handle({
    token: "token",
    body: { sessionId: "11111111-1111-4111-8111-111111111111", coachId: "c-mem", utterance: "以后回复短一点" },
  });
  assert.equal(saved.payload.ok, true);
  assert.equal(proposals, 1);
  assert.equal(readMemoryIndex(root, { coachId: "c-mem", athleteId: null }, TODAY).includes("短回复"), true);

  const asking = createChatService({
    memoryRoot: root,
    today: () => TODAY,
    async classify() {
      return { intent: "unclear" };
    },
    async proposeMemories() {
      proposals += 1;
      return [note({ name: "不该记", description: "听不清也不该记", body: "听不清也不该记。", quote: "听不清" })];
    },
  });
  await asking.handle({
    token: "token",
    body: { sessionId: "22222222-2222-4222-8222-222222222222", coachId: "c-mem", utterance: "听不清" },
  });
  assert.equal(proposals, 1);
  assert.equal(readMemoryIndex(root, { coachId: "c-mem", athleteId: null }, TODAY).includes("不该记"), false);
});
