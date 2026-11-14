import type { MemoryRecord } from "./types.js";

/** 冲突消解抽象:同类型相似内容的新写入,合并、覆盖还是共存,做成可插拔策略。 */
export interface ConflictResolver {
  /** 返回合并后的记录表示替换旧记录;null 表示共存。可异步(嵌入判定需要)。 */
  resolve(incoming: MemoryRecord, existing: MemoryRecord, now: number): Promise<MemoryRecord | null>;
}

/** 最近写入优先:同类型且内容一致时覆盖,累加访问计数,保留首次出现时间。 */
export class LastWriteWins implements ConflictResolver {
  async resolve(incoming: MemoryRecord, existing: MemoryRecord, now: number): Promise<MemoryRecord | null> {
    if (existing.memoryType !== incoming.memoryType) return null;
    if (existing.content.trim().toLowerCase() !== incoming.content.trim().toLowerCase()) {
      return null;
    }
    return {
      ...incoming,
      accessCount: existing.accessCount + 1,
      createdAt: existing.createdAt,
      lastAccessedAt: now,
    };
  }
}

/** 重要性晋升:同类型且内容一致时合并,重要性取 max,访问计数累加。 */
export class ImportanceMerge implements ConflictResolver {
  async resolve(incoming: MemoryRecord, existing: MemoryRecord, now: number): Promise<MemoryRecord | null> {
    if (existing.memoryType !== incoming.memoryType) return null;
    if (existing.content.trim().toLowerCase() !== incoming.content.trim().toLowerCase()) {
      return null;
    }
    return {
      ...existing,
      importance: Math.max(existing.importance, incoming.importance),
      accessCount: existing.accessCount + 1,
      lastAccessedAt: now,
    };
  }
}

export type Resolution =
  | { kind: "resolved"; merged: MemoryRecord; oldId: string; oldRecord: MemoryRecord }
  | { kind: "no-conflict"; record: MemoryRecord };

export async function resolveAgainst(
  incoming: MemoryRecord,
  existing: MemoryRecord[],
  resolver: ConflictResolver,
  now: number,
): Promise<Resolution> {
  for (const old of existing) {
    if (old.memoryType !== incoming.memoryType) continue;
    const merged = await resolver.resolve(incoming, old, now);
    if (merged) return { kind: "resolved", merged, oldId: old.id, oldRecord: old };
  }
  return { kind: "no-conflict", record: incoming };
}
