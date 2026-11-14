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
  createdAt: number;
  lastAccessedAt: number;
  accessCount: number;
  importance: number;
  metadata: Record<string, unknown>;
}

export function newRecord(
  content: string,
  memoryType: MemoryType,
  now: number,
): MemoryRecord {
  return {
    id: randomUUID(),
    content,
    memoryType,
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
  limit?: number;
}
