import { test } from "node:test";
import assert from "node:assert/strict";
const { publicUrl, isWebRequest, kindFor } = await import("../services/context-builder/websearch.ts");

test("web requests and kinds", () => {
  assert.ok(isWebRequest("PCC 컨텍스트 크기를 웹에서 찾아줘"));
  assert.ok(isWebRequest("search the web for apfel releases"));
  assert.ok(!isWebRequest(".cache 폴더 찾아줘"));
  assert.ok(!isWebRequest("kcc2026_final.pdf는 몇 쪽이야?"));
  for (const p of ["show the latest commit", "is this repo online?", "news.py 파일 설명해줘", "최신 커밋 보여줘"]) assert.ok(!isWebRequest(p), p);
  for (const p of ["PCC 최신 정보 웹에서 찾아줘", "LLM 최신 동향 알려줘", "구글에서 apfel 찾아줘", "인터넷으로 검색해줘"]) assert.ok(isWebRequest(p), p);
  assert.equal(kindFor("temporal heads 관련 논문 웹에서 찾아줘"), "papers");
  assert.equal(kindFor("RAG가 뭔지 위키에서 찾아줘"), "encyclopedia");
  assert.equal(kindFor("apfel 최신 버전 웹에서 확인해줘"), "general");
});

test("page fetches only reach public hosts (SSRF guard)", () => {
  for (const u of ["https://arxiv.org/abs/2502.14258", "http://en.wikipedia.org/wiki/X"]) assert.ok(publicUrl(u), u);
  for (const u of ["http://127.0.0.1:11435/health", "http://localhost:8888", "http://192.168.0.1/", "http://10.0.0.5/x", "file:///etc/passwd", "http://user:pw@example.com/", "http://intranet/", "http://[::1]/", "http://2130706433/"]) assert.ok(!publicUrl(u), u);
});
