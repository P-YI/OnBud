process.env.ONBUD_DECIMA_MODE ??= "off";   // tests must not depend on a running Ollaya
process.env.ONBUD_FRONTIER ??= "off";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { AFMHealth, AFMProvider, AFMRequest, AFMResult } from "../services/afm-adapter/provider.ts";

/** Scripted AFM: `respond` decides each reply from the request (system/user/schema). Records every call. */
export class FakeAFM implements AFMProvider {
  readonly name = "fake";
  calls: AFMRequest[] = [];
  healthy = true;
  respond: (req: AFMRequest, n: number) => Partial<AFMResult> & { json?: unknown };
  constructor(respond: FakeAFM["respond"]) { this.respond = respond; }
  async health(): Promise<AFMHealth> { return { ok: this.healthy, model: "fake", contextWindow: 8192 }; }
  async generate(req: AFMRequest): Promise<AFMResult> {
    this.calls.push(req);
    const r = this.respond(req, this.calls.length);
    return { ok: r.failure ? false : true, latencyMs: 1, ...r };
  }
}

export const isTriage = (r: AFMRequest) => r.user.startsWith("Triage this request:");
export const isPick = (r: AFMRequest) => !!r.schema?.properties?.action;
export const isArgs = (r: AFMRequest) => r.system.startsWith("Fill in the arguments");
export const isAnswer = (r: AFMRequest) => !!r.schema?.properties?.needs_escalation;

/** Throwaway git repo with a few files. */
export function makeRepo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "afm-repo-"));
  for (const [p, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, p)), { recursive: true });
    writeFileSync(join(root, p), body);
  }
  const git = (...a: string[]) => execFileSync("git", a, { cwd: root, stdio: "ignore" });
  git("init", "-q");
  git("-c", "user.email=t@t", "-c", "user.name=t", "add", "-A");
  git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init");
  return root;
}
