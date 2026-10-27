export interface BusinessUser {
  id: string;
  name: string;
  tags: string[];
}

export interface BusinessClient {
  searchUsers(input: { token: string; clientId: string; name: string }): Promise<BusinessUser[]>;
  readUser(input: { token: string; userId: string }): Promise<BusinessUser | null>;
  hasAssessment(input: { token: string; userId: string }): Promise<boolean>;
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
  };
}

async function post(backendUrl: string, token: string, path: string, body: object): Promise<unknown> {
  if (!backendUrl) throw new Error("缺少 BACKEND_URL");
  const response = await fetch(`${backendUrl.replace(/\/+$/, "")}/${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  const payload = text ? JSON.parse(text) as unknown : null;
  if (!response.ok) throw new Error(messageFrom(payload) || `业务接口失败: ${response.status}`);
  const code = record(payload)?.code;
  if (typeof code === "number" && code !== 0) throw new Error(messageFrom(payload) || "业务接口失败");
  return payload;
}

function usersFrom(payload: unknown): BusinessUser[] {
  const data = record(payload)?.data;
  if (!Array.isArray(data)) return [];
  return data.flatMap((item) => {
    const user = userFrom(item);
    return user ? [user] : [];
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

function messageFrom(payload: unknown): string {
  const message = record(payload)?.message;
  return typeof message === "string" ? message : "";
}
