export interface BusinessUser {
  id: string;
  name: string;
  tags: string[];
}

export interface BusinessPeriodPlan {
  id: string;
  name: string;
  days: number;
}

export interface PipelineRun {
  id: string;
  staffId: string;
  userId: string;
  status: string;
  currentStation: string | null;
}

export interface PipelineHandoff {
  id: string;
  runId: string;
  handoffId: string;
  version: number;
  status: string;
  payload: unknown;
}

export interface BusinessClient {
  searchUsers(input: { token: string; clientId: string; name: string }): Promise<BusinessUser[]>;
  listUsers(input: { token: string; clientId: string }): Promise<BusinessUser[]>;
  readUser(input: { token: string; userId: string }): Promise<BusinessUser | null>;
  hasAssessment(input: { token: string; userId: string }): Promise<boolean>;
  listPeriodPlans(input: { token: string; clientId: string }): Promise<BusinessPeriodPlan[]>;
  createPipelineRun(input: {
    token: string;
    userId: string;
    shopId?: string;
    source?: string;
    reuseActive?: boolean;
  }): Promise<PipelineRun>;
  appendPipelineHandoff(input: {
    token: string;
    runId: string;
    handoffId: string;
    payload: unknown;
    note?: string;
    accept?: boolean;
  }): Promise<{ run: PipelineRun; handoff: PipelineHandoff }>;
  getPipelineRun(input: {
    token: string;
    runId?: string;
    userId?: string;
    activeOnly?: boolean;
  }): Promise<PipelineRun>;
  listPipelineHandoffs(input: {
    token: string;
    runId: string;
    handoffId?: string;
  }): Promise<PipelineHandoff[]>;
  acceptPipelineHandoff(input: {
    token: string;
    runId: string;
    handoffId: string;
    version?: number;
  }): Promise<{ run: PipelineRun; handoff: PipelineHandoff }>;
  listChatSessions(input: { token: string; coachId: string }): Promise<ChatSessionSummary[]>;
  getChatSession(input: {
    token: string;
    coachId: string;
    sessionId: string;
  }): Promise<ChatSessionRecord | null>;
  saveChatSession(input: {
    token: string;
    sessionId: string;
    title: string;
    athleteName: string | null;
    preview: string;
    state: unknown;
    allowed: string[];
    expectedVersion?: number;
    appendMessages?: { role: "coach" | "agent" | "error"; text: string }[];
  }): Promise<{ title: string; version: number; sessionId: string }>;
  deleteChatSession(input: { token: string; sessionId: string }): Promise<void>;
}

export interface ChatSessionSummary {
  sessionId: string;
  title: string;
  updatedAt: string;
  athleteName: string | null;
  preview: string;
}

export interface ChatSessionRecord {
  sessionId: string;
  title: string;
  updatedAt: string;
  state: unknown;
  allowed: string[];
  version: number;
  messages: { role: "coach" | "agent"; text: string }[];
}

export function createHttpBusiness(backendUrl = process.env.BACKEND_URL || process.env.BACKEND_DEV_URL || ""): BusinessClient {
  return {
    async searchUsers({ token, clientId, name }) {
      const payload = await post(backendUrl, token, "hex/web/user/list", {
        searchKey: name,
        userType: 0,
        gender: 0,
        skip: 0,
        limit: 20,
        shopId: "",
        ...(clientId ? { clientId } : {}),
      });
      return usersFrom(payload);
    },
    async listUsers({ token, clientId }) {
      const payload = await post(backendUrl, token, "hex/web/user/list", {
        searchKey: "",
        userType: 0,
        gender: 0,
        skip: 0,
        limit: 50,
        shopId: "",
        ...(clientId ? { clientId } : {}),
      });
      return usersFrom(payload);
    },
    async readUser({ token, userId }) {
      const payload = await post(backendUrl, token, "hex/web/user/get", { id: userId });
      const data = record(payload)?.data;
      if (!data || typeof data !== "object") return null;
      const user = userFrom(data);
      return user;
    },
    async hasAssessment({ token, userId }) {
      const payload = await post(backendUrl, token, "hex/web/portal_assessment/list", {
        userId,
        kind: "fitjoint",
        skip: 0,
        limit: 1,
      });
      const data = record(payload)?.data;
      if (!data || typeof data !== "object") return false;
      const body = data as { items?: unknown; total?: unknown };
      if (typeof body.total === "number") return body.total > 0;
      return Array.isArray(body.items) && body.items.length > 0;
    },
    async listPeriodPlans({ token, clientId }) {
      const payload = await post(backendUrl, token, "hex/web/period_plan/list", {
        skip: 0,
        limit: 20,
        ...(clientId ? { clientId } : {}),
      });
      return periodPlansFrom(payload);
    },
    async createPipelineRun({ token, userId, shopId, source, reuseActive }) {
      const payload = await post(backendUrl, token, "hex/web/ai_pipeline/run/create", {
        userId,
        ...(shopId ? { shopId } : {}),
        ...(source ? { source } : {}),
        reuseActive: reuseActive !== false,
      });
      const run = pipelineRunFrom(record(payload)?.data);
      if (!run) throw new Error("创建规划会话失败。");
      return run;
    },
    async appendPipelineHandoff({ token, runId, handoffId, payload: body, note, accept }) {
      const payload = await post(backendUrl, token, "hex/web/ai_pipeline/handoff/append", {
        runId,
        handoffId,
        payload: body,
        ...(note ? { note } : {}),
        accept: accept === true,
      });
      const data = record(payload)?.data;
      const run = pipelineRunFrom(record(data)?.run);
      const handoff = pipelineHandoffFrom(record(data)?.handoff);
      if (!run || !handoff) throw new Error("写入交接物失败。");
      return { run, handoff };
    },
    async getPipelineRun({ token, runId, userId, activeOnly }) {
      const payload = await post(backendUrl, token, "hex/web/ai_pipeline/run/get", {
        ...(runId ? { runId } : {}),
        ...(userId ? { userId } : {}),
        activeOnly: activeOnly === true,
      });
      const run = pipelineRunFrom(record(payload)?.data);
      if (!run) throw new Error("查询规划会话失败。");
      return run;
    },
    async listPipelineHandoffs({ token, runId, handoffId }) {
      const payload = await post(backendUrl, token, "hex/web/ai_pipeline/handoff/list", {
        runId,
        ...(handoffId ? { handoffId } : {}),
      });
      const data = record(payload)?.data;
      if (!Array.isArray(data)) return [];
      return data.flatMap((item) => {
        const handoff = pipelineHandoffFrom(item);
        return handoff ? [handoff] : [];
      });
    },
    async acceptPipelineHandoff({ token, runId, handoffId, version }) {
      const payload = await post(backendUrl, token, "hex/web/ai_pipeline/handoff/accept", {
        runId,
        handoffId,
        ...(typeof version === "number" ? { version } : {}),
      });
      const data = record(payload)?.data;
      const run = pipelineRunFrom(record(data)?.run);
      const handoff = pipelineHandoffFrom(record(data)?.handoff);
      if (!run || !handoff) throw new Error("确认交接物失败。");
      return { run, handoff };
    },
    async listChatSessions({ token }) {
      const payload = await post(backendUrl, token, "hex/web/ai_chat/session/list", { limit: 50 });
      const data = record(payload)?.data;
      if (!Array.isArray(data)) return [];
      return data.flatMap((item) => {
        const row = record(item);
        if (!row) return [];
        const sessionId = text(row.sessionId);
        if (!sessionId) return [];
        return [{
          sessionId,
          title: text(row.title) || "新对话",
          updatedAt: text(row.updatedAt) || new Date(0).toISOString(),
          athleteName: text(row.athleteName) || null,
          preview: text(row.preview),
        }];
      });
    },
    async getChatSession({ token, sessionId }) {
      const payload = await postOptional(backendUrl, token, "hex/web/ai_chat/session/get", { sessionId });
      if (!payload) return null;
      const data = record(payload)?.data;
      const session = record(record(data)?.session);
      if (!session) return null;
      const id = text(session.sessionId);
      if (!id) return null;
      const allowedRaw = session.allowed;
      const allowed = Array.isArray(allowedRaw)
        ? allowedRaw.filter((item): item is string => typeof item === "string")
        : [];
      const messagesRaw = record(data)?.messages;
      const messages = Array.isArray(messagesRaw)
        ? messagesRaw.flatMap((item) => {
          const row = record(item);
          if (!row) return [];
          const role = text(row.role);
          const textBody = text(row.text);
          if ((role !== "coach" && role !== "agent") || !textBody) return [];
          return [{ role: role as "coach" | "agent", text: textBody }];
        })
        : [];
      return {
        sessionId: id,
        title: text(session.title) || "新对话",
        updatedAt: text(session.updatedAt) || new Date(0).toISOString(),
        state: session.state ?? {},
        allowed,
        version: numberOf(session.version) || 1,
        messages,
      };
    },
    async saveChatSession(input) {
      const payload = await post(backendUrl, input.token, "hex/web/ai_chat/session/save", {
        sessionId: input.sessionId,
        title: input.title,
        athleteName: input.athleteName,
        preview: input.preview,
        state: input.state,
        allowed: input.allowed,
        expectedVersion: input.expectedVersion,
        appendMessages: input.appendMessages ?? [],
      });
      const data = record(payload)?.data;
      const title = text(record(data)?.title) || input.title;
      const version = numberOf(record(data)?.version) || 1;
      const sessionId = text(record(data)?.sessionId) || input.sessionId;
      return { title, version, sessionId };
    },
    async deleteChatSession({ token, sessionId }) {
      await post(backendUrl, token, "hex/web/ai_chat/session/delete", { sessionId });
    },
  };
}

async function post(backendUrl: string, token: string, path: string, body: object): Promise<unknown> {
  const payload = await postRaw(backendUrl, token, path, body);
  if (!payload.ok) throw new Error(payload.message);
  return payload.body;
}

/** 404 / NotFound → null，便于新建会话。 */
async function postOptional(
  backendUrl: string,
  token: string,
  path: string,
  body: object,
): Promise<unknown | null> {
  const payload = await postRaw(backendUrl, token, path, body);
  if (!payload.ok) {
    if (payload.missing) return null;
    throw new Error(payload.message);
  }
  return payload.body;
}

async function postRaw(
  backendUrl: string,
  token: string,
  path: string,
  body: object,
): Promise<{ ok: true; body: unknown } | { ok: false; message: string; missing: boolean }> {
  if (!backendUrl) return { ok: false, message: "缺少 BACKEND_URL", missing: false };
  const response = await fetch(`${backendUrl.replace(/\/+$/, "")}/${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
  const raw = await response.text();
  let parsed: unknown = null;
  try {
    parsed = raw ? JSON.parse(raw) as unknown : null;
  } catch {
    parsed = null;
  }
  const message = messageFrom(parsed) || `业务接口失败: ${response.status}`;
  if (response.status === 404) return { ok: false, message, missing: true };
  if (!response.ok) {
    return { ok: false, message, missing: /not\s*found|不存在|未找到/i.test(message) };
  }
  const code = record(parsed)?.code;
  if (typeof code === "number" && code !== 0) {
    return {
      ok: false,
      message: messageFrom(parsed) || "业务接口失败",
      missing: /not\s*found|不存在|未找到/i.test(messageFrom(parsed) || ""),
    };
  }
  return { ok: true, body: parsed };
}

function usersFrom(payload: unknown): BusinessUser[] {
  const data = record(payload)?.data;
  if (!Array.isArray(data)) return [];
  return data.flatMap((item) => {
    const user = userFrom(item);
    return user ? [user] : [];
  });
}

function periodPlansFrom(payload: unknown): BusinessPeriodPlan[] {
  const data = record(payload)?.data;
  const rows = Array.isArray(data) ? data : Array.isArray(record(data)?.items) ? record(data)?.items : [];
  if (!Array.isArray(rows)) return [];
  return rows.flatMap((item) => {
    const row = record(item);
    if (!row) return [];
    const id = text(row.planId) || text(row.ID) || text(row.id);
    const name = text(row.name) || text(row.Name);
    const days = numberOf(row.days ?? row.Days);
    if (!id || !name) return [];
    return [{ id, name, days }];
  });
}

function userFrom(value: unknown): BusinessUser | null {
  const row = record(value);
  if (!row) return null;
  const id = text(row.UserId) || text(row.userId);
  const name = text(row.Username) || text(row.username);
  if (!id || !name) return null;
  const rawTags = row.Tags ?? row.tags;
  const tags = Array.isArray(rawTags) ? rawTags.filter((tag): tag is string => typeof tag === "string") : [];
  return { id, name, tags };
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? value as Record<string, unknown> : null;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function numberOf(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) ? value : 0;
}

function messageFrom(payload: unknown): string {
  const message = record(payload)?.message;
  return typeof message === "string" ? message : "";
}

function pipelineRunFrom(value: unknown): PipelineRun | null {
  const row = record(value);
  if (!row) return null;
  const id = text(row.id);
  const staffId = text(row.staffId);
  const userId = text(row.userId);
  const status = text(row.status);
  if (!id || !userId || !status) return null;
  return {
    id,
    staffId,
    userId,
    status,
    currentStation: text(row.currentStation) || null,
  };
}

function pipelineHandoffFrom(value: unknown): PipelineHandoff | null {
  const row = record(value);
  if (!row) return null;
  const id = text(row.id);
  const runId = text(row.runId);
  const handoffId = text(row.handoffId);
  const version = numberOf(row.version);
  const status = text(row.status);
  if (!id || !runId || !handoffId || !status || version < 1) return null;
  return { id, runId, handoffId, version, status, payload: row.payload };
}
