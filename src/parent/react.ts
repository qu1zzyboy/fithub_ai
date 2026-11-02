import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runModelTurn } from "../llm/messages.ts";
import type { AssistantTurn } from "../llm/types.ts";
import { parseHandoff, type HandoffPayload } from "../tools/dispatch.ts";
import type { ToolContext, ToolRegistry } from "../tools/registry.ts";
import {
  buildReactSystem,
  clipToolResult,
  formatWorkingState,
  maybeRollSummary,
  messagesForModel,
} from "./contextBudget.ts";
import { decisionFromHandoff } from "./handoff.ts";
import type { CoachDecision } from "./ports.ts";
import { appendChat, type ChatMessage, type ParentState } from "./state.ts";

const POLICY = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../agents/parent/react.md"), "utf8");

export const REACT_MAX_ROUNDS = 3;

export type ReactResult =
  | { kind: "done"; state: ParentState; reply: string; concluded: boolean }
  | {
      kind: "handoff";
      state: ParentState;
      target: "framework" | "review";
      payload: HandoffPayload;
      decision: CoachDecision;
    };

export interface ReactDeps {
  registry: ToolRegistry;
  context: ToolContext;
  runModel?: typeof runModelTurn;
  loadMemory?: (input: { coachId: string; athleteId: string | null }) => Promise<string>;
  summarize?: (older: ChatMessage[]) => Promise<string>;
}

/**
 * 只读 ReAct 轨。遇到 dispatch_* 就带着决策交回旧主循环，不再二次分类。
 */
export async function runReactTurn(
  state: ParentState,
  utterance: string,
  deps: ReactDeps,
): Promise<ReactResult> {
  const runModel = deps.runModel ?? runModelTurn;
  let next = appendChat(state, { role: "user", content: utterance });
  if (deps.summarize) {
    next = await maybeRollSummary(next, deps.summarize);
  }
  const ctx = { ...deps.context };
  let usedReadonlyTool = false;
  const memoryIndex = deps.loadMemory
    ? await deps.loadMemory({ coachId: next.coachId, athleteId: next.athlete?.id ?? null }).catch(() => "")
    : "";

  for (let round = 0; round < REACT_MAX_ROUNDS; round += 1) {
    ctx.athleteId = next.athlete?.id ?? null;
    ctx.athleteName = next.athlete?.name ?? null;
    const system = buildReactSystem({
      policy: POLICY,
      memoryIndex,
      workingState: formatWorkingState(next),
      sessionSummary: next.sessionSummary,
    });
    const turn = await runModel({
      system,
      messages: messagesForModel(next),
      tools: deps.registry.definitions(),
    });
    next = appendAssistant(next, turn);
    if (turn.toolUses.length === 0) {
      const reply = turn.text.trim() || "我还没查到可用结果。";
      // 纯追问/闲聊不算结论；本轮用过只读工具才记记忆。
      return { kind: "done", state: next, reply, concluded: usedReadonlyTool };
    }

    for (const use of turn.toolUses) {
      let output: string;
      try {
        output = await deps.registry.execute(use.name, use.input, ctx);
      } catch (error) {
        output = error instanceof Error ? error.message : "工具调用失败。";
      }
      next = appendChat(next, {
        role: "tool",
        content: clipToolResult(output),
        toolUseId: use.id,
        toolName: use.name,
      });
      if (ctx.athleteId && ctx.athleteName) {
        next = { ...next, athlete: { id: ctx.athleteId, name: ctx.athleteName } };
      }
      const payload = parseHandoff(output);
      if (payload) {
        return {
          kind: "handoff",
          state: next,
          target: payload.target,
          payload,
          decision: decisionFromHandoff(payload),
        };
      }
      if (!use.name.startsWith("dispatch_")) usedReadonlyTool = true;
    }
  }

  const reply = "这一问工具轮次用完了。换个说法再试一次。";
  return {
    kind: "done",
    state: appendChat(next, { role: "assistant", content: reply }),
    reply,
    concluded: false,
  };
}

function appendAssistant(state: ParentState, turn: AssistantTurn): ParentState {
  return appendChat(state, {
    role: "assistant",
    content: turn.text,
    toolUses: turn.toolUses.map((use) => ({ id: use.id, name: use.name, input: use.input })),
  });
}
