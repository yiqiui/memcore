import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LanceDbStore } from "./index.js";
import {
  LastWriteWins,
  newRecord,
  resolveAndInsert,
} from "@memcore/core";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), `memcore-lance-${process.pid}-`));
}

describe("LanceDbStore", () => {
  it("insert/get/updateAccess/delete roundtrip", async () => {
    const store = await LanceDbStore.open(tempDir());
    const rec = newRecord("user prefers dark mode", "fact", 1000);
    await store.insert(rec);
    const got = await store.get(rec.id);
    expect(got?.content).toBe("user prefers dark mode");
    expect(got?.memoryType).toBe("fact");
    await store.updateAccess(rec.id, 2000);
    const got2 = await store.get(rec.id);
    expect(got2?.accessCount).toBe(1);
    expect(got2?.lastAccessedAt).toBe(2000);
    await store.delete(rec.id);
    expect(await store.get(rec.id)).toBeUndefined();
    expect(await store.count()).toBe(0);
  });

  it("list 过滤与冲突消解", async () => {
    const store = await LanceDbStore.open(tempDir());
    await store.insert(newRecord("dark mode", "fact", 1));
    await store.insert(newRecord("ran migration", "episodic", 1));
    expect((await store.list({ memoryType: "fact" })).length).toBe(1);
    expect((await store.list({ text: "MIGRATION" })).length).toBe(1);

    const merged = await resolveAndInsert(
      store,
      newRecord("dark mode", "fact", 5),
      new LastWriteWins(),
      5,
    );
    expect(merged.accessCount).toBe(1);
    expect(await store.count()).toBe(2);
  });

  it("重复 open 同一目录数据仍在", async () => {
    const dir = tempDir();
    const s1 = await LanceDbStore.open(dir);
    const rec = newRecord("durable", "semantic", 7);
    await s1.insert(rec);
    const s2 = await LanceDbStore.open(dir);
    expect(await s2.count()).toBe(1);
    expect((await s2.get(rec.id))?.content).toBe("durable");
  });

  it("setEmbedding 写入向量且不破坏行数据", async () => {
    const store = await LanceDbStore.open(tempDir());
    const rec = newRecord("vec record", "fact", 1);
    await store.insert(rec);
    await store.setEmbedding(rec.id, [0.1, 0.2, 0.3]);
    const got = await store.get(rec.id);
    expect(got?.content).toBe("vec record");
    expect(await store.count()).toBe(1);
  });
});
