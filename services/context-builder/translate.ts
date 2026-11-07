// On-device machine translation (macOS Translation framework, tools/translate/Translate.swift): Apple's own
// translation models in translationd, not AFM; no network once the language pair is installed. Used to give
// Korean questions about English documents their English search words. Built with swiftc on first use into
// runtime/bin; if the build or the language pair is missing, callers get undefined and go on without it.
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const SRC = new URL("../../tools/translate/Translate.swift", import.meta.url).pathname;
const BIN = join(process.env.ONBUD_HOME ?? join(homedir(), "OnBud"), "runtime", "bin", "afm-translate");
let broken = false;

const exec = (cmd: string, args: string[], timeout: number) => new Promise<{ code: number; out: string }>((res) =>
  execFile(cmd, args, { timeout, maxBuffer: 1024 * 1024 }, (e: any, out) => res({ code: e ? (typeof e.code === "number" ? e.code : -1) : 0, out: String(out ?? "") })));

async function binary(): Promise<string | undefined> {
  if (broken) return undefined;
  if (existsSync(BIN) && statSync(BIN).mtimeMs >= statSync(SRC).mtimeMs) return BIN;
  mkdirSync(join(BIN, ".."), { recursive: true });
  const r = await exec("/usr/bin/swiftc", ["-O", "-parse-as-library", "-o", BIN, SRC], 180_000);
  if (r.code !== 0 || !existsSync(BIN)) { broken = true; return undefined; }
  return BIN;
}

/** text → English (from Korean), or undefined when unavailable. Short texts only (a question: ~0.4–1.5 s). */
export async function toEnglish(text: string, from = "ko", timeoutMs = 8000): Promise<string | undefined> {
  if (text.length > 600) return undefined;
  const bin = await binary();
  if (!bin) return undefined;
  const r = await exec(bin, [from, "en", text], timeoutMs);
  return r.code === 0 && r.out.trim() ? r.out.trim() : undefined;
}
