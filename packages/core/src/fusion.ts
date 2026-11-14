import type { MemoryRecord } from "./types.js";

export interface HybridHit {
  record: MemoryRecord;
  /** 融合后的总分,越大越相关。 */
  score: number;
  /** 各检索路径的原始信号分,便于展示"这条为什么被召回"。 */
  signals: { bm25?: number; semantic?: number };
}

export type RetrievalPathKind = "bm25" | "semantic";

export interface RetrievalPath {
  kind: RetrievalPathKind;
  hits: { record: MemoryRecord; score: number }[];
}

/**
 * 融合策略:把多路检索结果合并成一个排序 —— 与衰减/冲突同级的三号可插拔点。
 * 市场空档:头部项目融合权重无一可完整配置。
 */
export interface FusionStrategy {
  fuse(paths: RetrievalPath[], limit: number): HybridHit[];
}

/**
 * Reciprocal Rank Fusion(k 默认 60):rank-based,免分数归一化,文献标准做法。
 * 默认融合策略。
 */
export class RrfFusion implements FusionStrategy {
  constructor(public k = 60) {}

  fuse(paths: RetrievalPath[], limit: number): HybridHit[] {
    const byId = new Map<string, { record: MemoryRecord; score: number; signals: HybridHit["signals"] }>();
    for (const path of paths) {
      path.hits.forEach((hit, rank) => {
        const entry = byId.get(hit.record.id) ?? {
          record: hit.record,
          score: 0,
          signals: {},
        };
        entry.score += 1 / (this.k + rank + 1);
        entry.signals[path.kind] = hit.score;
        byId.set(hit.record.id, entry);
      });
    }
    return [...byId.values()]
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }
}

/**
 * 加权线性融合:每路分数 min-max 归一化后加权求和。
 * 记录在某路缺席按 0 计;权重显式传入,不拍默认值(设计 §7.3)。
 */
export class WeightedFusion implements FusionStrategy {
  constructor(public weights: { bm25?: number; semantic?: number }) {}

  fuse(paths: RetrievalPath[], limit: number): HybridHit[] {
    const byId = new Map<string, { record: MemoryRecord; score: number; signals: HybridHit["signals"] }>();
    for (const path of paths) {
      if (path.hits.length === 0) continue;
      const scores = path.hits.map((h) => h.score);
      const min = Math.min(...scores);
      const max = Math.max(...scores);
      const span = max - min || 1;
      for (const hit of path.hits) {
        const entry = byId.get(hit.record.id) ?? {
          record: hit.record,
          score: 0,
          signals: {},
        };
        entry.score += (this.weights[path.kind] ?? 0) * ((hit.score - min) / span);
        entry.signals[path.kind] = hit.score;
        byId.set(hit.record.id, entry);
      }
    }
    return [...byId.values()]
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }
}
