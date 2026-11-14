import type { ConflictResolver, Resolution } from "./conflict.js";
import { resolveAgainst } from "./conflict.js";
import type { MemoryRecord, MemoryType, SearchQuery } from "./types.js";
import { newRecord } from "./types.js";
import type { MemoryStore } from "./store.js";
import { InMemoryStore } from "./store.js";
import { SqliteStore } from "./sqlite-store.js";
import { FileStore } from "./file-store.js";
import type { MemoryStrategy } from "./strategy.js";
import { registerBackend } from "./registry.js";

/** 按策略分数对记忆降序排序,CLI / MCP 层直接消费。 */
export function rankByStrategy(
  records: MemoryRecord[],
  strategy: MemoryStrategy,
  now: number,
): { record: MemoryRecord; score: number }[] {
  return records
    .map((record) => ({ record, score: strategy.score(record, now) }))
    .sort((a, b) => b.score - a.score);
}

/** 写入即消解:查同类型候选 → 冲突消解 → 按结果合并或写入。 */
export async function resolveAndInsert(
  store: MemoryStore,
  incoming: MemoryRecord,
  resolver: ConflictResolver,
  now: number,
): Promise<MemoryRecord> {
  // 冲突消解只在分区内进行:同 namespace 下同类型同内容才判冲突
  const candidates = await store.list({
    memoryType: incoming.memoryType,
    namespace: incoming.namespace,
  });
  const res = await resolveAgainst(incoming, candidates, resolver, now);
  if (res.kind === "resolved") {
    await store.delete(res.oldId);
    await store.insert(res.merged);
    return res.merged;
  }
  await store.insert(res.record);
  return res.record;
}

export { LastWriteWins, ImportanceMerge, resolveAgainst } from "./conflict.js";
export type { ConflictResolver, Resolution } from "./conflict.js";
export {
  SimilarityConflictResolver,
  TrigramEmbedder,
  cosineSimilarity,
} from "./similarity.js";
export type { EmbeddingFn } from "./similarity.js";
export { InMemoryStore, filterRecords } from "./store.js";
export type { MemoryStore, StoreError } from "./store.js";
export { SqliteStore } from "./sqlite-store.js";
export { FileStore } from "./file-store.js";
export {
  registerBackend,
  listBackends,
  openStore,
} from "./registry.js";
export {
  cosineTopK,
  supportsVectorSearch,
} from "./vector.js";
export type { VectorSearchable, VectorQuery, VectorHit } from "./vector.js";
export {
  bm25TopK,
  defaultTokenizer,
  searchFullText,
} from "./fts.js";
export type { FullTextSearchable, FullTextQuery, FullTextHit, Tokenizer } from "./fts.js";
export { RrfFusion, WeightedFusion } from "./fusion.js";
export type { FusionStrategy, HybridHit, RetrievalPath, RetrievalPathKind } from "./fusion.js";
export { searchHybrid, memoizeEmbedder } from "./retrieval.js";
export type { HybridSearchOptions } from "./retrieval.js";
export { DEFAULT_NAMESPACE } from "./types.js";
export { ns } from "./store.js";
export type { BackendFactory } from "./registry.js";
export {
  TimeDecayStrategy,
  AccessFrequencyStrategy,
  CompositeStrategy,
} from "./strategy.js";
export type { MemoryStrategy } from "./strategy.js";
export { newRecord, MEMORY_TYPES } from "./types.js";
export type { MemoryRecord, MemoryType, SearchQuery } from "./types.js";

// 内嵌后端自注册(sqlite / file / memory)
registerBackend("memory", () => new InMemoryStore());
registerBackend("sqlite", (path) => new SqliteStore(path));
registerBackend("file", (path) =>
  new FileStore(path.endsWith(".json") ? path : `${path}.json`),
);
