import type { ChatMessage, ParentState } from "./state.ts";

/** 模型近窗：最近约多少 token 的原文。 */
export const RECENT_TOKEN_BUDGET = 20_000;
/** 超过该占用则滚动更新 sessionSummary。 */
export const COMPACT_THRESHOLD = 28_000;
/** 单条 tool 结果进上下文的最大字符。 */
export const TOOL_RESULT_MAX_CHARS = 1_500;

/** 粗估 token：中英混合按字数/2，下限 1。 */
export function estimateTokens(text: string): number {
  const cleaned = text.trim();
  if (!cleaned) return 0;
  return Math.max(1, Math.ceil(cleaned.length / 2));
}

export function estimateMessageTokens(message: ChatMessage): number {
  let total = estimateTokens(message.content);
  if (message.toolUses?.length) {
    for (const use of message.toolUses) {
      total += estimateTokens(use.name) + estimateTokens(JSON.stringify(use.input ?? {}));
    }
  }
  return total;
}

export function estimateMessagesTokens(messages: readonly ChatMessage[]): number {
  return messages.reduce((sum, item) => sum + estimateMessageTokens(item), 0);
}

export function clipToolResult(text: string, maxChars = TOOL_RESULT_MAX_CHARS): string {
  const value = text.trim();
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars).trimEnd()}\n…(已截断，完整结果不在上下文里)`;
}

export function formatWorkingState(state: ParentState): string {
  const parts = [
    state.athlete ? `当前学员：${state.athlete.name}` : "当前学员：未绑定",
    state.activeGate ? `进行中门禁：${state.activeGate === "framework" ? "排课" : "复盘"}` : "",
    state.pending ? `待确认：${state.pending.kind === "framework" ? "框架草案" : "复盘改法"}` : "",
    state.strategy?.injuryConfirmed ? "伤病已确认" : state.strategy ? "伤病尚未确认完" : "",
  ].filter(Boolean);
  return parts.join("；");
}

export function buildReactSystem(input: {
  policy: string;
  memoryIndex?: string;
  workingState: string;
  sessionSummary?: string | null;
}): string {
  const blocks = [input.policy.trim()];
  blocks.push(`## 本轮工作态\n${input.workingState || "无"}`);
  const memory = input.memoryIndex?.trim();
  if (memory) blocks.push(`## 长期记忆索引\n${memory}\n（仅作参考；业务事实以工具/档案为准，不要编造索引里没有的内容。）`);
  const summary = input.sessionSummary?.trim();
  if (summary) blocks.push(`## 更早对话摘要\n${summary}`);
  return blocks.join("\n\n");
}

/** 从尾部按 token 预算切开；尽量不拆散 assistant.toolUses 与后续 tool 行。 */
export function sliceRecentByTokens(
  messages: readonly ChatMessage[],
  budget = RECENT_TOKEN_BUDGET,
): { recent: ChatMessage[]; older: ChatMessage[] } {
  if (messages.length === 0) return { recent: [], older: [] };
  let used = 0;
  let start = messages.length;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const cost = estimateMessageTokens(messages[i]);
    if (used + cost > budget && start < messages.length) break;
    used += cost;
    start = i;
  }
  start = adjustSplitForToolPairs(messages, start);
  return {
    older: messages.slice(0, start).map((item) => ({ ...item })),
    recent: messages.slice(start).map((item) => ({ ...item })),
  };
}

export function messagesForModel(state: ParentState, budget = RECENT_TOKEN_BUDGET): ChatMessage[] {
  return sliceRecentByTokens(state.messages, budget).recent;
}

/**
 * 超阈值时把「尚未摘要、且落在近窗外」的对话折进 sessionSummary。
 * 不删 messages，UI/落盘仍完整，直至 HISTORY_LIMIT 硬裁。
 */
export async function maybeRollSummary(
  state: ParentState,
  summarize: (older: ChatMessage[]) => Promise<string>,
  options: { threshold?: number; recentBudget?: number; minFresh?: number } = {},
): Promise<ParentState> {
  const threshold = options.threshold ?? COMPACT_THRESHOLD;
  const recentBudget = options.recentBudget ?? RECENT_TOKEN_BUDGET;
  const minFresh = options.minFresh ?? 4;
  if (estimateMessagesTokens(state.messages) < threshold) return state;

  const { older } = sliceRecentByTokens(state.messages, recentBudget);
  if (older.length === 0) return state;

  const through = state.summaryThrough ?? 0;
  const fresh = older.slice(Math.min(through, older.length));
  if (fresh.length < minFresh) return state;

  let piece = "";
  try {
    piece = (await summarize(fresh)).trim();
  } catch {
    piece = extractiveSummary(fresh);
  }
  if (!piece) piece = extractiveSummary(fresh);
  if (!piece) return state;

  const merged = [state.sessionSummary?.trim(), piece].filter(Boolean).join("\n");
  return {
    ...state,
    sessionSummary: merged,
    summaryThrough: through + fresh.length,
  };
}

export function extractiveSummary(messages: readonly ChatMessage[]): string {
  const lines: string[] = [];
  for (const item of messages) {
    if (item.role !== "user" && item.role !== "assistant") continue;
    const text = item.content.replace(/\s+/g, " ").trim();
    if (!text) continue;
    const who = item.role === "user" ? "教练" : "助手";
    lines.push(`${who}：${text.length > 80 ? `${text.slice(0, 80)}…` : text}`);
    if (lines.length >= 12) break;
  }
  return lines.length > 0 ? `较早对话要点：\n${lines.join("\n")}` : "";
}

export function formatMessagesForSummary(messages: readonly ChatMessage[]): string {
  return messages
    .filter((item) => item.role === "user" || item.role === "assistant")
    .map((item) => {
      const who = item.role === "user" ? "教练" : "助手";
      const text = item.content.replace(/\s+/g, " ").trim();
      return `${who}：${text.slice(0, 400)}`;
    })
    .join("\n");
}

function adjustSplitForToolPairs(messages: readonly ChatMessage[], start: number): number {
  let index = start;
  while (index < messages.length && messages[index]?.role === "tool") {
    index -= 1;
    if (index < 0) return 0;
  }
  if (index > 0 && messages[index]?.role === "assistant" && (messages[index].toolUses?.length ?? 0) > 0) {
    // 整段 tool 回合留在 recent
    return index;
  }
  return Math.max(0, index);
}
