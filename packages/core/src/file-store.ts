import { readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { filterRecords } from "./store.js";
import type { MemoryStore } from "./store.js";
import type { MemoryRecord, MemoryType, SearchQuery } from "./types.js";
import { MEMORY_TYPES } from "./types.js";

function rowToRecord(row: Record<string, unknown>): MemoryRecord {
  const t = row.memoryType as string;
  return {
    id: row.id as string,
    content: row.content as string,
    memoryType: (MEMORY_TYPES as readonly string[]).includes(t)
      ? (t as MemoryType)
      : "fact",
    createdAt: row.createdAt as number,
    lastAccessedAt: row.lastAccessedAt as number,
    accessCount: row.accessCount as number,
    importance: row.importance as number,
    metadata: (row.metadata ?? {}) as Record<string, unknown>,
  };
}

/** 纯文件 JSON 后端:单文件、零依赖、可直接用 git 管理。原子写入(写临时文件 + rename)。 */
export class FileStore implements MemoryStore {
  private records = new Map<string, MemoryRecord>();
  private loaded = false;

  constructor(private filePath: string) {
    mkdirSync(dirname(filePath), { recursive: true });
  }

  private ensureLoaded(): void {
    if (this.loaded) return;
    try {
      const raw = JSON.parse(readFileSync(this.filePath, "utf-8")) as {
        records?: Record<string, unknown>[];
      };
      for (const row of raw.records ?? []) {
        const rec = rowToRecord(row);
        this.records.set(rec.id, rec);
      }
    } catch {
      // 文件不存在或损坏:从空库开始
    }
    this.loaded = true;
  }

  private persist(): void {
    const tmp = `${this.filePath}.tmp`;
    writeFileSync(
      tmp,
      JSON.stringify({ version: 1, records: [...this.records.values()] }, null, 2),
      "utf-8",
    );
    renameSync(tmp, this.filePath);
  }

  async insert(record: MemoryRecord): Promise<void> {
    this.ensureLoaded();
    this.records.set(record.id, { ...record });
    this.persist();
  }

  async get(id: string): Promise<MemoryRecord | undefined> {
    this.ensureLoaded();
    const r = this.records.get(id);
    return r ? { ...r } : undefined;
  }

  async updateAccess(id: string, now: number): Promise<void> {
    this.ensureLoaded();
    const r = this.records.get(id);
    if (r) {
      r.lastAccessedAt = now;
      r.accessCount += 1;
      this.persist();
    }
  }

  async delete(id: string): Promise<void> {
    this.ensureLoaded();
    if (this.records.delete(id)) this.persist();
  }

  async list(query: SearchQuery): Promise<MemoryRecord[]> {
    this.ensureLoaded();
    return filterRecords([...this.records.values()], query);
  }

  async count(): Promise<number> {
    this.ensureLoaded();
    return this.records.size;
  }
}
