// Per-skill switches (skills plan §16): ~/OnBud/config/skills.json
//   { "disabled": ["personal"], "enabled": ["personal"], "options": { "convert": { "maxMB": 200 } } }
// A skill is on unless it is listed in "disabled", or it is off by default (DEFAULT_OFF: it reads personal
// data) and not listed in "enabled". Read on each call (a small file), so a change in the app applies at once.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const DEFAULT_OFF = new Set(["personal"]);
const FILE = () => join(process.env.ONBUD_HOME ?? join(homedir(), "OnBud"), "config", "skills.json");

function read(): { disabled?: string[]; enabled?: string[]; options?: Record<string, Record<string, unknown>> } {
  try { return JSON.parse(readFileSync(FILE(), "utf8")); } catch { return {}; }
}

export function enabled(id: string): boolean {
  const c = read();
  if (c.disabled?.includes(id)) return false;
  return !DEFAULT_OFF.has(id) || !!c.enabled?.includes(id);
}

export function option<T>(id: string, key: string, fallback: T): T {
  const v = read().options?.[id]?.[key];
  return v === undefined ? fallback : (v as T);
}
