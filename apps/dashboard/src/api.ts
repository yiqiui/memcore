export interface MemoryRecordDto {
  id: string;
  content: string;
  memoryType: string;
  createdAt: number;
  lastAccessedAt: number;
  accessCount: number;
  importance: number;
  metadata: Record<string, unknown>;
  score?: number;
}

export interface StatsDto {
  total: number;
  byType: Record<string, number>;
  vector: boolean;
}

export interface ConfigDto {
  backend: string;
  dbPath: string;
  vector: boolean;
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init);
  if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
  return res.json() as Promise<T>;
}

export const api = {
  config: () => req<ConfigDto>("/api/config"),
  stats: () => req<StatsDto>("/api/stats"),
  records: (q?: string, type?: string) =>
    req<MemoryRecordDto[]>(
      `/api/records?${new URLSearchParams({ ...(q ? { q } : {}), ...(type ? { type } : {}) })}`,
    ),
  add: (content: string, type: string, importance?: number) =>
    req<MemoryRecordDto>("/api/records", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content, type, importance }),
    }),
  remove: (id: string) => req<{ deleted: string }>(`/api/records/${id}`, { method: "DELETE" }),
  setImportance: (id: string, importance: number) =>
    req<MemoryRecordDto>(`/api/records/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ importance }),
    }),
  touch: (id: string) => req<{ ok: boolean }>(`/api/records/${id}/access`, { method: "POST" }),
  top: (limit: number) => req<MemoryRecordDto[]>(`/api/top?limit=${limit}`),
  semantic: (query: string, k = 10) =>
    req<MemoryRecordDto[]>("/api/semantic", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query, k }),
    }),
};
