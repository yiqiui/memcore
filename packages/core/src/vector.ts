import type { MemoryRecord, MemoryType } from "./types.js";
import type { MemoryStore } from "./store.js";
import { cosineSimilarity } from "./similarity.js";

export interface VectorQuery {
  /** 查询向量(与写入时 setEmbedding 用同一嵌入来源)。 */
  vector: number[];
  k?: number;
  memoryType?: MemoryType;
}

export interface VectorHit {
  record: MemoryRecord;
  score: number;
}

/**
 * 语义检索能力接口:支持向量的后端(LanceDB / pg / 内存)实现它。
 * 通过 supportsVectorSearch(store) 探测,调用方不感知后端差异。
 */
export interface VectorSearchable {
  /** 为已有记忆写入/覆盖向量。 */
  setEmbedding(id: string, vector: number[]): Promise<void>;
  /** 语义检索:按与查询向量的相似度降序返回 Top-K。 */
  searchSemantic(query: VectorQuery): Promise<VectorHit[]>;
}

export function supportsVectorSearch(store: MemoryStore): store is MemoryStore & VectorSearchable {
  return "searchSemantic" in store && "setEmbedding" in store;
}

/**
 * 内存中的余弦 Top-K:各后端在无原生 ANN 能力时的统一回退实现,
 * 也是语义排序的参考实现(原生实现的排序必须与此一致)。
 */
export function cosineTopK(
  candidates: { record: MemoryRecord; embedding: number[] }[],
  vector: number[],
  k: number,
): VectorHit[] {
  return candidates
    .map(({ record, embedding }) => ({ record, score: cosineSimilarity(vector, embedding) }))
    .filter((h) => h.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
}
