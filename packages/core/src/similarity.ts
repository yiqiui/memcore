import type { ConflictResolver } from "./conflict.js";
import type { MemoryRecord } from "./types.js";

/** 嵌入函数抽象:接入任意嵌入来源(本地 ONNX 模型 / API / 零依赖 TrigramEmbedder)。 */
export type EmbeddingFn = (text: string) => number[] | Promise<number[]>;

const DIM = 128;

/** 零依赖、确定性的字符三元组哈希嵌入器:适合近似重复检测,语义判别请换真实嵌入模型。 */
export class TrigramEmbedder {
  embed(text: string): number[] {
    const s = `  ${text.toLowerCase().trim()} `;
    const vec = new Array<number>(DIM).fill(0);
    for (let i = 0; i + 3 <= s.length; i++) {
      const gram = s.slice(i, i + 3);
      let h = 5381;
      for (const ch of gram) h = ((h * 33) ^ ch.charCodeAt(0)) >>> 0;
      vec[h % DIM] += 1;
    }
    const norm = Math.sqrt(vec.reduce((sum, v) => sum + v * v, 0)) || 1;
    return vec.map((v) => v / norm);
  }
}

export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * 嵌入相似度冲突消解:同类型且 cos 相似度 ≥ threshold 时判定为"同一件事",合并。
 * embedFn 用户自选:本地 transformers.js 模型 / OpenAI API / 内置 TrigramEmbedder。
 * 语义上"低相似但措辞不同"的记忆保持共存 —— 这是 mem0 等方案未收敛的判定点。
 */
export class SimilarityConflictResolver implements ConflictResolver {
  constructor(
    private embedFn: EmbeddingFn = new TrigramEmbedder().embed.bind(new TrigramEmbedder()),
    public threshold = 0.92,
  ) {}

  async resolve(incoming: MemoryRecord, existing: MemoryRecord, now: number): Promise<MemoryRecord | null> {
    if (existing.memoryType !== incoming.memoryType) return null;
    const [a, b] = await Promise.all([
      this.embedFn(incoming.content),
      this.embedFn(existing.content),
    ]);
    if (cosineSimilarity(a, b) < this.threshold) return null;
    return {
      ...incoming,
      accessCount: existing.accessCount + 1,
      createdAt: existing.createdAt,
      lastAccessedAt: now,
    };
  }
}
