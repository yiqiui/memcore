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
  SimilarityConflictResolver,
  TimeDecayStrategy,
  TrigramEmbedder,
  cosineTopK,
  newRecord,
  openStore,
  rankByStrategy,
  resolveAndInsert,
  supportsVectorSearch,
} from "@memcore/core";
import type { MemoryStore } from "@memcore/core";
import type { EmbeddingFn, MemoryType } from "@memcore/core";

const MEMORY_TYPES = ["episodic", "fact", "semantic", "procedural"] as const;

/** 默认组合策略:时间衰减 + 访问频率。 */
function defaultStrategy() {
  return new CompositeStrategy([
    new TimeDecayStrategy(),
    new AccessFrequencyStrategy(),
  ]);
}

export function createServer(store: MemoryStore, embedFn?: EmbeddingFn) {
  const server = new McpServer({ name: "memcore", version: "0.1.0" });

  server.tool(
    "add_memory",
    "写入一条记忆(自动做同类型冲突消解)",
    {
      content: z.string().describe("记忆内容"),
      type: z.enum(MEMORY_TYPES).describe("记忆类型"),
      importance: z.number().min(0).max(1).optional().describe("重要性 0-1,默认 0.5"),
    },
    async ({ content, type, importance }) => {
      const now = Math.floor(Date.now() / 1000);
      const rec = newRecord(content, type as MemoryType, now);
      if (importance !== undefined) rec.importance = importance;
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
    "按关键词/类型检索记忆",
    {
      query: z.string().optional().describe("关键词(可选)"),
      type: z.enum(MEMORY_TYPES).optional().describe("按类型过滤(可选)"),
      limit: z.number().int().min(1).max(50).optional().describe("返回条数上限,默认 10"),
    },
    async ({ query, type, limit }) => {
      const results = await store.list({
        text: query,
        memoryType: type as MemoryType | undefined,
        limit: limit ?? 10,
      });
      return {
        content: [{ type: "text" as const, text: JSON.stringify(results) }],
      };
    },
  );

  server.tool(
    "rank_memory",
    "按策略(时间衰减+访问频率)对记忆排序,返回最值得注入上下文的 Top-K",
    {
      limit: z.number().int().min(1).max(50).optional().describe("返回条数上限,默认 10"),
    },
    async ({ limit }) => {
      const all = await store.list({});
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
    },
    async ({ query, k, type }) => {
      // 按需嵌入:对(过滤后的)全部记录现场计算向量并余弦排序。
      // 任何后端可用;记录量大或需要 ANN 加速时,改用后端的
      // VectorSearchable( LanceDB 原生 / pgvector <=> ) + setEmbedding 预存向量。
      const records = await store.list({
        memoryType: type as MemoryType | undefined,
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

  server.tool("memory_stats", "返回记忆库统计信息", {}, async () => {
    const byType: Record<string, number> = {};
    for (const t of MEMORY_TYPES) {
      byType[t] = (await store.list({ memoryType: t })).length;
    }
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({ total: await store.count(), byType }),
        },
      ],
    };
  });

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

  const server = createServer(store, embedFn);
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
