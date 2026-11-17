import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.ONBUD_HOME = mkdtempSync(join(tmpdir(), "onbud-home-"));
const { recordCreated, writeWithUndo, beginEdit, undo, entries, inverseOf } = await import("../services/controller/undo.ts");
const { undoSkill, undoIntent } = await import("../services/controller/undo-skill.ts");
const { Staging, writeAtomic, placeNew, tmpFor } = await import("../services/controller/atomic.ts");
const { installCancelHooks, withCancel, checkCancelled, Cancelled } = await import("../services/controller/cancel.ts");
const { convert } = await import("../services/controller/mac-tasks.ts");

test("undo: an applied edit is restored exactly; a later change by the user is never overwritten without asking", () => {
  const dir = mkdtempSync(join(tmpdir(), "undo-"));
  const f = join(dir, "notes.md");
  writeFileSync(f, "original\n");
  const e = writeWithUndo("fix the typo", f, "edited by OnBud\n");
  assert.equal(readFileSync(f, "utf8"), "edited by OnBud\n");
  let r = undo(e.id);
  assert.ok(r.ok); assert.deepEqual(r.restored, [f]);
  assert.equal(readFileSync(f, "utf8"), "original\n");
  assert.ok(undo(e.id).already);
  // changed again after OnBud: nothing changes; force keeps the user's version in the record; copy leaves files alone
  const e2 = writeWithUndo("second edit", f, "OnBud v2\n");
  writeFileSync(f, "user kept working\n");
  r = undo(e2.id);
  assert.equal(r.ok, false); assert.equal(r.conflicts[0].why, "changed");
  assert.equal(readFileSync(f, "utf8"), "user kept working\n");
  r = undo(e2.id, "copy");
  assert.equal(readFileSync(r.copies[0], "utf8"), "original\n");
  assert.equal(readFileSync(f, "utf8"), "user kept working\n");
  r = undo(e2.id, "force");
  assert.equal(readFileSync(f, "utf8"), "original\n");
  const kept = join(process.env.ONBUD_HOME!, "runtime", "undo", e2.id, "after");
  assert.equal(readFileSync(join(kept, readdirSync(kept)[0]), "utf8"), "user kept working\n");
});

test("undo: files OnBud made are moved into the record, not deleted; deleted files come back", () => {
  const dir = mkdtempSync(join(tmpdir(), "undo-"));
  const made = join(dir, "a (converted).jpg"); writeFileSync(made, "jpg");
  const e = recordCreated("convert a.png to jpg", [made])!;
  assert.ok(undo(e.id).ok);
  assert.ok(!existsSync(made));
  assert.equal(readFileSync(join(process.env.ONBUD_HOME!, "runtime", "undo", e.id, "after", "0-a (converted).jpg"), "utf8"), "jpg");
  // a job that deleted one file and changed another
  const keep = join(dir, "keep.txt"), gone = join(dir, "gone.txt");
  writeFileSync(keep, "k1"); writeFileSync(gone, "g1");
  const j = beginEdit("job", [keep, gone]);
  writeFileSync(keep, "k2"); rmSync(gone);
  const je = j.done();
  assert.ok(undo(je.id).ok);
  assert.equal(readFileSync(keep, "utf8"), "k1"); assert.equal(readFileSync(gone, "utf8"), "g1");
});

test("undo skill: the request, the newest record, conflicts offered as choices; opposite commands", async () => {
  for (const p of ["되돌려줘", "방금 한 거 원래대로 해줘", "Undo that", "undo 20261117010101-ab12", "실행 취소해줘"]) assert.ok(undoIntent(p), p);
  for (const p of ["git revert 하는 법", "커밋 되돌리기", "how do I undo in Word", "⌘Z 단축키"]) assert.ok(!undoIntent(p), p);
  const dir = mkdtempSync(join(tmpdir(), "undo-"));
  const f = join(dir, "t.txt"); writeFileSync(f, "a");
  writeWithUndo("t.txt 고쳐줘", f, "b"); writeFileSync(f, "c");
  const r = undoSkill("되돌려줘", true);
  assert.equal(r.verified, false);
  assert.match(r.choices![0].prompt!, /^undo \d{14}-[a-z0-9]{4} force$/);
  assert.equal(readFileSync(f, "utf8"), "c");
  const r2 = undoSkill(r.choices![0].prompt!, true);
  assert.match(r2.answer, /되돌렸어요/); assert.equal(readFileSync(f, "utf8"), "a");
  assert.match(undoSkill("되돌려줘", true).answer, /되돌릴|이미/);
  const inv = await inverseOf(`osascript -e 'tell application "System Events" to tell appearance preferences to set dark mode to true'`, async () => "");
  assert.match(inv!.command, /set dark mode to false/);
  assert.deepEqual(await inverseOf(`osascript -e 'set volume output volume 80'`, async () => "35\n"), { command: `osascript -e 'set volume output volume 35'`, label: "volume back to 35%" });
  assert.match((await inverseOf("networksetup -setairportpower en0 off", async () => ""))!.command, /en0 on$/);
  assert.equal(await inverseOf(`osascript -e 'tell application "Finder" to empty trash'`, async () => ""), undefined);
});

test("atomic: outputs appear whole or not at all; existing files are never replaced by a new output", () => {
  const dir = mkdtempSync(join(tmpdir(), "atomic-"));
  const st = new Staging();
  const t = st.reserve(join(dir, "out.txt"));
  writeFileSync(t, "half");
  assert.ok(!existsSync(join(dir, "out.txt")));
  st.discardAll();
  assert.deepEqual(readdirSync(dir), []);
  writeFileSync(join(dir, "x.txt"), "old");
  const t2 = tmpFor(join(dir, "x.txt")); writeFileSync(t2, "new");
  assert.throws(() => placeNew(t2, join(dir, "x.txt")));
  assert.equal(readFileSync(join(dir, "x.txt"), "utf8"), "old");
  writeAtomic(join(dir, "x.txt"), "replaced");
  assert.equal(readFileSync(join(dir, "x.txt"), "utf8"), "replaced");
});

test("cancel: child processes and fetch get the request's signal; a stopped conversion leaves no file", async () => {
  installCancelHooks();
  const { execFile } = await import("node:child_process");
  const ac = new AbortController(); setTimeout(() => ac.abort(), 150);
  const t0 = Date.now();
  const name = await withCancel(ac.signal, () => new Promise<string>((res) => execFile("/bin/sleep", ["5"], (e: any) => res(e?.name))));
  assert.equal(name, "AbortError"); assert.ok(Date.now() - t0 < 2000);
  const done = new AbortController(); done.abort();
  await assert.rejects(withCancel(done.signal, async () => checkCancelled()), Cancelled);
  // convert under a stopped request: the tool is killed and nothing appears next to the input
  const dir = mkdtempSync(join(tmpdir(), "conv-"));
  const src = mkdtempSync(join(tmpdir(), "src-")); writeFileSync(join(src, "p.txt"), "page");
  writeFileSync(join(src, "p.pdf"), execFileSync("/usr/sbin/cupsfilter", [join(src, "p.txt")], { stdio: ["ignore", "pipe", "ignore"] }));
  execFileSync("/usr/bin/sips", ["-s", "format", "png", join(src, "p.pdf"), "--out", join(dir, "p.png")], { stdio: "ignore" });
  const stop = new AbortController(); stop.abort();
  const r = await withCancel(stop.signal, () => convert({ root: dir, prompt: "p.png를 jpg로 바꿔줘", files: [{ path: "p.png" }], ko: true }));
  assert.equal(r.verified, false);
  assert.deepEqual(readdirSync(dir), ["p.png"]);
  const ok = await convert({ root: dir, prompt: "p.png를 jpg로 바꿔줘", files: [{ path: "p.png" }], ko: true });
  assert.equal(ok.verified, true, ok.answer);
  assert.deepEqual(readdirSync(dir).sort(), ["p (converted).jpg", "p.png"]);
  assert.equal(entries()[0].files[0].path, join(dir, "p (converted).jpg"));
});
