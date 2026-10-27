import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface MemoryCandidate {
  layer?: unknown;
  name?: unknown;
  description?: unknown;
  body?: unknown;
  expires?: unknown;
  quote?: unknown;
}

export interface MemoryNote {
  layer: "coach" | "athlete";
  name: string;
  description: string;
  body: string;
  quote: string;
  expires?: string;
}

const BLOCKED = [
  "训练目标",
  "训练经验",
  "关节问题",
  "慢性病",
  "训练记录",
  "评估",
  "体重",
  "重量",
  "可以做",
  "允许做",
  "解除禁忌",
];

export function defaultMemoryRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "../../memory");
}

export function todayIso(now = new Date()): string {
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${now.getFullYear()}-${month}-${day}`;
}

/** 索引只保留一行一条。过期的学员近况不带进这一轮。 */
export function readMemoryIndex(
  root: string,
  input: { coachId: string; athleteId: string | null },
  today: string,
): string {
  const coach = readLayer(root, "coaches", input.coachId, today, false);
  const athlete = input.athleteId ? readLayer(root, "athletes", input.athleteId, today, true) : [];
  const blocks: string[] = [];
  if (coach.length > 0) blocks.push(["教练", ...coach].join("\n"));
  if (athlete.length > 0) blocks.push(["学员", ...athlete].join("\n"));
  return blocks.join("\n");
}

export function acceptMemory(
  candidate: MemoryCandidate,
  input: { utterance: string; reply: string; athleteId: string | null; today: string },
): { ok: true; note: MemoryNote } | { ok: false; reason: string } {
  const layer = candidate.layer === "coach" || candidate.layer === "athlete" ? candidate.layer : null;
  const name = text(candidate.name, 40);
  const description = text(candidate.description, 80);
  const body = text(candidate.body, 500);
  const quote = text(candidate.quote, 200);
  if (!layer || !name || !description || !body || !quote) return { ok: false, reason: "条目不完整" };
  if (quote.length < 2 || !compact(input.utterance).includes(compact(quote))) {
    return { ok: false, reason: "不是教练原话" };
  }
  if (copiedFromReply({ description, body }, input.utterance, input.reply)) {
    return { ok: false, reason: "从回复里反推" };
  }
  const blocked = BLOCKED.find((word) => `${name}\n${description}\n${body}`.includes(word));
  if (blocked) return { ok: false, reason: "业务表或禁忌里已有" };
  if (layer === "coach") return { ok: true, note: { layer, name, description, body, quote } };
  if (!input.athleteId) return { ok: false, reason: "没有绑定学员" };
  const expires = typeof candidate.expires === "string" ? candidate.expires.trim() : "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(expires) || expires < input.today) {
    return { ok: false, reason: "学员近况没有有效期限" };
  }
  return { ok: true, note: { layer, name, description, body, quote, expires } };
}

export function writeMemory(
  root: string,
  input: { coachId: string; athleteId: string | null },
  note: MemoryNote,
): void {
  const folder = note.layer === "coach" ? "coaches" : "athletes";
  const owner = note.layer === "coach" ? input.coachId : input.athleteId;
  const directory = ownerDirectory(root, folder, owner);
  if (!directory) return;
  const slug = slugFor(note.layer, note.name);
  const line = note.expires
    ? `- ${note.name} | ${note.description} | 至 ${note.expires} | ${slug}`
    : `- ${note.name} | ${note.description} | ${slug}`;
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, `${slug}.md`), bodyFile(note), "utf8");
  const indexPath = join(directory, "MEMORY.md");
  const current = readText(indexPath);
  const kept = current.split("\n").filter((item) => item.trim() && !item.endsWith(` | ${slug}`));
  kept.push(line);
  writeFileSync(indexPath, `${kept.join("\n")}\n`, "utf8");
}

export function parseMemoryNotes(text: string): MemoryCandidate[] {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return [];
  try {
    const parsed = JSON.parse(text.slice(start, end + 1)) as { notes?: unknown };
    if (!Array.isArray(parsed.notes)) return [];
    return parsed.notes.filter((item): item is MemoryCandidate => Boolean(item) && typeof item === "object");
  } catch {
    return [];
  }
}

function readLayer(
  root: string,
  folder: "coaches" | "athletes",
  id: string,
  today: string,
  expiring: boolean,
): string[] {
  const directory = ownerDirectory(root, folder, id);
  if (!directory) return [];
  const lines = readText(join(directory, "MEMORY.md")).split("\n");
  const visible: string[] = [];
  for (const line of lines) {
    const parsed = parseLine(line);
    if (!parsed) continue;
    if (expiring && (!parsed.expires || parsed.expires < today)) continue;
    visible.push(parsed.expires
      ? `- ${parsed.name} | ${parsed.description} | 至 ${parsed.expires}`
      : `- ${parsed.name} | ${parsed.description}`);
  }
  return visible.slice(-30);
}

function parseLine(line: string): { name: string; description: string; expires?: string; slug: string } | null {
  if (!line.startsWith("- ")) return null;
  const parts = line.slice(2).split(" | ");
  if (parts.length === 3 && !parts[2].startsWith("至 ")) {
    return { name: parts[0], description: parts[1], slug: parts[2] };
  }
  if (parts.length === 4 && parts[2].startsWith("至 ")) {
    const expires = parts[2].slice("至 ".length).trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(expires)) return null;
    return { name: parts[0], description: parts[1], expires, slug: parts[3] };
  }
  return null;
}

function bodyFile(note: MemoryNote): string {
  const expires = note.expires ? `\nexpires: ${note.expires}` : "";
  return `---\nname: ${note.name}\ndescription: ${note.description}\nlayer: ${note.layer}${expires}\n---\n${note.body}\n`;
}

function ownerDirectory(root: string, folder: "coaches" | "athletes", id: string | null): string | null {
  if (!id) return null;
  const name = id.trim();
  if (!name || name.length > 80 || /[\\/\0]/.test(name) || name.includes("..")) return null;
  return join(root, folder, name);
}

function slugFor(layer: string, name: string): string {
  const base = name.trim().toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "").slice(0, 24);
  const hash = createHash("sha256").update(`${layer}\n${name.trim()}`).digest("hex").slice(0, 8);
  return `${base || "note"}-${hash}`;
}

function copiedFromReply(
  note: { description: string; body: string },
  utterance: string,
  reply: string,
): boolean {
  const fields = [note.description, note.body].map((item) => item.trim()).filter((item) => item.length >= 4);
  if (fields.length === 0 || !reply.trim()) return false;
  return fields.every((field) => reply.includes(field) && !utterance.includes(field));
}

function text(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  const cleaned = value.replace(/\|/g, "/").replace(/\s+/g, " ").trim();
  if (!cleaned || cleaned.length > max) return "";
  return cleaned;
}

function compact(value: string): string {
  return value.replace(/\s+/g, "");
}

function readText(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}
