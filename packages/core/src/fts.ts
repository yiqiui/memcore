import type { MemoryRecord, MemoryType } from "./types.js";
import type { MemoryStore } from "./store.js";

export interface FullTextHit {
  record: MemoryRecord;
  /** 越大越相关(BM25 已取负号统一方向)。 */
  score: number;
}

export interface FullTextQuery {
  text: string;
  namespace?: string;
  memoryType?: MemoryType;
  limit?: number;
}

/** 支持 BM25 全文检索的后端(SQLite FTS5)实现此能力接口。 */
export interface FullTextSearchable {
  searchFullText(query: FullTextQuery): FullTextHit[];
}

/** 分词器抽象:可注入 jieba 等专业分词,默认实现见 defaultTokenizer。 */
export type Tokenizer = (text: string) => string[];

const CJK = /[\u4e00-\u9fff\u3400-\u4dbf]/;

/** 默认分词:小写化 + 非字母数字切词 + CJK 双字组(单字保留)。确定性输出。 */
export function defaultTokenizer(text: string): string[] {
  const tokens: string[] = [];
  for (const raw of text.toLowerCase().split(/[^a-z0-9\u4e00-\u9fff\u3400-\u4dbf]+/)) {
    if (!raw) continue;
    if (CJK.test(raw)) {
      // CJK 段:双字组;单字段保留单字
      if (raw.length === 1) {
        tokens.push(raw);
        continue;
      }
      for (let i = 0; i + 2 <= raw.length; i++) tokens.push(raw.slice(i, i + 2));
    } else {
      tokens.push(raw);
    }
  }
  return tokens;
}

/**
 * 纯 TS BM25(k1=1.5, b=0.75),用于无 FTS 后端(File/InMemory)的回退路径。
 * 文档集由调用方给定(已按 namespace/type 过滤),idf 在该集合上计算 —— 语义
 * 与"对分区检索"一致,且完全确定。
 */
export function bm25TopK(
  records: MemoryRecord[],
  queryText: string,
  limit: number,
  tokenizer: Tokenizer = defaultTokenizer,
): FullTextHit[] {
  const k1 = 1.5;
  const b = 0.75;
  const docs = records.map((r) => tokenizer(r.content));
  const docCount = docs.length;
  if (docCount === 0) return [];
  const avgLen = docs.reduce((s, d) => s + d.length, 0) / docCount;

  // df 表
  const df = new Map<string, number>();
  for (const d of docs) {
    for (const t of new Set(d)) df.set(t, (df.get(t) ?? 0) + 1);
  }

  const queryTokens = [...new Set(tokenizer(queryText))];
  const hits: FullTextHit[] = [];
  for (let i = 0; i < docCount; i++) {
    const d = docs[i];
    if (d.length === 0) continue;
    const tf = new Map<string, number>();
    for (const t of d) tf.set(t, (tf.get(t) ?? 0) + 1);
    let score = 0;
    for (const t of queryTokens) {
      const f = tf.get(t);
      if (!f) continue;
      const idf = Math.log(1 + (docCount - (df.get(t) ?? 0) + 0.5) / ((df.get(t) ?? 0) + 0.5));
      score +=
        idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * d.length) / (avgLen || 1))));
    }
    if (score > 0) hits.push({ record: records[i], score });
  }
  hits.sort((a, b) => b.score - a.score);
  return hits.slice(0, limit);
}

/** 统一入口:后端有 FTS 用后端,否则 JS 回退。 */
export async function searchFullText(
  store: MemoryStore,
  query: FullTextQuery,
  tokenizer?: Tokenizer,
): Promise<FullTextHit[]> {
  if ("searchFullText" in store && typeof store.searchFullText === "function") {
    return store.searchFullText(query);
  }
  const records = await store.list({
    namespace: query.namespace,
    memoryType: query.memoryType,
  });
  return bm25TopK(records, query.text, query.limit ?? 10, tokenizer);
}
