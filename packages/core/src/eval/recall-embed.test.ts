/**
 * 真实嵌入版召回测试(需要下载/缓存模型,门控):
 *   MEMCORE_TEST_EMBED=1 npm test -w @memcore/core
 * 首次运行会下载 ~23MB 模型( Xenova/all-MiniLM-L6-v2, q8 量化 ),之后离线。
 * 与 recall.test.ts(零依赖三元组嵌入)互补:验证策略内核在真实语义模型下的表现。
 */
import { describe, expect, it } from "vitest";
import {
  InMemoryStore,
  SimilarityConflictResolver,
  newRecord,
  resolveAndInsert,
} from "../index.js";

const d = process.env.MEMCORE_TEST_EMBED ? describe : describe.skip;

d("真实嵌入召回(ALL-MiniLM-L6-v2 q8)", () => {
  it("语义近似改写被判定为同一件事(阈值 0.9)", async () => {
    const { localEmbed } = await import("@memcore/embed-local");
    const embed = localEmbed();
    const store = new InMemoryStore();
    const resolver = new SimilarityConflictResolver(embed, 0.9);
    await store.insert(newRecord("tests must run before pushing", "procedural", 100));
    const merged = await resolveAndInsert(
      store,
      newRecord("run tests before pushing", "procedural", 200),
      resolver,
      300,
    );
    expect(await store.count()).toBe(1);
    expect(merged.createdAt).toBe(100); // 保留首次出现时间
  });

  it("语义无关的记忆共存(不误杀)", async () => {
    const { localEmbed } = await import("@memcore/embed-local");
    const embed = localEmbed();
    const store = new InMemoryStore();
    const resolver = new SimilarityConflictResolver(embed, 0.9);
    await store.insert(newRecord("tests must run before pushing", "procedural", 100));
    await resolveAndInsert(
      store,
      newRecord("deploy to production on friday", "procedural", 200),
      resolver,
      300,
    );
    expect(await store.count()).toBe(2);
  });

  it("语义检索排序:查询改写句,最相关记忆排第一", async () => {
    const { localEmbed } = await import("@memcore/embed-local");
    const embed = localEmbed();
    const store = new InMemoryStore();
    const docs = [
      "user prefers dark mode",
      "deploy to production on friday",
      "kubernetes rollout restart procedure",
    ];
    for (const content of docs) {
      const rec = newRecord(content, "fact", 100);
      await store.insert(rec);
      await store.setEmbedding(rec.id, await embed(content));
    }
    const hits = await store.searchSemantic({
      vector: await embed("dark theme preference of the user"),
      k: 3,
    });
    expect(hits[0].record.content).toBe("user prefers dark mode");
    expect(hits[0].score).toBeGreaterThan(hits[1].score);
  });

  it("语义检索过滤:限定类型后只返回该类型", async () => {
    const { localEmbed } = await import("@memcore/embed-local");
    const embed = localEmbed();
    const store = new InMemoryStore();
    for (const [content, type] of [
      ["user prefers dark mode", "fact"],
      ["dark mode launch incident postmortem", "episodic"],
    ] as const) {
      const rec = newRecord(content, type, 100);
      await store.insert(rec);
      await store.setEmbedding(rec.id, await embed(content));
    }
    const hits = await store.searchSemantic({
      vector: await embed("user dark mode preference"),
      k: 10,
      memoryType: "episodic",
    });
    expect(hits.length).toBe(1);
    expect(hits[0].record.memoryType).toBe("episodic");
  });
});
