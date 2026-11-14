import { randomUUID } from "node:crypto";

export type MemoryType = "episodic" | "fact" | "semantic" | "procedural";

export const MEMORY_TYPES: readonly MemoryType[] = [
  "episodic",
  "fact",
  "semantic",
  "procedural",
];

export interface MemoryRecord {
  id: string;
  content: string;
  memoryType: MemoryType;
  /** 租户分区键,严格分区无继承;默认 "default"。约定命名:"user:alice"、"proj:x/user:alice"。 */
  namespace: string;
  /** 过期时间(unix 秒)。undefined = 永不过期;过期记录默认从所有查询中排除。 */
  expirationAt?: number;
  createdAt: number;
  lastAccessedAt: number;
  accessCount: number;
  importance: number;
  metadata: Record<string, unknown>;
}

export const DEFAULT_NAMESPACE = "default";

export function newRecord(
  content: string,
  memoryType: MemoryType,
  now: number,
  opts?: { namespace?: string },
): MemoryRecord {
  return {
    id: randomUUID(),
    content,
    memoryType,
    namespace: opts?.namespace ?? DEFAULT_NAMESPACE,
    createdAt: now,
    lastAccessedAt: now,
    accessCount: 0,
    importance: 0.5,
    metadata: {},
  };
}

export interface SearchQuery {
  text?: string;
  memoryType?: MemoryType;
  /** 分区;undefined 视为 "default",不跨区查询。 */
  namespace?: string;
  /** true 时包含已过期记录(默认排除)。 */
  includeExpired?: boolean;
  limit?: number;
}
