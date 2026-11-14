import { describe, expect, it } from "vitest";
import { PgStore } from "./index.js";
import { LastWriteWins, newRecord, resolveAndInsert } from "@memcore/core";

const CONN = process.env.MEMCORE_TEST_PG; // 例: postgres://postgres:postgres@localhost:5432/memcore_test
const d = CONN ? describe : describe.skip;

d("PgStore(需要 MEMCORE_TEST_PG 环境变量指向测试库)", () => {
  it("insert/get/updateAccess/delete roundtrip", async () => {
    const store = await PgStore.connect(CONN!);
    const rec = newRecord("user prefers dark mode", "fact", 1000);
    await store.insert(rec);
    expect((await store.get(rec.id))?.content).toBe("user prefers dark mode");
    await store.updateAccess(rec.id, 2000);
    const got2 = await store.get(rec.id);
    expect(got2?.accessCount).toBe(1);
    expect(got2?.lastAccessedAt).toBe(2000);
    await store.delete(rec.id);
    expect(await store.count()).toBe(0);
    await store.close();
  });

  it("resolveAndInsert 合并重复写入", async () => {
    const store = await PgStore.connect(CONN!);
    await store.insert(newRecord("deploy via ci", "procedural", 100));
    const merged = await resolveAndInsert(
      store,
      newRecord("Deploy via CI", "procedural", 200),
      new LastWriteWins(),
      300,
    );
    expect(merged.accessCount).toBe(1);
    expect(await store.count()).toBe(1);
    await store.close();
  });
});
