import { rememberTurn, type ProposeContext } from "../memory/remember.ts";
import { defaultMemoryRoot, readMemoryIndex, todayIso, type MemoryCandidate } from "../memory/store.ts";
import { classifyWithModel } from "../parent/classify.ts";
import type { ParentPorts } from "../parent/ports.ts";
import { initialParentState, type ParentState } from "../parent/state.ts";
import { runParentTurn } from "../parent/turn.ts";
import type { BusinessClient } from "./business.ts";
import { createHttpBusiness } from "./business.ts";

export const CHAT_PATH = "/api/v1/ai-chat";
export const DEFAULT_PORT = 4000;

export interface ChatBody {
  sessionId?: unknown;
  coachId?: unknown;
  clientId?: unknown;
  utterance?: unknown;
  reset?: unknown;
}

export interface ChatOk {
  ok: true;
  reply: string;
  athleteName: string | null;
  pending: "framework" | "review" | null;
}

export interface ChatErr {
  ok: false;
  message: string;
}

interface Session {
  state: ParentState;
  allowed: Set<string>;
}

export interface ChatService {
  handle(input: { token: string; body: ChatBody }): Promise<{ status: number; payload: ChatOk | ChatErr }>;
}

export function createChatService(deps: {
  classify?: ParentPorts["classify"];
  business?: BusinessClient;
  memoryRoot?: string;
  today?: () => string;
  proposeMemories?: (context: ProposeContext) => Promise<MemoryCandidate[]>;
} = {}): ChatService {
  const classify = deps.classify ?? ((input) => classifyWithModel(input));
  const business = deps.business ?? createHttpBusiness();
  const sessions = new Map<string, Session>();

  return {
    async handle({ token, body }) {
      if (!token) return { status: 401, payload: { ok: false, message: "请先登录。" } };
      const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
      const coachId = typeof body.coachId === "string" ? body.coachId : "";
      const clientId = typeof body.clientId === "string" ? body.clientId : "";
      if (!/^[0-9a-f-]{36}$/i.test(sessionId) || !coachId) {
        return { status: 400, payload: { ok: false, message: "对话请求不完整。" } };
      }
      const key = `${coachId}\n${sessionId}`;
      if (body.reset === true) {
        sessions.delete(key);
        return { status: 200, payload: { ok: true, reply: "", athleteName: null, pending: null } };
      }
      const utterance = typeof body.utterance === "string" ? body.utterance.trim() : "";
      if (!utterance) return { status: 400, payload: { ok: false, message: "先写一句话。" } };
      if (utterance.length > 2000) return { status: 400, payload: { ok: false, message: "这一句太长了。" } };

      const session = sessions.get(key) ?? { state: initialParentState(coachId), allowed: new Set<string>() };
      try {
        const result = await runParentTurn(session.state, utterance, ports(classify, business, session, token, clientId, deps));
        session.state = result.state;
        sessions.set(key, session);
        return {
          status: 200,
          payload: {
            ok: true,
            reply: result.reply,
            athleteName: result.state.athlete?.name ?? null,
            pending: result.state.pending?.kind ?? null,
          },
        };
      } catch (error) {
        return { status: 200, payload: { ok: false, message: error instanceof Error ? error.message : "对话失败" } };
      }
    },
  };
}

export async function routeChat(input: {
  method: string;
  path: string;
  authorization: string | undefined;
  rawBody: string;
}, service: ChatService): Promise<{ status: number; payload: ChatOk | ChatErr }> {
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
    async callBusinessApi() {
      return "";
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
    async runFramework() {
      return { summary: "训练框架子 agent 已收到任务。动作库还没接到这次对话，没有排出 Slot。", slots: [] };
    },
    async runReview() {
      return { summary: "训练复盘子 agent 已收到任务。训练记录还没接到这次对话。", change: null };
    },
  };
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
