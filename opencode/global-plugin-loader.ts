// Global loader for the OpenAFM security gate, read by both OpenCode engines from ~/.config/opencode/plugins/.
// One default export satisfies both contracts:
//   1.x CLI      → PluginModule { id, server }   (server = the 1.x hooks plugin)
//   2.x desktop  → { id, setup }                 (setup registers 2.x hooks)
// Sources (git-tracked): <repo>/opencode/plugin/security-gate{,-v2}.ts, where <repo> is $OPENAFM_REPO or
// ~/OpenAFM/adaptive-coding-agent (this file is copied, so it cannot import them relative to itself).
import { homedir } from "node:os";
const repo = process.env.OPENAFM_REPO ?? `${homedir()}/OpenAFM/adaptive-coding-agent`;
const { SecurityGate } = await import(`${repo}/opencode/plugin/security-gate.ts`);
const V2 = (await import(`${repo}/opencode/plugin/security-gate-v2.ts`)).default;

export default { id: "openafm.security-gate", server: SecurityGate, setup: V2.setup };
