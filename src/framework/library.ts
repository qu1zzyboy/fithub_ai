import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { MovementRecord } from "../tools/read.ts";

const JOINTS = ["膝", "肩", "腰", "髋", "踝", "肘", "腕", "颈"];

const EQUIPMENT_CODES: Record<string, string[]> = {
  杠铃: ["EQ-BARB"],
  哑铃: ["EQ-DB", "EQ-DUMB"],
  壶铃: ["EQ-KB"],
  绳索: ["EQ-CABLE"],
  弹力带: ["EQ-BAND"],
};

let cached: MovementRecord[] | null = null;
let cachedNames: string[] | null = null;

export function loadMovementLibrary(): MovementRecord[] {
  if (cached) return cached;
  const table = readTable();
  const header = table[0] ?? [];
  const index = new Map(header.map((name, column) => [name, column]));
  cached = table.slice(1).flatMap((row) => {
    const record = toMovement(row, index);
    return record ? [record] : [];
  });
  return cached;
}

export function movementNames(): string[] {
  if (cachedNames) return cachedNames;
  const table = readTable();
  const header = table[0] ?? [];
  const nameAt = header.indexOf("name_CHN");
  const englishAt = header.indexOf("name_ENG");
  const names = new Set<string>();
  for (const row of table.slice(1)) {
    const chinese = (row[nameAt] ?? "").trim();
    const english = (row[englishAt] ?? "").trim();
    if (chinese.length >= 2) names.add(chinese);
    if (english.length >= 2) names.add(english);
  }
  cachedNames = [...names];
  return cachedNames;
}

export function equipmentMatches(movement: MovementRecord, wanted: readonly string[]): boolean {
  if (wanted.length === 0) return true;
  const hay = movement.equipment.join(" ").toUpperCase();
  return wanted.some((item) => {
    if (item === "自重") return movement.equipment.length === 0 || hay.includes("自重");
    if (hay.includes(item.toUpperCase())) return true;
    return (EQUIPMENT_CODES[item] ?? []).some((code) => hay.includes(code));
  });
}

function toMovement(row: string[], index: Map<string, number>): MovementRecord | null {
  const name = cell(row, index, "name_CHN");
  const id = cell(row, index, "id") || cell(row, index, "action_id") || name;
  if (!id || !name) return null;
  const pattern = cell(row, index, "movement_pattern");
  const equipment = cell(row, index, "equipment").split(/[,，]/).map((item) => item.trim()).filter(Boolean);
  const raw = cell(row, index, "contraindications");
  const parts = raw.split(/[,，]/).map((item) => item.trim()).filter(Boolean);
  const joints = JOINTS.filter((joint) => raw.includes(joint));
  return {
    id,
    name,
    patterns: pattern ? [pattern] : [],
    equipment,
    contraindications: [...new Set([...parts, ...joints])],
  };
}

function readTable(): string[][] {
  const path = join(dirname(fileURLToPath(import.meta.url)), "../../docs/动作库-V1_动作主表_主动作视图.csv");
  return parseCsv(readFileSync(path, "utf8").replace(/^\uFEFF/, ""));
}

function cell(row: string[], index: Map<string, number>, name: string): string {
  const column = index.get(name);
  if (column === undefined) return "";
  return (row[column] ?? "").trim();
}

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"') {
      quoted = true;
      continue;
    }
    if (char === ",") {
      row.push(field);
      field = "";
      continue;
    }
    if (char === "\n" || char === "\r") {
      if (char === "\r" && text[i + 1] === "\n") i += 1;
      row.push(field);
      field = "";
      if (row.some((item) => item.length > 0)) rows.push(row);
      row = [];
      continue;
    }
    field += char;
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}
