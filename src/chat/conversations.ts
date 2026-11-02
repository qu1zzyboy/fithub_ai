import { mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defaultMemoryRoot } from "../memory/store.ts";
import { initialParentState, type ParentState } from "../parent/state.ts";

export interface ConversationRecord {
  sessionId: string;
  coachId: string;
  title: string;
  updatedAt: string;
  state: ParentState;
  allowed: string[];
}

export interface ConversationSummary {
  sessionId: string;
  title: string;
  updatedAt: string;
  athleteName: string | null;
  preview: string;
}

export interface DisplayMessage {
  role: "coach" | "agent";
  text: string;
}

export function conversationsRoot(memoryRoot = defaultMemoryRoot()): string {
  return join(memoryRoot, "conversations");
}

export function saveConversation(
  root: string,
  input: {
    sessionId: string;
    coachId: string;
    state: ParentState;
    allowed: Iterable<string>;
    previousTitle?: string;
  },
): ConversationRecord {
  const title = input.previousTitle?.trim() || titleFrom(input.state) || "新对话";
  const record: ConversationRecord = {
    sessionId: input.sessionId,
    coachId: input.coachId,
    title,
    updatedAt: new Date().toISOString(),
    state: input.state,
    allowed: [...input.allowed],
  };
  const path = conversationPath(root, input.coachId, input.sessionId);
  if (!path) return record;
  mkdirSync(join(root, safeId(input.coachId)), { recursive: true });
  writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  return record;
}

export function loadConversation(
  root: string,
  coachId: string,
  sessionId: string,
): ConversationRecord | null {
  const path = conversationPath(root, coachId, sessionId);
  if (!path) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as ConversationRecord;
    if (!parsed || parsed.sessionId !== sessionId || parsed.coachId !== coachId) return null;
    if (!parsed.state || typeof parsed.state !== "object") return null;
    return {
      ...parsed,
      title: typeof parsed.title === "string" && parsed.title.trim() ? parsed.title : "新对话",
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date(0).toISOString(),
      allowed: Array.isArray(parsed.allowed) ? parsed.allowed.filter((id) => typeof id === "string") : [],
      state: {
        ...initialParentState(coachId),
        ...parsed.state,
        coachId,
        messages: Array.isArray(parsed.state.messages) ? parsed.state.messages : [],
        sessionSummary: typeof parsed.state.sessionSummary === "string"
          ? parsed.state.sessionSummary
          : null,
        summaryThrough: typeof parsed.state.summaryThrough === "number" ? parsed.state.summaryThrough : 0,
      },
    };
  } catch {
    return null;
  }
}

export function listConversations(root: string, coachId: string): ConversationSummary[] {
  const folder = join(root, safeId(coachId));
  let files: string[] = [];
  try {
    files = readdirSync(folder).filter((name) => name.endsWith(".json"));
  } catch {
    return [];
  }
  const rows: ConversationSummary[] = [];
  for (const file of files) {
    const sessionId = file.slice(0, -".json".length);
    const record = loadConversation(root, coachId, sessionId);
    if (!record) continue;
    if (record.state.messages.length === 0) continue;
    rows.push({
      sessionId: record.sessionId,
      title: record.title,
      updatedAt: record.updatedAt,
      athleteName: record.state.athlete?.name ?? null,
      preview: previewFrom(record.state),
    });
  }
  return rows.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function deleteConversation(root: string, coachId: string, sessionId: string): void {
  const path = conversationPath(root, coachId, sessionId);
  if (!path) return;
  try {
    unlinkSync(path);
  } catch {
    // 没有文件也算删干净
  }
}

export function displayMessages(state: ParentState): DisplayMessage[] {
  const out: DisplayMessage[] = [];
  for (const message of state.messages) {
    if (message.role === "user" && message.content.trim()) {
      out.push({ role: "coach", text: message.content });
    } else if (message.role === "assistant" && message.content.trim()) {
      out.push({ role: "agent", text: message.content });
    }
  }
  return out;
}

function conversationPath(root: string, coachId: string, sessionId: string): string | null {
  if (!/^[0-9a-f-]{36}$/i.test(sessionId)) return null;
  const coach = safeId(coachId);
  if (!coach) return null;
  return join(root, coach, `${sessionId}.json`);
}

function safeId(id: string): string {
  const name = id.trim();
  if (!name || name.length > 80 || /[\\/\0]/.test(name) || name.includes("..")) return "";
  return name;
}

function titleFrom(state: ParentState): string {
  const first = state.messages.find((item) => item.role === "user" && item.content.trim());
  if (!first) return "";
  const text = first.content.replace(/\s+/g, " ").trim();
  return text.length > 28 ? `${text.slice(0, 28)}…` : text;
}

function previewFrom(state: ParentState): string {
  for (let i = state.messages.length - 1; i >= 0; i -= 1) {
    const item = state.messages[i];
    if ((item.role === "assistant" || item.role === "user") && item.content.trim()) {
      const text = item.content.replace(/\s+/g, " ").trim();
      return text.length > 48 ? `${text.slice(0, 48)}…` : text;
    }
  }
  return "";
}
