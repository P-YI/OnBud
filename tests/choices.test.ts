import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.ONBUD_HOME = mkdtempSync(join(tmpdir(), "onbud-home-"));
const { matchChoice, choicesText } = await import("../services/controller/choices.ts");
const { Controller } = await import("../services/controller/controller.ts");
const { convert } = await import("../services/controller/mac-tasks.ts");
const { FakeAFM, makeRepo } = await import("./helpers.ts");

const C = [{ label: "a.pdf의 2쪽", prompt: "x" }, { label: "b.pdf의 2쪽", prompt: "y" }, { label: "합친 결과의 2쪽", prompt: "z" }];

test("choices: a reply picks by number, ordinal or label; anything else picks nothing", () => {
  for (const [r, i] of [["2", 1], ["2번", 1], ["2번으로 해줘", 1], ["두 번째", 1], ["second", 1], ["the third one", 2], ["b.pdf의 2쪽", 1], ["합친 결과", 2], ["`a.pdf의 2쪽`", 0]] as [string, number][])
    assert.equal(matchChoice(r, C), C[i], r);
  for (const r of ["9", "2쪽", "고마워", "a.pdf랑 c.pdf 합쳐줘", ""]) assert.equal(matchChoice(r, C), undefined, r);
  assert.match(choicesText(C, true), /1\. a\.pdf의 2쪽\n2\. b\.pdf의 2쪽\n3\. 합친 결과의 2쪽\n\n_번호나 이름으로/);
});

test("choices: a file name in two subfolders is asked about, each option names its path", async () => {
  const root = makeRepo({ "sub1/notes.md": "# one\n", "sub2/notes.md": "# two\n" });
  const afm = new FakeAFM(() => ({ failure: "empty" }));
  const out = await new Controller({ afm }).handle({ prompt: "notes.md 요약해줘", root });
  assert.equal(out.status, "ask_user");
  assert.equal(out.reasonCode, "which_file");
  assert.equal(out.choices?.length, 2);
  assert.match(out.choices![0].prompt!, /sub1\/notes\.md 요약해줘$/);
  assert.match(out.choices![1].label, /sub2\/notes\.md$/);
});

test("choices: a PDF page phrase with no file offers each PDF and the merged result", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pdfc-"));
  for (const n of ["a", "b"]) { const t = join(dir, `${n}.txt`); writeFileSync(t, `${n} 1\f${n} 2\f${n} 3`); writeFileSync(join(dir, `${n}.pdf`), execFileSync("/usr/sbin/cupsfilter", [t], { stdio: ["ignore", "pipe", "ignore"] })); }
  const files = [{ path: "a.pdf" }, { path: "b.pdf" }];
  const r = await convert({ root: dir, prompt: "a.pdf랑 b.pdf 합쳐줘. 2쪽은 빼고", files, ko: true });
  assert.equal(r.detail, "ambiguous_pages");
  assert.deepEqual(r.choices!.map((c) => c.label), ["a.pdf의 2쪽", "b.pdf의 2쪽", "합친 결과의 2쪽"]);
  // picking one runs the request with the file written in, which is now exact
  const r2 = await convert({ root: dir, prompt: r.choices![1].prompt!, files, ko: true });
  assert.match(r2.detail, /a\.pdf\[1–3\] \+ b\.pdf\[1, 3\], 5\/5 pages/);
  const r3 = await convert({ root: dir, prompt: r.choices![2].prompt!, files, ko: true });
  assert.match(r3.detail, /a\.pdf\[1, 3\] \+ b\.pdf\[1–3\], 5\/5 pages/);
  rmSync(dir, { recursive: true, force: true });
});
