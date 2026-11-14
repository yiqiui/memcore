import { Pool } from "pg";
import {
  cosineTopK,
  filterRecords,
  registerBackend,
  type MemoryRecord,
  type MemoryType,
  MEMORY_TYPES,
  type MemoryStore,
  type SearchQuery,
  type VectorHit,
  type VectorQuery,
} from "@memcore/core";

const COLUMNS = `id, content, memory_type, namespace, created_at, last_accessed_at, access_count, importance, metadata, expiration_at`;

function rowToRecord(row: Record<string, unknown>): MemoryRecord {
  const t = row.memory_type as string;
  return {
    id: row.id as string,
    content: row.content as string,
    memoryType: (MEMORY_TYPES as readonly string[]).includes(t)
      ? (t as MemoryType)
      : "fact",
    createdAt: Number(row.created_at),
    lastAccessedAt: Number(row.last_accessed_at),
    accessCount: Number(row.access_count),
    importance: Number(row.importance),
    namespace: (row.namespace as string) ?? "default",
    expirationAt: (row.expiration_at as number | null) ?? undefined,
    metadata: (row.metadata ?? {}) as Record<string, unknown>,
  };
}

/**
 * PostgreSQL 后端。检测到 pgvector 扩展时自动增加 embedding vector(1536) 列,
 * 未检测到则降级为普通表(检索语义由 core 层负责,相似度检索属于后续能力)。
 */
export class PgStore implements MemoryStore {
  private constructor(
    private pool: Pool,
    private hasVector: boolean,
  ) {}

  static async connect(connectionString: string): Promise<PgStore> {
    const pool = new Pool({ connectionString });
    const hasVector = await PgStore.tryEnablePgVector(pool);
    await pool.query(
      `CREATE TABLE IF NOT EXISTS memories (
          id TEXT PRIMARY KEY,
          content TEXT NOT NULL,
          memory_type TEXT NOT NULL,
          namespace TEXT NOT NULL DEFAULT 'default',
          expiration_at BIGINT,
          created_at BIGINT NOT NULL,
          last_accessed_at BIGINT NOT NULL,
          access_count INTEGER NOT NULL,
          importance REAL NOT NULL,
          metadata JSONB NOT NULL DEFAULT '{}'
       )`,
    );
    await pool.query(
      `ALTER TABLE memories ADD COLUMN IF NOT EXISTS namespace TEXT NOT NULL DEFAULT 'default'`,
    );
    await pool.query(
      `ALTER TABLE memories ADD COLUMN IF NOT EXISTS expiration_at BIGINT`,
    );
    await pool.query(
      `CREATE INDEX IF NOT EXISTS idx_memories_ns_type ON memories(namespace, memory_type)`,
    );
    if (hasVector) {
      await pool.query(
        `ALTER TABLE memories ADD COLUMN IF NOT EXISTS embedding vector(1536)`,
      );
    } else {
      // 无 pgvector 时降级为 JSONB 向量列(检索退化为内存余弦)
      await pool.query(
        `ALTER TABLE memories ADD COLUMN IF NOT EXISTS embedding JSONB`,
      );
    }
    return new PgStore(pool, hasVector);
  }

  private static async tryEnablePgVector(pool: Pool): Promise<boolean> {
    try {
      await pool.query(`CREATE EXTENSION IF NOT EXISTS vector`);
      const { rows } = await pool.query(
        `SELECT 1 FROM pg_extension WHERE extname = 'vector'`,
      );
      return rows.length > 0;
    } catch {
      return false;
    }
  }

  async insert(record: MemoryRecord): Promise<void> {
    await this.pool.query(
      `INSERT INTO memories
       (id, content, memory_type, namespace, created_at, last_accessed_at, access_count, importance, metadata, expiration_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (id) DO UPDATE SET
         content = EXCLUDED.content, memory_type = EXCLUDED.memory_type, namespace = EXCLUDED.namespace,
         expiration_at = EXCLUDED.expiration_at,
         created_at = EXCLUDED.created_at, last_accessed_at = EXCLUDED.last_accessed_at,
         access_count = EXCLUDED.access_count, importance = EXCLUDED.importance,
         metadata = EXCLUDED.metadata`,
      [
        record.id,
        record.content,
        record.memoryType,
        record.namespace ?? "default",
        record.expirationAt ?? null,
        record.createdAt,
        record.lastAccessedAt,
        record.accessCount,
        record.importance,
        JSON.stringify(record.metadata),
      ],
    );
  }

  async get(id: string): Promise<MemoryRecord | undefined> {
    const { rows } = await this.pool.query(
      `SELECT ${COLUMNS} FROM memories WHERE id = $1`,
      [id],
    );
    return rows.length > 0 ? rowToRecord(rows[0]) : undefined;
  }

  async updateAccess(id: string, now: number): Promise<void> {
    await this.pool.query(
      `UPDATE memories SET last_accessed_at = $1, access_count = access_count + 1 WHERE id = $2`,
      [now, id],
    );
  }

  async delete(id: string): Promise<void> {
    await this.pool.query(`DELETE FROM memories WHERE id = $1`, [id]);
  }

  async list(query: SearchQuery): Promise<MemoryRecord[]> {
    const namespace = query.namespace ?? "default";
    const { rows } = await this.pool.query(
      `SELECT ${COLUMNS} FROM memories WHERE namespace = $1${query.memoryType ? " AND memory_type = $2" : ""}`,
      query.memoryType ? [namespace, query.memoryType] : [namespace],
    );
    return filterRecords(rows.map(rowToRecord), query);
  }

  async count(): Promise<number> {
    const { rows } = await this.pool.query(`SELECT COUNT(*) AS n FROM memories`);
    return Number(rows[0].n);
  }

  /** 为一条记忆写入/覆盖向量。pgvector 存在时写入 vector 列,否则 JSONB。 */
  async setEmbedding(id: string, vector: number[]): Promise<void> {
    if (this.hasVector) {
      await this.pool.query(`UPDATE memories SET embedding = $1::vector WHERE id = $2`, [
        `[${vector.join(",")}]`,
        id,
      ]);
    } else {
      await this.pool.query(`UPDATE memories SET embedding = $1::jsonb WHERE id = $2`, [
        JSON.stringify(vector),
        id,
      ]);
    }
  }

  /**
   * 语义检索:pgvector 存在时用原生 <=> 距离算子(可加索引加速),
   * 否则拉取向量后在内存中按 core 的 cosineTopK 排序。
   */
  async searchSemantic(query: VectorQuery): Promise<VectorHit[]> {
    const k = query.k ?? 10;
    const typeFilter = query.memoryType
      ? `WHERE memory_type = '${query.memoryType}' AND embedding IS NOT NULL`
      : `WHERE embedding IS NOT NULL`;

    if (this.hasVector) {
      const literal = `[${query.vector.join(",")}]`;
      const { rows } = await this.pool.query(
        `SELECT ${COLUMNS}, 1 - (embedding <=> $1::vector) AS score
         FROM memories ${typeFilter}
         ORDER BY embedding <=> $1::vector
         LIMIT ${k}`,
        [literal],
      );
      return rows.map((row: Record<string, unknown>) => ({
        record: rowToRecord(row),
        score: Number(row.score),
      }));
    }

    const { rows } = await this.pool.query(
      `SELECT ${COLUMNS}, embedding FROM memories ${typeFilter}`,
    );
    const candidates = rows
      .map((row: Record<string, unknown>) => {
        let emb: unknown = row.embedding;
        if (typeof emb === "string") emb = JSON.parse(emb);
        return { record: rowToRecord(row), embedding: emb as number[] };
      })
      .filter((c: { embedding: unknown }) => Array.isArray(c.embedding));
    return cosineTopK(candidates, query.vector, k);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

// 本包被 import 时自注册,-b pg 即可用
registerBackend("pg", (cs) => PgStore.connect(cs));

/** 把 pg 后端注册进 memcore 后端注册表(CLI/MCP 即可用 -b pg)。 */
export function register(): void {
  registerBackend("pg", (cs) => PgStore.connect(cs));
}
