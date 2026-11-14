#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import path from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  AccessFrequencyStrategy,
  CompositeStrategy,
  LastWriteWins,
  RrfFusion,
  SimilarityConflictResolver,
  TimeDecayStrategy,
  TrigramEmbedder,
  cosineTopK,
  newRecord,
  openStore,
  rankByStrategy,
  resolveAndInsert,
  searchFullText,
  searchHybrid,
  supportsVectorSearch,
} from "@memcore/core";
import type { MemoryStore } from "@memcore/core";
import type { EmbeddingFn, MemoryType } from "@memcore/core";

const MEMORY_TYPES = ["episodic", "fact", "semantic", "procedural"] as const;

function nsOf(params: { namespace?: string }, serverDefault?: string): string | undefined {
  return params.namespace ?? serverDefault;
}

/** 默认组合策略:时间衰减 + 访问频率。 */
function defaultStrategy() {
  return new CompositeStrategy([
    new TimeDecayStrategy(),
    new AccessFrequencyStrategy(),
  ]);
}

export function createServer(
  store: MemoryStore,
  embedFn?: EmbeddingFn,
  opts?: { defaultNamespace?: string },
) {
  const server = new McpServer({ name: "memcore", version: "0.1.0" });

  server.tool(
    "add_memory",
    "写入一条记忆(自动做同类型冲突消解)",
    {
      content: z.string().describe("记忆内容"),
      type: z.enum(MEMORY_TYPES).describe("记忆类型"),
      importance: z.number().min(0).max(1).optional().describe("重要性 0-1,默认 0.5"),
      ttl_seconds: z.number().int().min(1).optional().describe("过期秒数(可选);过期后所有查询默认排除"),
      namespace: z.string().optional().describe("租户分区,默认 default / MEMCORE_NAMESPACE"),
    },
    async ({ content, type, importance, ttl_seconds: ttlSeconds, namespace }) => {
      const now = Math.floor(Date.now() / 1000);
      const rec = newRecord(content, type as MemoryType, now, {
        namespace: nsOf({ namespace }, opts?.defaultNamespace),
      });
      if (importance !== undefined) rec.importance = importance;
      if (ttlSeconds !== undefined) rec.expirationAt = now + ttlSeconds;
      const stored = await resolveAndInsert(store, rec, resolver, now);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              id: stored.id,
              type: stored.memoryType,
              merged: stored.accessCount > 0,
              content: stored.content,
            }),
          },
        ],
      };
    },
  );

  server.tool(
    "search_memory",
    "检索记忆:keyword(BM25 全文) / semantic(嵌入) / hybrid(双路融合,默认)",
    {
      query: z.string().optional().describe("关键词(可选)"),
      type: z.enum(MEMORY_TYPES).optional().describe("按类型过滤(可选)"),
      mode: z.enum(["keyword", "semantic", "hybrid"]).optional().describe("检索模式,默认 hybrid"),
      limit: z.number().int().min(1).max(50).optional().describe("返回条数上限,默认 10"),
      namespace: z.string().optional().describe("租户分区,默认 default / MEMCORE_NAMESPACE"),
    },
    async ({ query, type, mode, limit, namespace }) => {
      const n = nsOf({ namespace }, opts?.defaultNamespace);
      const scope = { namespace: n, memoryType: type as MemoryType | undefined };
      let results: unknown[];
      if (mode === "keyword") {
        results = query
          ? await searchFullText(store, { text: query, ...scope, limit: limit ?? 10 })
          : await store.list({ ...scope, limit: limit ?? 10 });
      } else if (mode === "semantic") {
        if (!query) {
          results = await store.list({ ...scope, limit: limit ?? 10 });
        } else {
          const vector = await embed(query);
          if (supportsVectorSearch(store)) {
            results = await store.searchSemantic({ vector, ...scope, k: limit ?? 10 });
          } else {
            const records = await store.list(scope);
            const vectors = await Promise.all(records.map((r) => embed(r.content)));
            results = cosineTopK(
              records.map((record, i) => ({ record, embedding: vectors[i] })),
              vector,
              limit ?? 10,
            );
          }
        }
      } else {
        results = query
          ? await searchHybrid(store, {
              query,
              ...scope,
              limit: limit ?? 10,
              embedFn: embed,
            })
          : await store.list({ ...scope, limit: limit ?? 10 });
      }
      // 统一拍平:{record, score, signals} → record + score 字段
      const flat = (results as { record?: unknown; score?: number }[]).map((h) =>
        "record" in h ? { ...(h.record as object), score: h.score } : h,
      );
      return {
        content: [{ type: "text" as const, text: JSON.stringify(flat) }],
      };
    },
  );

  server.tool(
    "rank_memory",
    "按策略(时间衰减+访问频率)对记忆排序,返回最值得注入上下文的 Top-K",
    {
      limit: z.number().int().min(1).max(50).optional().describe("返回条数上限,默认 10"),
      namespace: z.string().optional().describe("租户分区,默认 default / MEMCORE_NAMESPACE"),
    },
    async ({ limit, namespace }) => {
      const all = await store.list({ namespace: nsOf({ namespace }, opts?.defaultNamespace) });
      const ranked = rankByStrategy(all, defaultStrategy(), Math.floor(Date.now() / 1000));
      const top = ranked.slice(0, limit ?? 10).map((r) => ({
        ...r.record,
        score: r.score,
      }));
      return { content: [{ type: "text" as const, text: JSON.stringify(top) }] };
    },
  );

  const embed =
    embedFn ?? new TrigramEmbedder().embed.bind(new TrigramEmbedder());
  // 提供嵌入时,写入冲突消解升级为语义判定;否则保持零依赖的精确匹配
  const resolver = embedFn
    ? new SimilarityConflictResolver(embedFn, 0.9)
    : new LastWriteWins();

  server.tool(
    "search_semantic",
    "语义检索:按与查询文本的嵌入相似度返回 Top-K(需后端支持向量检索,嵌入默认用零依赖的字符三元组模型)",
    {
      query: z.string().describe("查询文本"),
      k: z.number().int().min(1).max(50).optional().describe("返回条数,默认 10"),
      type: z.enum(MEMORY_TYPES).optional().describe("按类型过滤(可选)"),
      namespace: z.string().optional().describe("租户分区,默认 default / MEMCORE_NAMESPACE"),
    },
    async ({ query, k, type, namespace }) => {
      // 按需嵌入:对(过滤后的)全部记录现场计算向量并余弦排序。
      // 任何后端可用;记录量大或需要 ANN 加速时,改用后端的
      // VectorSearchable( LanceDB 原生 / pgvector <=> ) + setEmbedding 预存向量。
      const records = await store.list({
        memoryType: type as MemoryType | undefined,
        namespace: nsOf({ namespace }, opts?.defaultNamespace),
      });
      const vectors = await Promise.all(records.map((r) => embed(r.content)));
      const queryVec = await embed(query);
      const hits = cosineTopK(
        records.map((record, i) => ({ record, embedding: vectors[i] })),
        queryVec,
        k ?? 10,
      );
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              hits.map((h) => ({ ...h.record, score: h.score })),
            ),
          },
        ],
      };
    },
  );

  server.tool(
    "memory_history",
    "查询记忆变更历史(合并替换/删除时的旧记录快照;仅 SQLite 后端支持)",
    {
      limit: z.number().int().min(1).max(200).optional().describe("返回条数,默认 50"),
      namespace: z.string().optional().describe("租户分区,默认 default / MEMCORE_NAMESPACE"),
    },
    async ({ limit, namespace }) => {
      if (!("listHistory" in store)) {
        return {
          content: [
            { type: "text" as const, text: JSON.stringify({ error: "current backend has no history support (use sqlite)" }) },
          ],
        };
      }
      const entries = await (
        store as { listHistory(q?: object): Promise<unknown[]> }
      ).listHistory({ namespace: nsOf({ namespace }, opts?.defaultNamespace), limit: limit ?? 50 });
      return {
        content: [{ type: "text" as const, text: JSON.stringify(entries) }],
      };
    },
  );

  server.tool(
    "memory_stats",
    "返回记忆库统计信息",
    {
      namespace: z.string().optional().describe("租户分区,默认 default / MEMCORE_NAMESPACE"),
    },
    async ({ namespace }) => {
      const n = nsOf({ namespace }, opts?.defaultNamespace);
      const byType: Record<string, number> = {};
      let total = 0;
      for (const t of MEMORY_TYPES) {
        const c = (await store.list({ memoryType: t, namespace: n })).length;
        byType[t] = c;
        total += c;
      }
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ namespace: n, total, byType }) }],
      };
    },
  );

  return server;
}

/** CLI 入口:MEMCORE_DB 指定路径,MEMCORE_BACKEND 指定后端(见 core 的 openStore 解析规则)。 */
async function main() {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? ".";
  const dbPath = process.env.MEMCORE_DB ?? `${home}/.memcore/mem.db`;
  const backend = process.env.MEMCORE_BACKEND ?? "sqlite";
  const store = await openStore(backend, dbPath);

  // MEMCORE_EMBED=local 时用本地 ONNX 模型(需安装 @memcore/embed-local),否则零依赖三元组嵌入
  let embedFn: EmbeddingFn | undefined;
  if (process.env.MEMCORE_EMBED === "local") {
    const { localEmbed } = await import("@memcore/embed-local");
    embedFn = localEmbed();
  }

  const server = createServer(store, embedFn, {
    defaultNamespace: process.env.MEMCORE_NAMESPACE,
  });
  await server.connect(new StdioServerTransport());
}

// 仅直接执行本文件时启动 stdio,被导入(测试)时不启动
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
