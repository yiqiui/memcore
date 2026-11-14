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
  SqliteStore,
  TimeDecayStrategy,
  newRecord,
  rankByStrategy,
  resolveAgainst,
  resolveAndInsert,
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
