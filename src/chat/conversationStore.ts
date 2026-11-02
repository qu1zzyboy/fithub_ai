import type { ParentState } from "../parent/state.ts";
import { initialParentState } from "../parent/state.ts";
import {
  conversationsRoot,
  deleteConversation as deleteFileConversation,
  listConversations as listFileConversations,
  loadConversation as loadFileConversation,
  saveConversation as saveFileConversation,
  displayMessages,
  type ConversationSummary,
  type DisplayMessage,
} from "./conversations.ts";
import type { BusinessClient } from "./business.ts";

export type { ConversationSummary, DisplayMessage };

export interface SavedConversation {
  sessionId: string;
  title: string;
  updatedAt: string;
  state: ParentState;
  allowed: string[];
  version: number;
  displayMessages?: DisplayMessage[];
}

export interface ConversationStore {
  list(input: { token: string; coachId: string }): Promise<ConversationSummary[]>;
  load(input: {
    token: string;
    coachId: string;
    sessionId: string;
  }): Promise<SavedConversation | null>;
  save(input: {
    token: string;
    coachId: string;
    sessionId: string;
    state: ParentState;
    allowed: Iterable<string>;
    previousTitle?: string;
    expectedVersion?: number;
    appendMessages?: DisplayMessage[];
  }): Promise<{ title: string; version: number }>;
  delete(input: { token: string; coachId: string; sessionId: string }): Promise<void>;
}

/** 测试 / 无后端时：本地 JSON。 */
export function createFileConversationStore(memoryRoot: string): ConversationStore {
  const root = conversationsRoot(memoryRoot);
  return {
    async list({ coachId }) {
      return listFileConversations(root, coachId);
    },
    async load({ coachId, sessionId }) {
      const record = loadFileConversation(root, coachId, sessionId);
      if (!record) return null;
      return {
        sessionId: record.sessionId,
        title: record.title,
        updatedAt: record.updatedAt,
        state: record.state,
        allowed: record.allowed,
        version: 1,
        displayMessages: displayMessages(record.state),
      };
    },
    async save(input) {
      const saved = saveFileConversation(root, {
        sessionId: input.sessionId,
        coachId: input.coachId,
        state: input.state,
        allowed: input.allowed,
        previousTitle: input.previousTitle,
      });
      return { title: saved.title, version: 1 };
    },
    async delete({ coachId, sessionId }) {
      deleteFileConversation(root, coachId, sessionId);
    },
  };
}

/** 生产：经 fithub-rust 写 Postgres。 */
export function createHttpConversationStore(business: BusinessClient): ConversationStore {
  return {
    async list({ token, coachId }) {
      return business.listChatSessions({ token, coachId });
    },
    async load({ token, coachId, sessionId }) {
      const row = await business.getChatSession({ token, coachId, sessionId });
      if (!row) return null;
      return {
        sessionId: row.sessionId,
        title: row.title,
        updatedAt: row.updatedAt,
        state: normalizeState(coachId, row.state),
        allowed: row.allowed,
        version: row.version,
        displayMessages: row.messages,
      };
    },
    async save(input) {
      const title = input.previousTitle?.trim() || titleFrom(input.state) || "新对话";
      const preview = previewFrom(input.state);
      const saved = await business.saveChatSession({
        token: input.token,
        sessionId: input.sessionId,
        title,
        athleteName: input.state.athlete?.name ?? null,
        preview,
        state: input.state,
        allowed: [...input.allowed],
        expectedVersion: input.expectedVersion,
        appendMessages: input.appendMessages ?? [],
      });
      return { title: saved.title, version: saved.version };
    },
    async delete({ token, sessionId }) {
      await business.deleteChatSession({ token, sessionId });
    },
  };
}

export { displayMessages };

function normalizeState(coachId: string, raw: unknown): ParentState {
  const base = initialParentState(coachId);
  if (!raw || typeof raw !== "object") return base;
  const state = raw as ParentState;
  return {
    ...base,
    ...state,
    coachId,
    messages: Array.isArray(state.messages) ? state.messages : [],
    sessionSummary: typeof state.sessionSummary === "string" ? state.sessionSummary : null,
    summaryThrough: typeof state.summaryThrough === "number" ? state.summaryThrough : 0,
  };
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
