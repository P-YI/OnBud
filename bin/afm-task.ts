// CLI entry: route one request through the adaptive controller.
// usage: node --experimental-strip-types --experimental-sqlite bin/afm-task.ts [--root DIR] [--allow-frontier] [--json] "request"

import { ApfelProvider } from "../services/afm-adapter/apfel.ts";
import { Controller } from "../services/controller/controller.ts";
import { OpenCodeFrontier } from "../services/controller/frontier-opencode.ts";
import { openDb } from "../services/telemetry/db.ts";
import { SqliteTelemetry } from "../services/telemetry/telemetry.ts";
import { MemoryStore } from "../services/memory/memory.ts";

const argv = process.argv.slice(2);
let root = process.cwd();
let allowFrontier = false;
let json = false;
const words: string[] = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--root") root = argv[++i];
  else if (argv[i] === "--allow-frontier") allowFrontier = true;
  else if (argv[i] === "--json") json = true;
  else words.push(argv[i]);
}
const prompt = words.join(" ").trim();
if (!prompt) {
  console.error('usage: afm-task [--root DIR] [--allow-frontier] [--json] "request"');
  process.exit(2);
}

const db = openDb();
const controller = new Controller({ afm: new ApfelProvider(), frontier: new OpenCodeFrontier(), telemetry: new SqliteTelemetry(db), memory: new MemoryStore(db), db });
const out = await controller.handle({ prompt, root, allowFrontier, frontEnd: "cli" });

if (json) {
  console.log(JSON.stringify(out, null, 2));
} else {
  console.error(`[${out.status}] route=${out.route} reason=${out.reasonCode} type=${out.taskType}${out.capsuleTokens ? ` capsule≈${out.capsuleTokens}tok` : ""}`);
  for (const s of out.steps) console.error(`  · ${s.kind}: ${s.detail}${s.ms ? ` (${s.ms}ms)` : ""}`);
  if (out.isProposal) console.error("  (edit proposal only — nothing was applied)");
  console.log(out.answer ?? "");
}
process.exit(out.status === "failed" ? 1 : 0);
