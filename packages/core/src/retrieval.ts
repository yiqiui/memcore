import type { EmbeddingFn } from "./similarity.js";
import { cosineTopK, supportsVectorSearch, type VectorHit } from "./vector.js";
import { ns } from "./store.js";
import type { MemoryStore } from "./store.js";
import type { MemoryType } from "./types.js";
import { searchFullText, type Tokenizer } from "./fts.js";
import type { FusionStrategy, HybridHit, RetrievalPath } from "./fusion.js";
import { RrfFusion } from "./fusion.js";

/**
 * LRU 记忆化:包一层 EmbeddingFn,同一文本(常见于同一批记录被反复检索)
 * 不重复推理。零依赖,Map 实现。
 */
export function memoizeEmbedder(fn: EmbeddingFn, max = 1024): EmbeddingFn {
  const cache = new Map<string, Promise<number[]>>();
  return (text: string) => {
    let p = cache.get(text);
    if (!p) {
      p = Promise.resolve(fn(text));
      cache.set(text, p);
      if (cache.size > max) {
        const oldest = cache.keys().next().value;
        if (oldest !== undefined) cache.delete(oldest);
      }
    }
    return p;
  };
}

export interface HybridSearchOptions {
  query: string;
  namespace?: string;
  memoryType?: MemoryType;
  limit?: number;
  /** 提供 → 语义路径按需嵌入(任意后端可用,带 LRU 缓存) */
  embedFn?: EmbeddingFn;
  fusion?: FusionStrategy;
  tokenizer?: Tokenizer;
}

/**
 * 混合检索:BM25 关键词路 + 语义路 + FusionStrategy 融合。
 * - 关键词路:后端实现 FullTextSearchable(SQLite FTS5)用后端,否则 JS BM25 回退
 * - 语义路:提供 embedFn 才启用;后端支持向量(VectorSearchable)时用原生 searchSemantic,
 *   否则按需嵌入 + 内存余弦;两者都不满足则退化为纯 BM25(行为有定义)
 */
export async function searchHybrid(
  store: MemoryStore,
  opts: HybridSearchOptions,
): Promise<HybridHit[]> {
  const limit = opts.limit ?? 10;
  const scope = { namespace: opts.namespace, memoryType: opts.memoryType };
  const paths: RetrievalPath[] = [];

  // 关键词路
  paths.push({
    kind: "bm25",
    hits: await searchFullText(
      store,
      { text: opts.query, namespace: opts.namespace, memoryType: opts.memoryType, limit: Math.max(limit, 10) },
      opts.tokenizer,
    ),
  });

  // 语义路:优先原生向量检索;但预存向量可能为空(未 setEmbedding),此时回退按需嵌入
  if (opts.embedFn) {
    const embed = memoizeEmbedder(opts.embedFn);
    const queryVector = await embed(opts.query);
    let hits: VectorHit[] = [];
    if (supportsVectorSearch(store)) {
      hits = await store.searchSemantic({ vector: queryVector, ...scope, k: Math.max(limit, 10) });
    }
    if (hits.length === 0) {
      const records = await store.list(scope);
      const vectors = await Promise.all(records.map((r) => embed(r.content)));
      hits = cosineTopK(
        records.map((record, i) => ({ record, embedding: vectors[i] })),
        queryVector,
        Math.max(limit, 10),
      );
    }
    paths.push({ kind: "semantic", hits });
  }

  const fusion: FusionStrategy = opts.fusion ?? new RrfFusion();
  return fusion.fuse(paths, limit);
}
