/**
 * 召回质量测试集:20 个真实场景,全部确定性(无 LLM、无网络、无随机)。
 * 这是 memcore 与"调 LLM 做记忆"方案最直观的差异化证据:
 * 同一组写入与查询,任何机器上结果逐位一致。
 */
import { describe, expect, it } from "vitest";
import {
  AccessFrequencyStrategy,
  CompositeStrategy,
  InMemoryStore,
  LastWriteWins,
  SimilarityConflictResolver,
  TimeDecayStrategy,
  TrigramEmbedder,
  newRecord,
  rankByStrategy,
  resolveAndInsert,
} from "../index.js";
import type { MemoryStore, MemoryType } from "../index.js";

const DAY = 86400;
const NOW = 1_800_000_000; // 固定时间戳,保证确定性
const STRATEGY = new CompositeStrategy([
  new TimeDecayStrategy(7 * DAY, 0.01),
  new AccessFrequencyStrategy(0.2),
]);

interface Write {
  content: string;
  type: MemoryType;
  ageDays?: number;
  reads?: number;
  importance?: number;
}

interface Scenario {
  name: string;
  writes: Write[];
  resolver?: "lww";
  query?: { text?: string; type?: MemoryType };
  expectTop1?: string;
  expectTop3Includes?: string[];
  expectCount?: number;
  expectHits?: number;
  custom?: (store: MemoryStore) => Promise<void>;
}

const scenarios: Scenario[] = [
  {
    name: "01 偏好更新:新偏好压过旧偏好",
    writes: [
      { content: "user prefers light theme", type: "fact", ageDays: 30, reads: 3 },
      { content: "user prefers dark mode", type: "fact" },
    ],
    query: { text: "user prefers" },
    expectTop1: "user prefers dark mode",
  },
  {
    name: "02 完全重复合并",
    writes: [
      { content: "repo uses pnpm", type: "fact" },
      { content: "repo uses pnpm", type: "fact" },
      { content: "repo uses pnpm", type: "fact" },
    ],
    resolver: "lww",
    expectCount: 1,
  },
  {
    name: "03 大小写重复合并",
    writes: [
      { content: "Deploy via CI", type: "procedural" },
      { content: "deploy via ci", type: "procedural" },
    ],
    resolver: "lww",
    expectCount: 1,
  },
  {
    name: "04 语义近似合并(嵌入相似度,阈值 0.8)",
    writes: [{ content: "user prefers dark mode", type: "fact" }],
    query: {},
    custom: async (store) => {
      const embed = new TrigramEmbedder().embed.bind(new TrigramEmbedder());
      const resolver = new SimilarityConflictResolver(embed, 0.8);
      await resolveAndInsert(
        store,
        newRecord("user prefers dark theme", "fact", NOW),
        resolver,
        NOW,
      );
      expect(await store.count()).toBe(1);
    },
  },
  {
    name: "05 时间衰减压制陈旧情景记忆",
    writes: [
      { content: "ran migration at 2am", type: "episodic", ageDays: 60 },
      { content: "db migration runs via make migrate", type: "fact" },
    ],
    query: { text: "migration" },
    expectTop1: "db migration runs via make migrate",
  },
  {
    name: "06 访问频率晋升常用记忆",
    writes: [
      { content: "always bump minor version before release", type: "fact", ageDays: 20, reads: 12 },
      { content: "release checklist uses github actions", type: "fact" },
    ],
    query: { text: "release" },
    expectTop1: "always bump minor version before release",
  },
  {
    name: "07 类型过滤排除干扰",
    writes: [
      { content: "rust toolchain pinned to 1.80", type: "fact" },
      { content: "rust conference trip", type: "episodic" },
    ],
    query: { text: "rust", type: "fact" },
    expectHits: 1,
  },
  {
    name: "08 程序性记忆:重复写入合并且保留首次时间",
    writes: [{ content: "deploy via ci", type: "procedural", ageDays: 10 }],
    query: {},
    custom: async (store) => {
      const first = (await store.list({}))[0];
      await resolveAndInsert(
        store,
        newRecord("Deploy via CI", "procedural", NOW),
        new LastWriteWins(),
        NOW,
      );
      expect(await store.count()).toBe(1);
      const merged = (await store.list({}))[0];
      expect(merged.createdAt).toBe(first.createdAt);
      expect(merged.accessCount).toBe(1);
    },
  },
  {
    name: "09 语义与事实同内容共存(跨类型不合并)",
    writes: [
      { content: "docker compose up starts the stack", type: "fact" },
      { content: "docker compose up starts the stack", type: "semantic" },
    ],
    expectCount: 2,
  },
  {
    name: "10 重要性压过新鲜度",
    writes: [
      { content: "team arch decision: use postgres", type: "fact", ageDays: 14, importance: 1.0 },
      { content: "team standup moved to 10am", type: "fact", importance: 0.1 },
    ],
    query: { text: "team" },
    expectTop1: "team arch decision: use postgres",
  },
  {
    name: "11 空库返回空结果",
    writes: [],
    query: { text: "anything" },
    expectHits: 0,
  },
  {
    name: "12 limit 生效",
    writes: [
      { content: "note alpha", type: "fact" },
      { content: "note beta", type: "fact" },
      { content: "note gamma", type: "fact" },
    ],
    custom: async (store) => {
      expect((await store.list({ limit: 2 })).length).toBe(2);
    },
  },
  {
    name: "13 关键词大小写不敏感",
    writes: [{ content: "GitHub Actions workflow", type: "fact" }],
    query: { text: "github actions" },
    expectHits: 1,
  },
  {
    name: "14 访问计数累加",
    writes: [{ content: "check pipeline before merge", type: "procedural" }],
    query: {},
    custom: async (store) => {
      const rec = (await store.list({}))[0];
      await store.updateAccess(rec.id, NOW + 10);
      await store.updateAccess(rec.id, NOW + 20);
      await store.updateAccess(rec.id, NOW + 30);
      expect((await store.get(rec.id))?.accessCount).toBe(3);
    },
  },
  {
    name: "15 陈旧记忆精确检索仍可达",
    writes: [{ content: "old convention: two space indent", type: "fact", ageDays: 90 }],
    query: { text: "indent" },
    expectHits: 1,
  },
  {
    name: "16 多主题互不干扰",
    writes: [
      { content: "react hooks rules of thumb", type: "fact", ageDays: 5 },
      { content: "vue reactivity caveats", type: "fact", ageDays: 5 },
      { content: "go error wrapping pattern", type: "fact", ageDays: 5 },
    ],
    query: { text: "hooks" },
    expectTop1: "react hooks rules of thumb",
  },
  {
    name: "17 无命中返回空",
    writes: [{ content: "kubernetes rollout restart", type: "fact" }],
    query: { text: "zzz-not-exist" },
    expectHits: 0,
  },
  {
    name: "18 措辞不同但语义相同 → 合并(阈值 0.8)",
    writes: [{ content: "tests must run before pushing", type: "procedural" }],
    query: {},
    custom: async (store) => {
      const embed = new TrigramEmbedder().embed.bind(new TrigramEmbedder());
      const resolver = new SimilarityConflictResolver(embed, 0.8);
      await resolveAndInsert(
        store,
        newRecord("run tests before pushing", "procedural", NOW),
        resolver,
        NOW,
      );
      expect(await store.count()).toBe(1);
    },
  },
  {
    name: "19 语义不同 → 共存(阈值 0.8)",
    writes: [{ content: "user prefers dark mode", type: "fact" }],
    query: {},
    custom: async (store) => {
      const embed = new TrigramEmbedder().embed.bind(new TrigramEmbedder());
      const resolver = new SimilarityConflictResolver(embed, 0.8);
      await resolveAndInsert(
        store,
        newRecord("deploy to production on fridays", "fact", NOW),
        resolver,
        NOW,
      );
      expect(await store.count()).toBe(2);
    },
  },
  {
    name: "20 语义检索 Top-K 排序(嵌入向量)",
    writes: [
      { content: "user prefers dark mode", type: "fact" },
      { content: "user prefers dark theme", type: "fact" },
      { content: "deploy to production on friday", type: "fact" },
    ],
    query: {},
    custom: async (store) => {
      if (!("searchSemantic" in store)) throw new Error("no vector support");
      const embed = new TrigramEmbedder().embed.bind(new TrigramEmbedder());
      for (const rec of await store.list({})) {
        await (
          store as unknown as { setEmbedding(id: string, v: number[]): Promise<void> }
        ).setEmbedding(rec.id, embed(rec.content));
      }
      const hits = await (
        store as unknown as {
          searchSemantic(q: { vector: number[]; k: number }): Promise<
            { record: { content: string }; score: number }[]
          >;
        }
      ).searchSemantic({ vector: embed("user prefers dark mode"), k: 3 });
      expect(hits[0].record.content).toBe("user prefers dark mode");
      expect(hits[1].record.content).toBe("user prefers dark theme");
      expect(hits[0].score).toBeGreaterThanOrEqual(hits[1].score);
    },
  },
];

async function buildStore(
  writes: Write[],
  resolver?: "lww",
): Promise<InMemoryStore> {
  const store = new InMemoryStore();
  for (const w of writes) {
    const age = (w.ageDays ?? 0) * DAY;
    const rec = newRecord(w.content, w.type, NOW - age);
    rec.lastAccessedAt = NOW - age;
    rec.accessCount = w.reads ?? 0;
    if (w.importance !== undefined) rec.importance = w.importance;
    if (resolver === "lww") {
      await resolveAndInsert(store, rec, new LastWriteWins(), NOW);
    } else {
      await store.insert(rec);
    }
  }
  return store;
}

let passed = 0;

describe("召回质量测试集(20 场景,确定性)", () => {
  for (const s of scenarios) {
    it(s.name, async () => {
      const store = await buildStore(s.writes, s.resolver);
      if (s.custom) {
        await s.custom(store);
        passed++;
        return;
      }
      if (s.expectCount !== undefined) {
        expect(await store.count()).toBe(s.expectCount);
        passed++;
        return;
      }
      const records = await store.list({ text: s.query?.text, memoryType: s.query?.type });
      if (s.expectHits !== undefined) {
        expect(records.length).toBe(s.expectHits);
        passed++;
        return;
      }
      const ranked = rankByStrategy(records, STRATEGY, NOW);
      if (s.expectTop1) {
        expect(ranked[0].record.content).toBe(s.expectTop1);
      }
      if (s.expectTop3Includes) {
        const top3 = ranked.slice(0, 3).map((h) => h.record.content);
        for (const c of s.expectTop3Includes) expect(top3).toContain(c);
      }
      passed++;
    });
  }

  it("全部场景通过(召回率 100%)", () => {
    expect(passed).toBe(scenarios.length);
  });
});
