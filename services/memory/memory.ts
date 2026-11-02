// Agentic memory: small, per-project notes that survive across sessions and fill the gap that
// context compaction leaves (the capsule only holds the current task).
//
// Design borrowed from the literature, kept deterministic so no extra model calls are needed:
//   - MemGPT (Packer et al., 2023): tiered memory — tiny working context (capsule) + external store,
//     paged in by retrieval.
//   - Generative Agents (Park et al., 2023): retrieval score = recency + importance + relevance.
//   - Reflexion (Shinn et al., 2023): store a short verbal "lesson" after a failure/escalation and
//     show it on similar later tasks.
//   - A-MEM (Xu et al., 2025): Zettelkasten-style notes with keywords and links between related
//     notes (here: notes that share a file path).
//   - Mem0 (Chhikara et al., 2025): update-or-insert instead of appending duplicates.
// Memory is advisory: it is labelled as possibly stale and never replaces reading the file.

import type { DatabaseSync } from "node:sqlite";
import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { now, openDb } from "../telemetry/db.ts";
import { redact } from "../security/gate.ts";

export type NoteKind = "episode" | "file_summary" | "lesson" | "preference";

export interface Note {
  id?: number;
  kind: NoteKind;
  text: string;
  keywords?: string[];
  paths?: string[];          // project-relative; file_summary notes go stale when the file changes
  importance?: number;       // 0..1
  sourceTask?: string;
  fileStamp?: string;        // "<size>:<mtimeMs>" for file_summary staleness checks
}

export interface Recalled extends Note { score: number; createdAt: string }

const HALF_LIFE_DAYS = 7;
const STOP = new Set(["the", "and", "for", "with", "this", "that", "what", "how", "please", "해줘", "알려줘", "설명해줘", "나열하고", "정리해줘"]);

export function queryTerms(q: string): string[] {
  const words = q.toLowerCase().match(/[\p{L}\p{N}_.-]+/gu) ?? [];
  return [...new Set(words.filter((w) => w.length >= 2 && !STOP.has(w)))].slice(0, 12);
}

export class MemoryStore {
  private db: DatabaseSync;
  constructor(db: DatabaseSync = openDb()) { this.db = db; }

  /** Insert, or update the existing note with the same kind + paths (+ same text for path-less notes). */
  remember(projectHash: string, n: Note): number | undefined {
    try {
      const text = redact(n.text).text.slice(0, 1200);
      const paths = (n.paths ?? []).join("\n");
      const keywords = (n.keywords ?? []).join(" ");
      const stampedText = n.fileStamp ? `${text}\n[stamp ${n.fileStamp}]` : text;
      const existing = paths
        ? this.db.prepare("SELECT id FROM memory_notes WHERE project_hash=? AND kind=? AND paths=?").get(projectHash, n.kind, paths) as any
        : this.db.prepare("SELECT id FROM memory_notes WHERE project_hash=? AND kind=? AND text=?").get(projectHash, n.kind, stampedText) as any;
      if (existing) {
        // FTS5 external-content tables need delete+insert to reindex; do it via the row itself.
        this.db.prepare("DELETE FROM memory_notes WHERE id=?").run(existing.id);
      }
      const r = this.db.prepare(`INSERT INTO memory_notes(project_hash, kind, text, keywords, paths, importance, created_at, source_task, links)
        VALUES (?,?,?,?,?,?,?,?,?)`).run(projectHash, n.kind, stampedText, keywords, paths, n.importance ?? 0.5, now(), n.sourceTask ?? null, "");
      const id = Number(r.lastInsertRowid);
      // A-MEM-style links: connect to other notes about the same files.
      if (n.paths?.length) {
        const like = n.paths.map(() => "paths LIKE ?").join(" OR ");
        const rel = this.db.prepare(`SELECT id FROM memory_notes WHERE project_hash=? AND id<>? AND (${like}) LIMIT 5`)
          .all(projectHash, id, ...n.paths.map((p) => `%${p}%`)) as any[];
        if (rel.length) this.db.prepare("UPDATE memory_notes SET links=? WHERE id=?").run(rel.map((x) => x.id).join(","), id);
      }
      return id;
    } catch {
      return undefined;
    }
  }

  recall(projectHash: string, query: string, opts: { k?: number; root?: string; kinds?: NoteKind[] } = {}): Recalled[] {
    const k = opts.k ?? 3;
    const terms = queryTerms(query);
    if (!terms.length) return [];
    try {
      const long = terms.filter((t) => [...t].length >= 3).map((t) => `"${t.replace(/"/g, "")}"`);
      const ids = new Map<number, number>();   // id -> relevance
      if (long.length) {
        const rows = this.db.prepare(`SELECT rowid AS id, bm25(memory_fts) AS s FROM memory_fts WHERE memory_fts MATCH ? LIMIT 50`).all(long.join(" OR ")) as any[];
        for (const r of rows) ids.set(r.id, Math.max(ids.get(r.id) ?? 0, 1));
      }
      for (const t of terms.filter((t) => [...t].length < 3)) {   // trigram cannot match 1–2 char terms (e.g. 논문)
        const rows = this.db.prepare("SELECT id FROM memory_notes WHERE project_hash=? AND (text LIKE ? OR keywords LIKE ?) LIMIT 50").all(projectHash, `%${t}%`, `%${t}%`) as any[];
        for (const r of rows) ids.set(r.id, (ids.get(r.id) ?? 0) + 0.5);
      }
      if (!ids.size) return [];
      const rows = this.db.prepare(`SELECT * FROM memory_notes WHERE project_hash=? AND id IN (${[...ids.keys()].join(",")})`).all(projectHash) as any[];
      const nowMs = Date.now();
      const scored: Recalled[] = [];
      for (const r of rows) {
        if (opts.kinds && !opts.kinds.includes(r.kind)) continue;
        if (r.kind === "file_summary" && opts.root && this.stale(r, opts.root)) continue;
        const text = String(r.text);
        const hits = terms.filter((t) => (text + " " + r.keywords + " " + r.paths).toLowerCase().includes(t)).length;
        const relevance = Math.min(1, (hits / terms.length) + 0.2 * (ids.get(r.id) ?? 0));
        const ageDays = (nowMs - Date.parse(r.last_used_at ?? r.created_at)) / 86_400_000;
        const recency = Math.pow(0.5, ageDays / HALF_LIFE_DAYS);
        const score = 0.5 * relevance + 0.3 * recency + 0.2 * Number(r.importance);
        scored.push({ id: r.id, kind: r.kind, text: text.replace(/\n\[stamp [^\]]+\]$/, ""), keywords: String(r.keywords).split(" ").filter(Boolean),
          paths: String(r.paths).split("\n").filter(Boolean), importance: r.importance, score, createdAt: r.created_at });
      }
      scored.sort((a, b) => b.score - a.score);
      const top = scored.slice(0, k);
      for (const n of top) this.db.prepare("UPDATE memory_notes SET last_used_at=?, use_count=use_count+1 WHERE id=?").run(now(), n.id!);
      return top;
    } catch {
      return [];
    }
  }

  /** Exact lookup of a fresh file_summary by path (+ tag), no ranking involved. */
  fileSummary(projectHash: string, path: string, root: string, tag?: string): Recalled | undefined {
    try {
      const rows = this.db.prepare("SELECT * FROM memory_notes WHERE project_hash=? AND kind='file_summary' AND paths=? ORDER BY id DESC").all(projectHash, path) as any[];
      const r = rows.find((x) => !tag || String(x.keywords).split(" ").includes(tag));
      if (!r || this.stale(r, root)) return undefined;
      this.db.prepare("UPDATE memory_notes SET last_used_at=?, use_count=use_count+1 WHERE id=?").run(now(), r.id);
      return { id: r.id, kind: r.kind, text: String(r.text).replace(/\n\[stamp [^\]]+\]$/, ""), paths: [path], keywords: String(r.keywords).split(" "), importance: r.importance, score: 1, createdAt: r.created_at };
    } catch { return undefined; }
  }

  private stale(row: any, root: string): boolean {
    const stamp = /\[stamp ([^\]]+)\]$/.exec(String(row.text))?.[1];
    const path = String(row.paths).split("\n")[0];
    if (!stamp || !path) return false;
    const abs = resolve(root, path);
    if (!existsSync(abs)) return true;
    const st = statSync(abs);
    return stamp !== `${st.size}:${Math.floor(st.mtimeMs)}`;
  }

  list(projectHash?: string, limit = 50): any[] {
    return projectHash
      ? this.db.prepare("SELECT id, kind, substr(text,1,120) AS text, paths, use_count, created_at FROM memory_notes WHERE project_hash=? ORDER BY id DESC LIMIT ?").all(projectHash, limit)
      : this.db.prepare("SELECT id, project_hash, kind, substr(text,1,120) AS text, use_count, created_at FROM memory_notes ORDER BY id DESC LIMIT ?").all(limit);
  }

  forget(projectHash?: string): number {
    const r = projectHash
      ? this.db.prepare("DELETE FROM memory_notes WHERE project_hash=?").run(projectHash)
      : this.db.prepare("DELETE FROM memory_notes").run();
    return Number(r.changes);
  }
}

export function fileStamp(root: string, rel: string): string | undefined {
  try { const st = statSync(resolve(root, rel)); return `${st.size}:${Math.floor(st.mtimeMs)}`; } catch { return undefined; }
}

/** Render recalled notes for the capsule; clearly marked as advisory. */
export function renderMemory(notes: Recalled[]): string {
  // Kind and files go in a bracket that does not look like a path (AFM once read "episode · stats.py" as one).
  return notes.map((n) => `- [${n.kind} note${n.paths?.length ? `; files: ${n.paths.join(", ")}` : ""}] ${n.text}`).join("\n");
}
