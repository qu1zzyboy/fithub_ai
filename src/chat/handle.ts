import { normalizeCapability } from "../business/catalog.ts";
import { executeCapability } from "../business/execute.ts";
import { answerWithModel } from "../framework/propose.ts";
import { createChatFrameworkReads } from "../framework/reads.ts";
import { runFrameworkAgent } from "../framework/run.ts";
import { runModelTurn } from "../llm/messages.ts";
import { rememberTurn, type ProposeContext } from "../memory/remember.ts";
import { defaultMemoryRoot, readMemoryIndex, todayIso, type MemoryCandidate } from "../memory/store.ts";
import { classifyWithModel } from "../parent/classify.ts";
import {
  extractiveSummary,
  formatMessagesForSummary,
  maybeRollSummary,
} from "../parent/contextBudget.ts";
import type { ParentPorts } from "../parent/ports.ts";
import { runReactTurn } from "../parent/react.ts";
import { initialParentState, needsGateContinuation, type ChatMessage, type ParentState } from "../parent/state.ts";
import { runParentTurn } from "../parent/turn.ts";
import { createDispatchTools } from "../tools/dispatch.ts";
import { createPipelineTools } from "../tools/pipeline.ts";
import { createReadonlyTools } from "../tools/readonly.ts";
import { createRegistry } from "../tools/registry.ts";
import type { BusinessClient } from "./business.ts";
import { createHttpBusiness } from "./business.ts";
import {
  createFileConversationStore,
  createHttpConversationStore,
  displayMessages,
  type ConversationStore,
  type ConversationSummary,
  type DisplayMessage,
} from "./conversationStore.ts";

export const CHAT_PATH = "/api/v1/ai-chat";
export const DEFAULT_PORT = 4000;

export interface ChatBody {
  sessionId?: unknown;
  coachId?: unknown;
  clientId?: unknown;
  utterance?: unknown;
  reset?: unknown;
  /** list=会话列表；get=加载某会话；delete=删除某会话；默认发消息。 */
  action?: unknown;
}

export interface ChatOk {
  ok: true;
  reply: string;
  athleteName: string | null;
  pending: "framework" | "review" | null;
  sessionId?: string;
  title?: string;
  messages?: DisplayMessage[];
}

export interface ChatListOk {
  ok: true;
  sessions: ConversationSummary[];
}

export interface ChatErr {
  ok: false;
  message: string;
}

export type ChatPayload = ChatOk | ChatListOk | ChatErr;

interface Session {
  state: ParentState;
  allowed: Set<string>;
  title: string;
  version: number;
}

export interface ChatService {
  handle(input: { token: string; body: ChatBody }): Promise<{ status: number; payload: ChatPayload }>;
}

export function createChatService(deps: {
  classify?: ParentPorts["classify"];
  business?: BusinessClient;
  memoryRoot?: string;
  today?: () => string;
  proposeMemories?: (context: ProposeContext) => Promise<MemoryCandidate[]>;
  runModel?: typeof runModelTurn;
  summarize?: (older: ChatMessage[]) => Promise<string>;
  /** 测试用：跳过 ReAct，直接走旧分类循环。 */
  skipReact?: boolean;
  /** 显式注入；默认：传了 memoryRoot 用本地 JSON，否则走 Postgres HTTP。 */
  conversationStore?: ConversationStore;
} = {}): ChatService {
  const classify = deps.classify ?? ((input) => classifyWithModel(input));
  const business = deps.business ?? createHttpBusiness();
  const memoryRoot = deps.memoryRoot ?? defaultMemoryRoot();
  const store = deps.conversationStore
    ?? (deps.memoryRoot !== undefined
      ? createFileConversationStore(memoryRoot)
      : createHttpConversationStore(business));
  const sessions = new Map<string, Session>();
  const locks = new Map<string, Promise<void>>();
  const registry = createRegistry([
    ...createReadonlyTools(business),
    ...createPipelineTools(business),
    ...createDispatchTools(),
  ]);

  return {
    async handle({ token, body }) {
      if (!token) return { status: 401, payload: { ok: false, message: "请先登录。" } };
      const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
      const coachId = typeof body.coachId === "string" ? body.coachId : "";
      const clientId = typeof body.clientId === "string" ? body.clientId : "";
      const action = typeof body.action === "string" ? body.action : "";

      if (action === "list") {
        if (!coachId) return { status: 400, payload: { ok: false, message: "对话请求不完整。" } };
        const listed = await store.list({ token, coachId });
        return { status: 200, payload: { ok: true, sessions: listed } };
      }

      if (!/^[0-9a-f-]{36}$/i.test(sessionId) || !coachId) {
        return { status: 400, payload: { ok: false, message: "对话请求不完整。" } };
      }
      const key = `${coachId}\n${sessionId}`;

      return withSessionLock(locks, key, async () => {
        if (action === "delete" || body.reset === true) {
          sessions.delete(key);
          await store.delete({ token, coachId, sessionId });
          return { status: 200, payload: { ok: true, reply: "", athleteName: null, pending: null, sessionId } };
        }

        if (action === "get") {
          const session = await hydrate(sessions, store, { token, key, coachId, sessionId });
          return {
            status: 200,
            payload: {
              ok: true,
              reply: "",
              sessionId,
              title: session.title,
              athleteName: session.state.athlete?.name ?? null,
              pending: session.state.pending?.kind ?? null,
              messages: displayMessages(session.state),
            },
          };
        }

        const utterance = typeof body.utterance === "string" ? body.utterance.trim() : "";
        if (!utterance) return { status: 400, payload: { ok: false, message: "先写一句话。" } };
        if (utterance.length > 2000) return { status: 400, payload: { ok: false, message: "这一句太长了。" } };

        const session = await hydrate(sessions, store, { token, key, coachId, sessionId });
        try {
          const parentPorts = ports(classify, business, session, token, clientId, { ...deps, memoryRoot });
          let state = session.state;

          const summarize = deps.summarize ?? ((older: ChatMessage[]) => summarizeOlder(older, deps.runModel));

          // 门禁续聊（伤病确认、补策略、confirm/revise）走分类器；新开只读查询才走 ReAct。
          if (!deps.skipReact && !needsGateContinuation(state)) {
            const react = await runReactTurn(state, utterance, {
              registry,
              runModel: deps.runModel,
              loadMemory: (query) => parentPorts.loadMemory(query),
              summarize,
              context: {
                token,
                clientId,
                athleteId: state.athlete?.id ?? null,
                athleteName: state.athlete?.name ?? null,
                async bindAthlete(name) {
                  return parentPorts.resolveAthlete(name);
                },
              },
            });
            state = react.state;
            if (react.kind === "done") {
              if (react.concluded) {
                try {
                  await parentPorts.remember({
                    utterance,
                    reply: react.reply,
                    coachId,
                    athleteId: state.athlete?.id ?? null,
                  });
                } catch {
                  // 记忆写失败不影响回复
                }
              }
              return persistAndReply({
                sessions,
                store,
                token,
                key,
                session,
                state,
                coachId,
                sessionId,
                reply: react.reply,
                utterance,
              });
            }
            // handoff：带着 ReAct 已定决策进门禁，不再二次分类
            const handed = await runParentTurn(state, utterance, parentPorts, {
              decision: react.decision,
            });
            return persistAndReply({
              sessions,
              store,
              token,
              key,
              session,
              state: handed.state,
              coachId,
              sessionId,
              reply: handed.reply,
              utterance,
            });
          }

          state = await maybeRollSummary(state, summarize);
          const result = await runParentTurn(state, utterance, parentPorts);
          return persistAndReply({
            sessions,
            store,
            token,
            key,
            session,
            state: result.state,
            coachId,
            sessionId,
            reply: result.reply,
            utterance,
          });
        } catch (error) {
          return { status: 200, payload: { ok: false, message: error instanceof Error ? error.message : "对话失败" } };
        }
      });
    },
  };
}

async function summarizeOlder(
  older: ChatMessage[],
  runModel: typeof runModelTurn | undefined,
): Promise<string> {
  const fallback = extractiveSummary(older);
  try {
    const turn = await (runModel ?? runModelTurn)({
      system:
        "你压缩健身教练与助手的对话。只输出一段中文摘要：保留学员名、目标、伤病、约定与未完成事项。不要工具原文，不要内部流程代号。",
      messages: [{ role: "user", content: formatMessagesForSummary(older) || "（无对话）" }],
      tools: [],
      maxTokens: 600,
    });
    return turn.text.trim() || fallback;
  } catch {
    return fallback;
  }
}

export async function routeChat(input: {
  method: string;
  path: string;
  authorization: string | undefined;
  rawBody: string;
}, service: ChatService): Promise<{ status: number; payload: ChatPayload }> {
  if (input.method !== "POST" || input.path !== CHAT_PATH) {
    return { status: 404, payload: { ok: false, message: "没有这个接口。" } };
  }
  const token = bearer(input.authorization);
  if (!token) return { status: 401, payload: { ok: false, message: "请先登录。" } };
  let body: ChatBody;
  try {
    const parsed = JSON.parse(input.rawBody) as unknown;
    if (!parsed || typeof parsed !== "object") throw new Error("bad");
    body = parsed as ChatBody;
  } catch {
    return { status: 400, payload: { ok: false, message: "对话请求不完整。" } };
  }
  return service.handle({ token, body });
}

async function withSessionLock<T>(
  locks: Map<string, Promise<void>>,
  key: string,
  work: () => Promise<T>,
): Promise<T> {
  const previous = locks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const chained = previous.then(() => gate);
  locks.set(key, chained);
  await previous;
  try {
    return await work();
  } finally {
    release();
    if (locks.get(key) === chained) locks.delete(key);
  }
}

async function hydrate(
  sessions: Map<string, Session>,
  store: ConversationStore,
  input: { token: string; key: string; coachId: string; sessionId: string },
): Promise<Session> {
  const live = sessions.get(input.key);
  if (live) return live;
  const saved = await store.load({
    token: input.token,
    coachId: input.coachId,
    sessionId: input.sessionId,
  });
  const session: Session = saved
    ? {
      state: saved.state,
      allowed: new Set(saved.allowed),
      title: saved.title,
      version: saved.version,
    }
    : { state: initialParentState(input.coachId), allowed: new Set(), title: "新对话", version: 0 };
  sessions.set(input.key, session);
  return session;
}

async function persistAndReply(input: {
  sessions: Map<string, Session>;
  store: ConversationStore;
  token: string;
  key: string;
  session: Session;
  state: ParentState;
  coachId: string;
  sessionId: string;
  reply: string;
  utterance: string;
}): Promise<{ status: number; payload: ChatOk }> {
  input.session.state = input.state;
  const appendMessages: DisplayMessage[] = [
    { role: "coach", text: input.utterance },
    { role: "agent", text: input.reply },
  ].filter((item) => item.text.trim());
  const saved = await input.store.save({
    token: input.token,
    coachId: input.coachId,
    sessionId: input.sessionId,
    state: input.state,
    allowed: input.session.allowed,
    previousTitle: input.session.title === "新对话" ? undefined : input.session.title,
    expectedVersion: input.session.version > 0 ? input.session.version : undefined,
    appendMessages,
  });
  input.session.title = saved.title;
  input.session.version = saved.version;
  input.sessions.set(input.key, input.session);
  return {
    status: 200,
    payload: {
      ok: true,
      reply: input.reply,
      athleteName: input.state.athlete?.name ?? null,
      pending: input.state.pending?.kind ?? null,
      sessionId: input.sessionId,
      title: saved.title,
    },
  };
}

function ports(
  classify: ParentPorts["classify"],
  business: BusinessClient,
  session: Session,
  token: string,
  clientId: string,
  deps: { memoryRoot?: string; today?: () => string; proposeMemories?: (context: ProposeContext) => Promise<MemoryCandidate[]> },
): ParentPorts {
  const root = deps.memoryRoot ?? defaultMemoryRoot();
  const today = deps.today ?? todayIso;
  const propose = deps.proposeMemories ?? (async () => []);
  return {
    classify,
    async loadMemory(input) {
      return readMemoryIndex(root, input, today());
    },
    async remember(input) {
      await rememberTurn({ ...input, root, today: today(), propose });
    },
    async resolveAthlete(name) {
      const users = await business.searchUsers({ token, clientId, name });
      const exact = users.filter((user) => user.name === name);
      const chosen = exact.length === 1 ? exact[0] : users.length === 1 ? users[0] : null;
      if (!chosen) return null;
      session.allowed.add(chosen.id);
      return { id: chosen.id, name: chosen.name };
    },
    async checkPermission(_coachId, athleteId) {
      return session.allowed.has(athleteId);
    },
    async readInjuryTags(athleteId) {
      if (!session.allowed.has(athleteId)) throw new Error("没有这名学员的权限。");
      const user = await business.readUser({ token, userId: athleteId });
      return injuryTags(user?.tags ?? []);
    },
    async assessmentExists(athleteId) {
      if (!session.allowed.has(athleteId)) return false;
      return business.hasAssessment({ token, userId: athleteId });
    },
    async callBusinessApi(input) {
      const capability = normalizeCapability(input.capability);
      if (capability !== "none" && capabilityNeedsSessionAthlete(capability) && input.athleteId) {
        if (!session.allowed.has(input.athleteId)) throw new Error("没有这名学员的权限。");
      }
      return executeCapability({
        capability,
        token,
        clientId,
        athleteId: input.athleteId,
        athleteName: input.athleteName,
        business,
      });
    },
    async mergeTags() {
      throw new Error("这次对话先不写入业务库。");
    },
    async saveFramework() {
      throw new Error("这次对话先不写入业务库。");
    },
    async savePlanChange() {
      throw new Error("这次对话先不写入业务库。");
    },
    async runFramework(task) {
      const reads = createChatFrameworkReads({ token, clientId, business });
      return runFrameworkAgent(task, reads, { answer: answerWithModel });
    },
    async runReview() {
      return { summary: "训练复盘子 agent 已收到任务。训练记录还没接到这次对话。", change: null };
    },
  };
}

function capabilityNeedsSessionAthlete(capability: string): boolean {
  return capability === "get_athlete_tags" || capability === "check_assessment";
}

function injuryTags(tags: string[]) {
  const joints: string[] = [];
  const chronicConditions: string[] = [];
  for (const tag of tags) {
    if (tag.startsWith("慢性病备注:") || tag === "慢性病:无") continue;
    if (tag.startsWith("关节问题:")) joints.push(tag.slice("关节问题:".length));
    else if (tag.startsWith("慢性病:")) chronicConditions.push(tag.slice("慢性病:".length));
  }
  return { joints, chronicConditions };
}

function bearer(header: string | undefined): string {
  if (!header) return "";
  const [scheme, token] = header.split(" ");
  if (scheme !== "Bearer" || !token) return "";
  return token;
}
