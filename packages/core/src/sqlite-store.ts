import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { filterRecords } from "./store.js";
import type { MemoryRecord, MemoryType, SearchQuery } from "./types.js";
import { MEMORY_TYPES } from "./types.js";

const COLUMNS = `id, content, memory_type, created_at, last_accessed_at, access_count, importance, metadata`;

function rowToRecord(row: Record<string, unknown>): MemoryRecord {
  const t = row.memory_type as string;
  return {
    id: row.id as string,
    content: row.content as string,
    memoryType: (MEMORY_TYPES as readonly string[]).includes(t)
      ? (t as MemoryType)
      : "fact",
    createdAt: row.created_at as number,
    lastAccessedAt: row.last_accessed_at as number,
    accessCount: row.access_count as number,
    importance: row.importance as number,
    metadata: JSON.parse((row.metadata as string) || "{}"),
  };
}

/** SQLite 后端:基于 Node 内置 node:sqlite,零原生依赖。 */
export class SqliteStore {
  private db: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") {
      // CLI / 嵌入场景的合理默认:父目录不存在时自动创建
      mkdirSync(dirname(path), { recursive: true });
    }
    this.db = new DatabaseSync(path);
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS memories (
          id TEXT PRIMARY KEY,
          content TEXT NOT NULL,
          memory_type TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          last_accessed_at INTEGER NOT NULL,
          access_count INTEGER NOT NULL,
          importance REAL NOT NULL,
          metadata TEXT NOT NULL
       );
       CREATE INDEX IF NOT EXISTS idx_memories_type ON memories(memory_type);`,
    );
  }

  close(): void {
    this.db.close();
  }

  async insert(record: MemoryRecord): Promise<void> {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO memories
         (id, content, memory_type, created_at, last_accessed_at, access_count, importance, metadata)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.content,
        record.memoryType,
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
      .prepare(`SELECT ${COLUMNS} FROM memories`)
      .all() as Record<string, unknown>[];
    return filterRecords(rows.map(rowToRecord), query);
  }

  async count(): Promise<number> {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS n FROM memories`)
      .get() as { n: number };
    return row.n;
  }
}
