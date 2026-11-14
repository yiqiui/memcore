import type { MemoryRecord } from "./types.js";

/** 策略抽象:与存储解耦。score 是排序/晋升/淘汰的唯一依据。 */
export interface MemoryStrategy {
  score(record: MemoryRecord, now: number): number;
}

/** 指数时间衰减:score = max(importance * 0.5^(age / halfLifeSecs), floor) */
export class TimeDecayStrategy implements MemoryStrategy {
  constructor(
    public halfLifeSecs: number = 7 * 86400,
    public floor: number = 0.01,
  ) {}

  score(record: MemoryRecord, now: number): number {
    const age = Math.max(0, now - record.lastAccessedAt);
    const decay = Math.pow(0.5, age / this.halfLifeSecs);
    return Math.max(record.importance * decay, this.floor);
  }
}

/** 访问频率:ln(1 + accessCount) * weight,鼓励被频繁读取的记忆。 */
export class AccessFrequencyStrategy implements MemoryStrategy {
  constructor(public weight: number = 0.2) {}

  score(record: MemoryRecord, _now: number): number {
    return Math.log1p(record.accessCount) * this.weight;
  }
}

/** 组合策略:各子策略分数求和。 */
export class CompositeStrategy implements MemoryStrategy {
  constructor(public strategies: MemoryStrategy[]) {}

  score(record: MemoryRecord, now: number): number {
    return this.strategies.reduce((sum, s) => sum + s.score(record, now), 0);
  }
}
