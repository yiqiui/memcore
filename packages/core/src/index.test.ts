import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AccessFrequencyStrategy,
  CompositeStrategy,
  ImportanceMerge,
  InMemoryStore,
  FileStore,
  LastWriteWins,
  MemoryStore,
  RrfFusion,
  SqliteStore,
  TimeDecayStrategy,
  bm25TopK,
  newRecord,
  rankByStrategy,
  resolveAgainst,
  resolveAndInsert,
  searchHybrid,
} from "./index.js";

let tmpSeq = 0;
function makeStores(): { path: string; make: () => MemoryStore }[] {
  // 每个用例独立的临时文件,避免用例间数据污染
  const dir = () =>
    mkdtempSync(join(tmpdir(), `memcore-${process.pid}-${tmpSeq++}-`));
  return [
    { path: "in-memory", make: () => new InMemoryStore() },
    { path: "<tempdir>/mem.db", make: () => new SqliteStore(join(dir(), "mem.db")) },
    { path: "<tempdir>/mem.json", make: () => new FileStore(join(dir(), "mem.json")) },
  ];
}

describe("stores (in-memory & sqlite & file 行为一致)", () => {
  for (const { path, make } of makeStores()) {
    it(`[${path}] insert/get/updateAccess/delete roundtrip`, async () => {
      const store = make();
      const rec = newRecord("user prefers dark mode", "fact", 1000);
      await store.insert(rec);
      const got = await store.get(rec.id);
      expect(got?.content).toBe("user prefers dark mode");
      await store.updateAccess(rec.id, 2000);
      const got2 = await store.get(rec.id);
      expect(got2?.accessCount).toBe(1);
      expect(got2?.lastAccessedAt).toBe(2000);
      await store.delete(rec.id);
      expect(await store.get(rec.id)).toBeUndefined();
      expect(await store.count()).toBe(0);
    });

    it(`[${path}] list 按 type 与 text 过滤`, async () => {
      const store = make();
      await store.insert(newRecord("dark mode", "fact", 1));
      await store.insert(newRecord("ran migration", "episodic", 1));
      expect((await store.list({})).length).toBe(2);
      expect((await store.list({ memoryType: "fact" })).length).toBe(1);
      expect((await store.list({ text: "MIGRATION" })).length).toBe(1);
      expect((await store.list({ limit: 1 })).length).toBe(1);
    });

    it(`[${path}] resolveAndInsert 合并重复写入`, async () => {
      const store = make();
      await store.insert(newRecord("user prefers dark mode", "fact", 100));
      const dup = newRecord("User prefers dark mode", "fact", 200);
      const merged = await resolveAndInsert(store, dup, new LastWriteWins(), 300);
      expect(merged.accessCount).toBe(1);
      expect(await store.count()).toBe(1);

      await resolveAndInsert(store, newRecord("likes rust", "fact", 300), new LastWriteWins(), 300);
      expect(await store.count()).toBe(2);
    });
  }
});

describe("file store 持久化", () => {
  it("重新打开后数据仍在(原子写入 + 惰性加载)", async () => {
    const dir = mkdtempSync(join(tmpdir(), `memcore-persist-${process.pid}-`));
    const file = join(dir, "mem.json");
    const s1 = new FileStore(file);
    await s1.insert(newRecord("durable memory", "semantic", 42));
    const s2 = new FileStore(file);
    expect(await s2.count()).toBe(1);
    expect((await s2.list({ text: "durable" }))[0].content).toBe("durable memory");
  });
});

describe("namespace 严格分区", () => {
  for (const { path, make } of makeStores()) {
    it(`[${path}] A 区写入,B 区/default 不可见`, async () => {
      const store = make();
      await store.insert({ ...newRecord("shared note", "fact", 1), namespace: "user:alice" });
      expect((await store.list({ namespace: "user:alice" })).length).toBe(1);
      expect((await store.list({})).length).toBe(0);
      expect((await store.list({ namespace: "user:bob" })).length).toBe(0);
    });

    it(`[${path}] 冲突消解按分区独立`, async () => {
      const store = make();
      const r = { namespace: "user:alice" } as const;
      await resolveAndInsert(
        store,
        { ...newRecord("dark mode", "fact", 1), ...r },
        new LastWriteWins(),
        5,
      );
      const merged = await resolveAndInsert(
        store,
        { ...newRecord("dark mode", "fact", 2), ...r },
        new LastWriteWins(),
        5,
      );
      expect(merged.accessCount).toBe(1);
      expect((await store.list({ namespace: "user:alice" })).length).toBe(1);

      const bob = await resolveAndInsert(
        store,
        { ...newRecord("dark mode", "fact", 3), namespace: "user:bob" },
        new LastWriteWins(),
        5,
      );
      expect(bob.accessCount).toBe(0);
      expect((await store.list({ namespace: "user:bob" })).length).toBe(1);
    });
  }

  it("SQLite 0.1.0 旧库自动迁移(v1 schema → namespace + FTS)", async () => {
    const dir = mkdtempSync(join(tmpdir(), `memcore-mig-`));
    const dbPath = join(dir, "legacy.db");
    const { DatabaseSync } = await import("node:sqlite");
    const raw = new DatabaseSync(dbPath);
    raw.exec(`CREATE TABLE memories (id TEXT PRIMARY KEY, content TEXT NOT NULL, memory_type TEXT NOT NULL, created_at INTEGER NOT NULL, last_accessed_at INTEGER NOT NULL, access_count INTEGER NOT NULL, importance REAL NOT NULL, metadata TEXT NOT NULL);`);
    raw
      .prepare(`INSERT INTO memories VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run("legacy-id", "legacy content", "fact", 100, 100, 0, 0.5, "{}");
    raw.close();

    const store = new SqliteStore(dbPath);
    const all = await store.list({});
    expect(all.length).toBe(1);
    expect(all[0].namespace).toBe("default");
    expect((await store.searchFullText({ text: "legacy content" })).length).toBe(1);
    expect((await store.searchFullText({ text: "no such thing xyz" })).length).toBe(0);
  });

  it("FTS5 中文 trigram 与引号转义", async () => {
    const store = new SqliteStore(":memory:");
    await store.insert(newRecord("用户偏好深色主题", "fact", 1));
    await store.insert(newRecord('quote "test" content', "fact", 1));
    expect((await store.searchFullText({ text: "深色主题" })).length).toBe(1);
    expect((await store.searchFullText({ text: "无关查询词组" })).length).toBe(0);
    expect((await store.searchFullText({ text: '"test"' })).length).toBe(1);
  });

  it("BM25 JS 回退路径(分词 + 排序)", async () => {
    const store = new InMemoryStore();
    await store.insert(newRecord("deploy via github actions workflow", "fact", 1));
    await store.insert(newRecord("dark mode theme preference", "fact", 1));
    const hits = bm25TopK(await store.list({}), "github actions", 10);
    expect(hits[0].record.content).toBe("deploy via github actions workflow");
    const zh = bm25TopK(await store.list({}), "深色", 10);
    expect(zh.length).toBe(0); // "深色" bigram vs 内容 "dark mode...",无中文命中
  });

  it("RRF 融合:两路都命中的记录排第一", () => {
    const a = newRecord("both signals", "fact", 1);
    const b = newRecord("bm25 only", "fact", 1);
    const c = newRecord("semantic only", "fact", 1);
    const fused = new RrfFusion().fuse(
      [
        { kind: "bm25", hits: [ { record: a, score: 5 }, { record: b, score: 3 } ] },
        { kind: "semantic", hits: [ { record: c, score: 4 }, { record: a, score: 2 } ] },
      ],
      10,
    );
    expect(fused[0].record.content).toBe("both signals");
    expect(fused[0].signals.bm25).toBe(5);
    expect(fused[0].signals.semantic).toBe(2);
  });

  it("searchHybrid 全链路(内存后端 + 假嵌入)", async () => {
    const store = new InMemoryStore();
    await store.insert(newRecord("user prefers dark mode", "fact", 1));
    await store.insert(newRecord("deploy to production", "fact", 1));
    const hits = await searchHybrid(store, {
      query: "dark mode",
      embedFn: (t) => [t.includes("dark") ? 1 : 0, t.includes("deploy") ? 1 : 0],
    });
    expect(hits[0].record.content).toBe("user prefers dark mode");
    expect(hits[0].signals.bm25).toBeDefined();
    expect(hits[0].signals.semantic).toBeDefined();
  });
});

describe("strategies", () => {
  it("时间衰减单调,半衰期语义正确", () => {
    const strat = new TimeDecayStrategy(100, 0);
    const rec = { ...newRecord("x", "fact", 0), importance: 1.0 };
    const s0 = strat.score(rec, 0);
    const s50 = strat.score(rec, 50);
    const s100 = strat.score(rec, 100);
    expect(s0).toBeGreaterThan(s50);
    expect(s50).toBeGreaterThan(s100);
    expect(s100).toBeCloseTo(0.5, 9);
  });

  it("访问频率单调递增", () => {
    const strat = new AccessFrequencyStrategy();
    const rec = newRecord("x", "fact", 0);
    const s0 = strat.score(rec, 0);
    const s10 = strat.score({ ...rec, accessCount: 10 }, 0);
    expect(s10).toBeGreaterThan(s0);
  });
});

describe("conflict resolvers", () => {
  it("LastWriteWins 合并同内容写入并保留首次出现时间", async () => {
    const old = newRecord("user prefers dark mode", "fact", 100);
    const incoming = { ...newRecord("User prefers dark mode ", "fact", 200), importance: 0.9 };
    const res = await resolveAgainst(incoming, [old], new LastWriteWins(), 300);
    expect(res.kind).toBe("resolved");
    if (res.kind === "resolved") {
      expect(res.merged.accessCount).toBe(1);
      expect(res.merged.createdAt).toBe(100);
      expect(res.merged.lastAccessedAt).toBe(300);
    }
  });

  it("不同类型不判为冲突", async () => {
    const old = newRecord("user prefers dark mode", "fact", 100);
    const incoming = newRecord("user prefers dark mode", "semantic", 200);
    const res = await resolveAgainst(incoming, [old], new LastWriteWins(), 300);
    expect(res.kind).toBe("no-conflict");
  });

  it("ImportanceMerge 取 max 并累加访问计数", async () => {
    const old = { ...newRecord("deploy via ci", "procedural", 100), importance: 0.3, accessCount: 4 };
    const incoming = newRecord("deploy via CI", "procedural", 200);
    const res = await resolveAgainst(incoming, [old], new ImportanceMerge(), 300);
    expect(res.kind).toBe("resolved");
    if (res.kind === "resolved") {
      expect(res.merged.importance).toBeCloseTo(0.5, 9);
      expect(res.merged.accessCount).toBe(5);
    }
  });
});

describe("rankByStrategy", () => {
  it("组合策略偏好近期且高频的记忆", () => {
    const old = newRecord("old", "fact", 0);
    const recent = {
      ...newRecord("recent", "fact", 0),
      lastAccessedAt: 900,
      accessCount: 5,
    };
    const strat = new CompositeStrategy([
      new TimeDecayStrategy(100, 0),
      new AccessFrequencyStrategy(),
    ]);
    const ranked = rankByStrategy([old, recent], strat, 1000);
    expect(ranked[0].record.content).toBe("recent");
  });
});
