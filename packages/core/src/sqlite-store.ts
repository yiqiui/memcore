import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DEFAULT_NAMESPACE } from "./types.js";
import { filterRecords, ns } from "./store.js";
import type { MemoryRecord, MemoryType, SearchQuery } from "./types.js";
import { MEMORY_TYPES } from "./types.js";
import type { FullTextHit, FullTextQuery, FullTextSearchable } from "./fts.js";

const COLUMNS = `id, content, memory_type, namespace, created_at, last_accessed_at, access_count, importance, metadata`;

/** FTS5 短查询回退阈值:trigram 分词器最少需要 3 个字符。 */
const FTS_MIN_CHARS = 3;

function rowToRecord(row: Record<string, unknown>): MemoryRecord {
  const t = row.memory_type as string;
  return {
    id: row.id as string,
    content: row.content as string,
    memoryType: (MEMORY_TYPES as readonly string[]).includes(t)
      ? (t as MemoryType)
      : "fact",
    namespace: (row.namespace as string) ?? DEFAULT_NAMESPACE,
    createdAt: row.created_at as number,
    lastAccessedAt: row.last_accessed_at as number,
    accessCount: row.access_count as number,
    importance: row.importance as number,
    metadata: JSON.parse((row.metadata as string) || "{}"),
  };
}

/**
 * FTS MATCH 构造(trigram 语义下的召回策略):
 * - 精确短语(子串命中,最强信号)
 * - OR ASCII 词的 AND(多词英文召回)
 * - OR CJK 滑动三元组(中文无分词边界,OR + BM25 排序近似相关度)
 */
function buildFtsQuery(text: string): string {
  const parts: string[] = [`"${text.replace(/"/g, '""')}"`];
  const asciiWords = (text.match(/[a-zA-Z0-9]+/g) ?? []).filter(
    (w) => w.length >= FTS_MIN_CHARS,
  );
  if (asciiWords.length > 1) {
    parts.push(`(${asciiWords.map((w) => `"${w}"`).join(" AND ")})`);
  }
  const cjkTerms = new Set<string>();
  for (const run of text.match(/[一-鿿]+/g) ?? []) {
    for (let i = 0; i + FTS_MIN_CHARS <= run.length; i++) {
      cjkTerms.add(run.slice(i, i + FTS_MIN_CHARS));
    }
  }
  if (cjkTerms.size === 1) {
    parts.push(`"${[...cjkTerms][0]}"`);
  } else if (cjkTerms.size > 1) {
    parts.push(`(${[...cjkTerms].map((t) => `"${t}"`).join(" OR ")})`);
  }
  return parts.join(" OR ");
}

/**
 * SQLite 后端(零原生依赖,Node 内置 node:sqlite)。
 * schema v2:namespace 分区列 + FTS5(trigram)全文索引;打开旧库自动迁移。
 */
export class SqliteStore implements FullTextSearchable {
  private db: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") {
      // CLI / 嵌入场景的合理默认:父目录不存在时自动创建
      mkdirSync(dirname(path), { recursive: true });
    }
    this.db = new DatabaseSync(path);
    this.migrate();
  }

  private migrate(): void {
    const cols = this.db.prepare(`PRAGMA table_info(memories)`).all() as {
      name: string;
    }[];
    let needsRebuild = false;
    if (cols.length === 0) {
      // 全新库
      needsRebuild = true;
      this.db.exec(`CREATE TABLE memories (
          id TEXT PRIMARY KEY,
          content TEXT NOT NULL,
          memory_type TEXT NOT NULL,
          namespace TEXT NOT NULL DEFAULT '${DEFAULT_NAMESPACE}',
          created_at INTEGER NOT NULL,
          last_accessed_at INTEGER NOT NULL,
          access_count INTEGER NOT NULL,
          importance REAL NOT NULL,
          metadata TEXT NOT NULL
       )`);
    } else if (!cols.some((c) => c.name === "namespace")) {
      // 0.1.0 → 0.2.0 迁移
      needsRebuild = true;
      this.db.exec(
        `ALTER TABLE memories ADD COLUMN namespace TEXT NOT NULL DEFAULT '${DEFAULT_NAMESPACE}'`,
      );
    }
    this.db.exec(
      `CREATE INDEX IF NOT EXISTS idx_memories_ns_type ON memories(namespace, memory_type);`,
    );
    this.ensureFts(needsRebuild);
    this.db.exec(`PRAGMA user_version = 2`);
  }

  private ensureFts(rebuild: boolean): void {
    this.db.exec(
      `CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
          content,
          content='memories', content_rowid=rowid,
          tokenize='trigram'
       );
       CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
         INSERT INTO memories_fts(rowid, content) VALUES (new.rowid, new.content);
       END;
       CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
         INSERT INTO memories_fts(memories_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
       END;
       CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE OF content ON memories BEGIN
         INSERT INTO memories_fts(memories_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
         INSERT INTO memories_fts(rowid, content) VALUES (new.rowid, new.content);
       END;`,
    );
    // 外部内容表的 COUNT(*) 会重定向到内容表,不能用空判断;仅在新建/迁移时 rebuild
    if (rebuild) {
      this.db.exec(`INSERT INTO memories_fts(memories_fts) VALUES ('rebuild')`);
    }
  }

  close(): void {
    this.db.close();
  }

  async insert(record: MemoryRecord): Promise<void> {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO memories
         (id, content, memory_type, namespace, created_at, last_accessed_at, access_count, importance, metadata)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.content,
        record.memoryType,
        record.namespace ?? DEFAULT_NAMESPACE,
        record.createdAt,
        record.lastAccessedAt,
        record.accessCount,
        record.importance,
        JSON.stringify(record.metadata),
      );
  }

  async get(id: string): Promise<MemoryRecord | undefined> {
    const row = this.db
      .prepare(`SELECT ${COLUMNS} FROM memories WHERE id = ?`)
      .get(id) as Record<string, unknown> | undefined;
    return row ? rowToRecord(row) : undefined;
  }

  async updateAccess(id: string, now: number): Promise<void> {
    this.db
      .prepare(
        `UPDATE memories SET last_accessed_at = ?, access_count = access_count + 1 WHERE id = ?`,
      )
      .run(now, id);
  }

  async delete(id: string): Promise<void> {
    this.db.prepare(`DELETE FROM memories WHERE id = ?`).run(id);
  }

  async list(query: SearchQuery): Promise<MemoryRecord[]> {
    const rows = this.db
      .prepare(
        `SELECT ${COLUMNS} FROM memories WHERE namespace = ? ${query.memoryType ? "AND memory_type = ?" : ""}`,
      )
      .all(...(query.memoryType ? [ns(query), query.memoryType] : [ns(query)])) as Record<string, unknown>[];
    return filterRecords(rows.map(rowToRecord), query);
  }

  async count(): Promise<number> {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS n FROM memories WHERE namespace = ?`)
      .get(ns()) as { n: number };
    return row.n;
  }

  /** BM25 全文检索(trigram);短查询回退 LIKE 子串。 */
  searchFullText(query: FullTextQuery): FullTextHit[] {
    const limit = query.limit ?? 10;
    const typeCond = query.memoryType ? ` AND m.memory_type = '${query.memoryType}'` : "";
    if (query.text.length >= FTS_MIN_CHARS) {
      const qualified = COLUMNS.split(", ")
        .map((c) => `m.${c}`)
        .join(", ");
      const rows = this.db
        .prepare(
          `SELECT ${qualified}, bm25(memories_fts) AS score
           FROM memories_fts f JOIN memories m ON m.rowid = f.rowid
           WHERE memories_fts MATCH ?2 AND m.namespace = ?1${typeCond}
           ORDER BY score LIMIT ${limit}`,
        )
        .all(query.namespace ?? DEFAULT_NAMESPACE, buildFtsQuery(query.text)) as Record<string, unknown>[];
      // bm25() 越小越相关,统一为"越大越相关"
      return rows.map((row) => ({ record: rowToRecord(row), score: -Number(row.score) }));
    }
    // 短查询回退:LIKE 子串过滤,等分
    const rows = this.db
      .prepare(
        `SELECT ${COLUMNS} FROM memories m
         WHERE m.namespace = ? AND content LIKE '%' || ? || '%'${typeCond}
         LIMIT ${limit}`,
      )
      .all(query.namespace ?? DEFAULT_NAMESPACE, query.text) as Record<string, unknown>[];
    return rows.map((row) => ({ record: rowToRecord(row), score: 1 }));
  }
}
