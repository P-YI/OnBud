import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.OPENAFM_HOME = mkdtempSync(join(tmpdir(), "openafm-home-"));
const { kindOf, readDocument, humanSize } = await import("../services/context-builder/documents.ts");
const { isInventoryRequest, targetDir, walk, buildInventory, renderInventory, realAuthors } = await import("../services/controller/inventory.ts");
const { keyFacts, renderCapsule, capsuleFidelity } = await import("../services/context-builder/capsule.ts");
const { Controller, unverifiedPaths } = await import("../services/controller/controller.ts");
const { openDb } = await import("../services/telemetry/db.ts");
const { MemoryStore } = await import("../services/memory/memory.ts");
const { FakeAFM, isTriage, isPick, isArgs, isAnswer, makeRepo } = await import("./helpers.ts");

const root = makeRepo({
  "paper.rtf": "{\\rtf1\\ansi Temporal Heads in Language Models. We study attention heads.}",
  "notes.md": "# Meeting notes\nDiscussed the GRPO reward bug.\n",
  "train.py": "def reward(x):\n    return x\n",
  "docs/guide.md": "Guide for setup\n",
  ".env": "OPENAI_API_KEY=sk-proj-" + "z".repeat(40) + "\n",
  "photo.png": "not really a png",
});

test("document kinds and extraction (rtf via textutil, md read)", async () => {
  assert.equal(kindOf("a.PDF"), "pdf");
  assert.equal(kindOf("deck.pptx"), "slides");
  assert.equal(kindOf("x.doc"), "word");
  assert.equal(kindOf("t.py"), "code");
  const rtf = await readDocument(root, "paper.rtf", { withMetadata: false });
  assert.equal(rtf.method, "textutil");
  assert.match(rtf.text, /Temporal Heads/);
  const md = await readDocument(root, "notes.md", { withMetadata: false });
  assert.match(md.text, /GRPO reward bug/);
  assert.equal((await readDocument(root, ".env", { withMetadata: false })).error, "blocked:secret_path");
  assert.equal((await readDocument(root, "nope.pdf", { withMetadata: false })).error, "not_found");
  assert.equal(humanSize(9_422_026), "9.0 MB");
});

test("document cache serves the second read", async () => {
  const db = openDb(":memory:");
  await readDocument(root, "notes.md", { withMetadata: false, db });
  assert.equal((db.prepare("SELECT count(*) n FROM doc_cache").get() as any).n, 1);
  const again = await readDocument(root, "notes.md", { withMetadata: false, db });
  assert.match(again.text, /Meeting notes/);
});

test("inventory intent detection (ko/en) and target folder", () => {
  for (const q of ["디렉토리 내의 문서를 나열하고 설명해줘.", "이 폴더에 어떤 파일이 있어?", "docs 폴더 파일 목록 알려줘", "List and describe the documents in this folder", "what files are in this directory"]) {
    assert.ok(isInventoryRequest(q), q);
  }
  for (const q of ["explain f1_macro", "fix the bug in train.py", "안녕, 너는 뭘 할 수 있어?"]) assert.ok(!isInventoryRequest(q), q);
  assert.equal(targetDir("docs 폴더 파일 목록 알려줘", root), "docs");
  assert.equal(targetDir("이 폴더 파일 목록", root), ".");
  const w = walk(root);
  assert.ok(w.files.includes("docs/guide.md") && !w.files.includes(".env"));
  assert.deepEqual(realAuthors(["LaTeX with hyperref", "Yein Park", "Hwp 2024 13.0"]), ["Yein Park"]);
});

test("inventory: lists only real files, describes via AFM, Korean retry, salvage, memory reuse", async () => {
  const db = openDb(":memory:");
  const memory = new MemoryStore(db);
  let calls = 0;
  const afm = new FakeAFM((r) => {
    calls++;
    if (r.user.includes("File: paper.rtf")) return r.system.includes("previous summary") ? { json: { title: "Temporal Heads", doc_type: "paper", summary: "시간 헤드를 다루는 논문" } } : { json: { title: "Temporal Heads", doc_type: "paper", summary: "A paper about heads" } };
    if (r.user.includes("File: notes.md")) return { failure: "schema_violation", json: { title: "", doc_type: "meeting", summary: "회의 노트" } };
    return { json: { title: "", doc_type: "code", summary: "보상 함수 코드" } };
  });
  const inv = await buildInventory(root, "디렉토리 문서 나열해줘", { afm, db, memory, projectHash: "p", timeoutMs: 1000 });
  const out = renderInventory(inv);
  assert.match(out, /파일 \d+개/);
  assert.match(out, /paper\.rtf.*Temporal Heads/);
  assert.match(out, /시간 헤드를 다루는 논문/);           // Korean retry used
  assert.match(out, /회의 노트/);                         // salvaged schema violation
  assert.doesNotMatch(out, /\.env/);
  assert.match(out, /photo\.png/);                        // listed, not described
  const first = calls;
  const inv2 = await buildInventory(root, "디렉토리 문서 나열해줘", { afm, db, memory, projectHash: "p", timeoutMs: 1000 });
  assert.ok(calls - first < first, "second run reuses memory");
  assert.match(renderInventory(inv2), /메모리에서 재사용/);
});

test("controller: inventory fast path without project folder asks to open one", async () => {
  const afm = new FakeAFM(() => ({ failure: "empty" }));
  const out = await new Controller({ afm }).handle({ prompt: "디렉토리 내의 문서를 나열하고 설명해줘.", root: undefined });
  assert.equal(out.reasonCode, "needs_project_folder");
  assert.match(out.answer!, /폴더를 열어/);
});

test("controller: inventory works even when AFM is down (metadata only)", async () => {
  const afm = new FakeAFM(() => ({ failure: "unavailable" }));
  afm.healthy = false;
  const out = await new Controller({ afm }).handle({ prompt: "List the documents in this folder", root });
  assert.equal(out.status, "answered_local");
  assert.match(out.answer!, /notes\.md/);
});

test("capsule keeps key facts of trimmed evidence; fidelity is measurable", () => {
  assert.deepEqual(keyFacts("see src/a.py:12 and `run_task` raised ValueError in docs/b.md"), ["src/a.py:12", "`run_task`", "ValueError", "docs/b.md"]);
  const c = { goal: "g", evidence: [
    { label: "search", body: "x".repeat(4000) + "\nsrc/old.py:3: def legacy()" },
    { label: "file src/new.py", body: "1| def fresh(): pass" },
  ] };
  const r = renderCapsule(c, 900);
  assert.match(r.text, /KEY FACTS FROM TRIMMED EVIDENCE.*src\/old\.py:3/);
  const f = capsuleFidelity(c, r.text);
  assert.equal(f.missing.length, 0);
});

test("citation check flags invented paths", () => {
  assert.deepEqual(unverifiedPaths("see docs/project_overview.md and notes.md", root, "list_dir .\nnotes.md"), ["docs/project_overview.md"]);
});

test("controller retries once when the answer cites a non-existent file", async () => {
  let answers = 0;
  const afm = new FakeAFM((r) => {
    if (isTriage(r)) return { json: { task_type: "other", escalate: false, reason: "" } };
    if (isPick(r)) return { json: { action: afm.calls.filter(isPick).length === 1 ? "list_dir" : "respond_directly" } };
    if (isArgs(r)) return { json: { path: "." } };
    if (isAnswer(r)) { answers++; return { json: { answer: answers === 1 ? "It is docs/project_overview.md" : "Files: notes.md, train.py", needs_escalation: false, assumptions: [] } }; }
    return { failure: "empty" };
  });
  const out = await new Controller({ afm }).handle({ prompt: "what is in here?", root });
  assert.equal(answers, 2);
  assert.equal(out.outcomeClass, "local_verified");
  assert.match(afm.calls.filter(isAnswer)[1].user, /cited files that do not exist: docs\/project_overview\.md/);
});
