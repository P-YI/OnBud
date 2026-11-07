import { test } from "node:test";
import assert from "node:assert/strict";
const { relevantLines, typeMismatch } = await import("../services/controller/question-frame.ts");

const paper = "TimeShift: A Benchmark for Temporal Knowledge in Small Language Models\n\nMina Cho and Daniel Ortiz\nAccepted at EMNLP 2026 (Main Conference)\n\nAbstract\nWe introduce TimeShift, a benchmark of 4,200 questions.";

test("relevantLines: lines with the most search words, from anywhere in the text, in document order", () => {
  const filler = Array.from({ length: 400 }, (_, i) => `Paragraph ${i} about methods.`).join("\n");
  const text = `${filler}\nTotal due: $1,284.50\nDue by: 2026-12-15\n${filler}`;
  assert.match(relevantLines(text, ["total", "due", "amount"]), /^Total due: \$1,284.50\nDue by: 2026-12-15\n/);
  assert.match(relevantLines(paper, ["conference", "accepted at", "학회"]), /^Accepted at EMNLP 2026 \(Main Conference\)/);
  assert.equal(relevantLines(paper, []), "");
});

test("typeMismatch: title repeated for a venue, missing number or date; titles and summaries unchecked", () => {
  const title = "TimeShift: A Benchmark for Temporal Knowledge in Small Language Models";
  assert.match(typeMismatch("venue_or_place", title, title)!, /repeats the document's title/);
  assert.match(typeMismatch("venue_or_place", `${title}.`, title)!, /title/);
  assert.equal(typeMismatch("venue_or_place", `${title}는 EMNLP 2026 (Main Conference)에서 발표되었습니다.`, title), undefined);
  assert.equal(typeMismatch("title_or_name", title, title), undefined);
  assert.match(typeMismatch("amount_or_number", "The invoice total is listed at the end.")!, /no number/);
  assert.equal(typeMismatch("amount_or_number", "총액은 $1,284.50이에요."), undefined);
  assert.equal(typeMismatch("count", "세 개예요."), undefined);
  assert.match(typeMismatch("date_or_time", "It is due soon.")!, /no date/);
  assert.equal(typeMismatch("date_or_time", "November 14"), undefined);
  assert.equal(typeMismatch("person", "Hana Lee"), undefined);
});

test("ignoredLine: a line with a specific question word that the answer does not use; generic words skipped", async () => {
  const { ignoredLine, translationWords } = await import("../services/controller/question-frame.ts");
  const lines = "Accepted at EMNLP 2026 (Main Conference)\nAbstract";
  const title = "TimeShift: A Benchmark for Temporal Knowledge in Small Language Models";
  assert.deepEqual(ignoredLine(["paper", "title", "conference"], lines, title), { word: "conference", line: "Accepted at EMNLP 2026 (Main Conference)" });
  assert.equal(ignoredLine(["conference"], lines, "EMNLP 2026에 실렸어요."), undefined);
  assert.equal(ignoredLine(["paper", "title"], lines, title), undefined);   // only generic words
  assert.deepEqual(translationWords("Which conference paper is paper.pdf?", ["paper.pdf"]), ["conference"]);
  assert.deepEqual(translationWords("What are the termination conditions of the contract?"), ["termination", "conditions", "contract"]);
});

test("intentSeeds: a named folder scopes the counts; a bare known extension before 파일/files is counted", async () => {
  const { mkdtempSync, mkdirSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { intentSeeds } = await import("../services/controller/controller.ts");
  const root = mkdtempSync(join(tmpdir(), "seeds-")); mkdirSync(join(root, "services"));
  const s = intentSeeds("services 폴더에 ts 파일이 몇 개야?", [], root).map((x) => x.command);
  assert.match(s[0], /^find \.\/services -type f -name '\*\.ts'/);
  assert.match(intentSeeds("How many files are there?", [], root)[0].command, /^find \. -type f/);   // no folder named
  assert.equal(intentSeeds("the files in nope 폴더 몇 개야", [], root).some((x) => x.command.includes("./nope")), false);   // not a real folder
});

test("typedCommand: a command typed as the whole message, not a sentence", async () => {
  const { typedCommand } = await import("../services/controller/controller.ts");
  assert.equal(typedCommand("git log --oneline -3"), "git log --oneline -3");
  assert.equal(typedCommand("$ ls -la"), "ls -la");
  assert.equal(typedCommand("make me a sandwich"), undefined);
  assert.equal(typedCommand("what is git"), undefined);
  assert.equal(typedCommand("git 로그 보여줘"), undefined);
  assert.equal(typedCommand("zzznotacommand --x"), undefined);
});
