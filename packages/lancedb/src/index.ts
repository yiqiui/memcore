import * as lancedb from "@lancedb/lancedb";
import {
  MEMORY_TYPES,
  cosineTopK,
  filterRecords,
  newRecord,
  registerBackend,
  type MemoryRecord,
  type MemoryStore,
  type MemoryType,
  type SearchQuery,
  type VectorHit,
  type VectorQuery,
} from "@memcore/core";

/** LanceDB 行结构:metadata 序列化为字符串,保证 schema 稳定。 */
type LanceRow = {
  id: string;
  content: string;
  memory_type: string;
  /** 旧表迁移期可能为 null,读时按 "default" 归一 */
  namespace?: string | null;
  created_at: number;
  last_accessed_at: number;
  access_count: number;
  importance: number;
  metadata: string;
  embedding?: number[];
};

function toRow(rec: MemoryRecord): LanceRow {
  return {
    id: rec.id,
    content: rec.content,
    memory_type: rec.memoryType,
    namespace: rec.namespace ?? "default",
    created_at: rec.createdAt,
    last_accessed_at: rec.lastAccessedAt,
    access_count: rec.accessCount,
    importance: rec.importance,
    metadata: JSON.stringify(rec.metadata),
  };
}

function toRecord(row: Record<string, unknown>): MemoryRecord {
  const t = row.memory_type as string;
  const rawMeta = row.metadata as string;
  let meta: Record<string, unknown> = {};
  try {
    meta = JSON.parse(rawMeta ?? "{}");
  } catch {
    /* keep {} */
  }
  return {
    id: row.id as string,
    content: row.content as string,
    memoryType: (MEMORY_TYPES as readonly string[]).includes(t)
      ? (t as MemoryType)
      : "fact",
    namespace: (row.namespace as string) ?? "default",
    createdAt: row.created_at as number,
    lastAccessedAt: row.last_accessed_at as number,
    accessCount: row.access_count as number,
    importance: row.importance as number,
    metadata: meta,
  };
}

/**
 * LanceDB 后端(本地列式存储,向量列就绪)。
 * LanceDB 的更新是 delete + add 语义,此处封装为 MemoryStore 的行级操作。
 */
export class LanceDbStore implements MemoryStore {
  private constructor(private table: lancedb.Table) {}

  /** 打开(或创建)数据库与表。首行占位法建空表以固定 schema,建完即删。 */
  static async open(dir: string, tableName = "memories"): Promise<LanceDbStore> {
    const db = await lancedb.connect(dir);
    const names = await db.tableNames();
    if (!names.includes(tableName)) {
      const dummy = toRow(newRecord("__schema_seed__", "fact", 0));
      const table = await db.createTable(tableName, [dummy]);
      await table.delete(`id = '${dummy.id}'`);
      return new LanceDbStore(table);
    }
    const table = await db.openTable(tableName);
    // 0.1.0 → 0.2.0 迁移:补 namespace 列(旧行读时归一为 default)
    const schema = await table.schema();
    if (!schema.fields.some((f) => f.name === "namespace")) {
      await table.addColumns([
        { name: "namespace", valueSql: `'default'` },
      ]);
    }
    return new LanceDbStore(table);
  }

  async insert(record: MemoryRecord): Promise<void> {
    // 幂等:同 id 先删后写
    await this.table.delete(`id = '${record.id}'`);
    await this.table.add([toRow(record)]);
  }

  async get(id: string): Promise<MemoryRecord | undefined> {
    const rows = await this.table.query().where(`id = '${id}'`).limit(1).toArray();
    return rows.length > 0 ? toRecord(rows[0] as unknown as Record<string, unknown>) : undefined;
  }

  async updateAccess(id: string, now: number): Promise<void> {
    const rec = await this.get(id);
    if (!rec) return;
    await this.table.delete(`id = '${id}'`);
    await this.table.add([
      toRow({ ...rec, lastAccessedAt: now, accessCount: rec.accessCount + 1 }),
    ]);
  }

  async delete(id: string): Promise<void> {
    await this.table.delete(`id = '${id}'`);
  }

  async list(query: SearchQuery): Promise<MemoryRecord[]> {
    const total = await this.table.countRows();
    if (total === 0) return [];
    const predicate = `namespace IS NULL OR namespace = '${query.namespace ?? "default"}'`;
    const rows = await this.table
      .query()
      .where(predicate)
      .limit(total)
      .toArray();
    const records = rows.map((r) =>
      toRecord(r as unknown as Record<string, unknown>),
    );
    return filterRecords(records, query);
  }

  async count(): Promise<number> {
    return this.table.countRows();
  }

  /** 为一条记忆写入/覆盖向量,供语义检索。 */
  async setEmbedding(id: string, embedding: number[]): Promise<void> {
    const rec = await this.get(id);
    if (!rec) throw new Error(`not found: ${id}`);
    await this.table.delete(`id = '${id}'`);
    const row = toRow(rec) as LanceRow & { embedding: number[] };
    row.embedding = embedding;
    await this.table.add([row]);
  }

  /**
   * 语义检索:embedding 列存在且有向量时走 LanceDB 原生向量检索,
   * 否则回退到内存余弦排序(与 core 的 cosineTopK 同序)。
   */
  async searchSemantic(query: VectorQuery): Promise<VectorHit[]> {
    const schema = await this.table.schema();
    const hasEmbeddingCol = schema.fields.some((f) => f.name === "embedding");
    const total = await this.table.countRows();
    if (total === 0) return [];

    if (hasEmbeddingCol) {
      const hits = await this.table
        .search(query.vector)
        .limit(query.k ?? 10)
        .toArray();
      const results: VectorHit[] = [];
      let anyVector = false;
      for (const hit of hits) {
        const row = hit as unknown as Record<string, unknown>;
        const emb = row.embedding as number[] | null;
        if (emb !== null && emb !== undefined) anyVector = true;
        if (row.id === undefined || emb === null || emb === undefined) continue;
        const rec = toRecord(row);
        if (query.memoryType && rec.memoryType !== query.memoryType) continue;
        results.push({ record: rec, score: 1 });
      }
      if (anyVector && results.length > 0) return results.slice(0, query.k ?? 10);
    }

    // 回退:内存余弦(无向量列,或向量全空)
    const rows = await this.table.query().limit(Math.max(total, 1)).toArray();
    const candidates = rows
      .map((r) => {
        const row = r as unknown as LanceRow;
        return { record: toRecord(row), embedding: (row.embedding ?? null) as number[] | null };
      })
      .filter(
        (c): c is { record: MemoryRecord; embedding: number[] } =>
          c.embedding !== null &&
          (!query.memoryType || c.record.memoryType === query.memoryType),
      );
    return cosineTopK(candidates, query.vector, query.k ?? 10);
  }
}

// 本包被 import 时自注册,-b lancedb 即可用
registerBackend("lancedb", (dir) => LanceDbStore.open(dir));

/** 把 lancedb 后端注册进 memcore 后端注册表(CLI/MCP 即可用 -b lancedb)。 */
export function register(): void {
  registerBackend("lancedb", (dir) => LanceDbStore.open(dir));
}
