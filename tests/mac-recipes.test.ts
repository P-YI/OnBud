// Local actions beyond the fixed skills (2026-11-13): vetted recipes (AFM picks and fills slots, code builds the
// command) and AFM-written commands (compiled, gated, approved). The model calls are covered by the probes; here:
// every recipe compiles, slots are checked, times parse, and the compile check catches broken AppleScript.
import { test } from "node:test";
import assert from "node:assert/strict";
import { RECIPES, compileCheck, parseWhen } from "../services/controller/mac-recipes.ts";
import { classifyCommand } from "../services/context-builder/terminal.ts";

const now = new Date(2026, 10, 13, 9, 0);
const sample = { text: `it's "fine"`, url: "apple.com", number: 10, app: "Safari", email: "alex@example.com", subject: "Hi there", body: "See you", title: "Groceries", when: "5pm", folder: "Desktop/Reports", kind: "pdf" };

test("every recipe builds a command that compiles and the gate does not refuse", () => {
  for (const r of RECIPES) {
    const cmd = r.build(sample, now);
    assert.ok(cmd, r.id);
    assert.equal(compileCheck(cmd!), undefined, `${r.id}: ${cmd}`);
    assert.notEqual(classifyCommand(cmd!, process.env.HOME ?? "/").mode, "blocked", r.id);
  }
});

test("slots are checked: bad addresses, links, folders and lengths build nothing", () => {
  const by = (id: string) => RECIPES.find((r) => r.id === id)!;
  assert.equal(by("email_draft").build({ email: "not an address; rm -rf ~" }, now), undefined);
  assert.equal(by("open_url").build({ url: "javascript:alert(1)" }, now), undefined);
  assert.equal(by("open_url").build({ url: "file:///etc/passwd" }, now), undefined);
  assert.equal(by("new_folder").build({ folder: "../../etc" }, now), undefined);
  assert.equal(by("new_folder").build({ folder: ".ssh/x" }, now), undefined);
  assert.equal(by("timer").build({ number: 0 }, now), undefined);
  assert.equal(by("keep_awake").build({ number: 99999 }, now), undefined);
  assert.match(by("say").build({ text: "a'b; rm x" }, now)!, /^say -- 'a'\\''b; rm x'$/);   // quoted, never executed as code
});

test("reminder times", () => {
  assert.equal(parseWhen("5pm", now)!.getHours(), 17);
  assert.equal(parseWhen("오후 5시 반", now)!.getMinutes(), 30);
  assert.equal(parseWhen("in 20 minutes", now)!.getTime() - now.getTime(), 20 * 60_000);
  assert.equal(parseWhen("8am", now)!.getDate(), 14);   // already past today → tomorrow
  assert.equal(parseWhen("whenever", now), undefined);
});

test("the compile check catches the model's broken AppleScript and shell", () => {
  assert.match(compileCheck(`osascript -e 'tell application "System Events" to set timer to 10 minutes'`)!, /AppleScript/);
  assert.match(compileCheck(`osascript -e 'echo "x" | pbcopy'`)!, /AppleScript/);
  assert.match(compileCheck(`echo "unclosed`)!, /shell syntax/);
  assert.equal(compileCheck(`osascript -e 'tell application "Music" to pause'`), undefined);
});

test("timers and alarms: a clock time becomes minutes by code", async () => {
  const { fillRecipe, RECIPES: R } = await import("../services/controller/mac-recipes.ts");
  const now = new Date(2026, 10, 13, 9, 55);
  const fake = (json: object) => ({ name: "fake", health: async () => ({ ok: true }), generate: async () => ({ ok: true, json, latencyMs: 0 }) }) as any;
  const timer = R.find((r) => r.id === "timer")!;
  const alarm = await fillRecipe(fake({ number: 45, text: "Alarm" }), timer, "Set an alarm for 7:30am", 1000, now);
  assert.match(alarm!.command, /sleep 77700;/);   // 7:30 tomorrow = 21 h 35 min, whatever the model said
  const t = await fillRecipe(fake({ number: 5, text: "Tea" }), timer, "Set a timer for 2 hours", 1000, now);
  assert.match(t!.command, /sleep 7200;/);
});
