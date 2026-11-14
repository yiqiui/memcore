import { DEFAULT_NAMESPACE, type MemoryRecord, type MemoryType, type SearchQuery } from "./types.js";
import { cosineTopK, type VectorHit, type VectorQuery } from "./vector.js";

/** 查询分区键:undefined 视为 "default"。 */
export function ns(query?: { namespace?: string }): string {
  return query?.namespace ?? DEFAULT_NAMESPACE;
}

export class StoreError extends Error {}

/** 统一的 list 过滤实现;各后端可下推到 SQL/谓词,但行为必须与这里一致。 */
export function filterRecords(
  records: MemoryRecord[],
  query: SearchQuery,
): MemoryRecord[] {
  const namespace = ns(query);
  let out = records.filter(
    (r) => (r.namespace ?? DEFAULT_NAMESPACE) === namespace,
  );
  if (query.memoryType) {
    const t = query.memoryType;
    out = out.filter((r) => r.memoryType === t);
  }
  if (query.text) {
    const lower = query.text.toLowerCase();
    out = out.filter((r) => r.content.toLowerCase().includes(lower));
  }
  if (query.limit !== undefined) {
    out = out.slice(0, query.limit);
  }
  return out;
}

/**
 * 存储无关的核心抽象:内存 / 文件 / SQLite / LanceDB / pgvector 后端实现同一接口。
 * 全异步:同步后端(SQLite/文件)直接返回值,远程后端(pg/LanceDB)天然适配。
 */
export interface MemoryStore {
  insert(record: MemoryRecord): Promise<void>;
  get(id: string): Promise<MemoryRecord | undefined>;
  updateAccess(id: string, now: number): Promise<void>;
  delete(id: string): Promise<void>;
  list(query: SearchQuery): Promise<MemoryRecord[]>;
  count(): Promise<number>;
}

/** 内存后端,仅用于测试与策略验证,不作为生产存储。 */
export class InMemoryStore implements MemoryStore {
  private inner = new Map<string, MemoryRecord>();
  private embeddings = new Map<string, number[]>();

  async insert(record: MemoryRecord): Promise<void> {
    this.inner.set(record.id, { ...record });
  }

  async get(id: string): Promise<MemoryRecord | undefined> {
    const r = this.inner.get(id);
    return r ? { ...r } : undefined;
  }

  async updateAccess(id: string, now: number): Promise<void> {
    const r = this.inner.get(id);
    if (r) {
      r.lastAccessedAt = now;
      r.accessCount += 1;
    }
  }

  async delete(id: string): Promise<void> {
    this.inner.delete(id);
  }

  async list(query: SearchQuery): Promise<MemoryRecord[]> {
    return filterRecords([...this.inner.values()], query);
  }

  async count(): Promise<number> {
    return this.inner.size;
  }

  async setEmbedding(id: string, vector: number[]): Promise<void> {
    if (!this.inner.has(id)) throw new StoreError(`not found: ${id}`);
    this.embeddings.set(id, vector);
  }

  async searchSemantic(query: VectorQuery): Promise<VectorHit[]> {
    const candidates: { record: MemoryRecord; embedding: number[] }[] = [];
    for (const [id, vec] of this.embeddings) {
      const record = this.inner.get(id);
      if (!record) continue;
      if (query.memoryType && record.memoryType !== query.memoryType) continue;
      candidates.push({ record, embedding: vec });
    }
    return cosineTopK(candidates, query.vector, query.k ?? 10);
  }
}

export type { MemoryType };
