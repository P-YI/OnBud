// Quick A/B of the answer schema on real document questions (Archive folder), memory off.
// usage: OPENAFM_ANSWER_SCHEMA=v1|v2 node --experimental-strip-types --experimental-sqlite tools/bench/docqa-ab.ts <folder>
import { ApfelProvider } from "../../services/afm-adapter/apfel.ts";
import { Controller } from "../../services/controller/controller.ts";
import { openDb } from "../../services/telemetry/db.ts";

const root = process.argv[2];
const cases: [string, RegExp][] = [
  ["Top Reviewer 문서에서 편지를 발송한 주체가 누구야?", /Finale|Doshi/],
  ["kcc2026_final.pdf는 몇 쪽이야?", /\b3\b|3쪽|3페이지|세 쪽/],
  ["ASGuard 논문은 어느 학회 논문이야?", /ICLR/],
  ["등록증 문서의 발명 명칭이 뭐야?", /답변 생성/],
  ["2410.09870v3.pdf에서 제안한 벤치마크 이름이 뭐야?", /ChroKnowBench/i],
  ["2502.14258v2.pdf 논문의 제목이 뭐야?", /Temporal Heads/i],
  ["kcc2026_final.pdf에서 도구 호출 성능을 평가한 벤치마크는?", /BFCL/],
  ["Master_s_Thesis.pdf의 저자 이름은?", /Yein Park|박예인/],
];
const c = new Controller({ afm: new ApfelProvider(), db: openDb() });
let ok = 0, ms = 0;
for (const [q, want] of cases) {
  const t0 = Date.now();
  const o = await c.handle({ prompt: q, root, frontEnd: "test" });
  const dt = Date.now() - t0; ms += dt;
  const pass = o.status === "answered_local" && want.test(o.answer ?? "");
  if (pass) ok++;
  const g = o.steps.find((s) => s.kind === "grounding")?.detail ?? "";
  console.log(`${pass ? "PASS" : "FAIL"} ${(dt / 1000).toFixed(1)}s ${g.padEnd(24)} ${q} → ${(o.answer ?? o.reasonCode).replace(/\s+/g, " ").slice(0, 110)}`);
}
console.log(`${process.env.OPENAFM_ANSWER_SCHEMA ?? "v2"}: ${ok}/${cases.length}  avg ${(ms / cases.length / 1000).toFixed(1)}s`);
