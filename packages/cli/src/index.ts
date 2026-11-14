#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import path from "node:path";
import { Command } from "commander";
import {
  AccessFrequencyStrategy,
  CompositeStrategy,
  LastWriteWins,
  MemoryStore,
  TimeDecayStrategy,
  newRecord,
  openStore as openBackend,
  rankByStrategy,
  resolveAndInsert,
} from "@memcore/core";

const program = new Command();

/**
 * 后端自由挂载:-b <name> / MEMCORE_BACKEND。
 * name 可以是内置(sqlite|file|memory)、官方包名(lancedb|pg,自动动态加载
 * @memcore/<name>)或任意第三方 npm 包名 —— 新后端零代码改动接入。
 */
async function openStore(): Promise<MemoryStore> {
  const opts = program.opts<{ backend?: string; db?: string }>();
  const home = process.env.HOME ?? process.env.USERPROFILE ?? ".";
  const dbPath = opts.db ?? process.env.MEMCORE_DB ?? `${home}/.memcore/mem.db`;
  const backend = opts.backend ?? process.env.MEMCORE_BACKEND ?? "sqlite";
  return openBackend(backend, dbPath);
}

program
  .name("mem")
  .description("memcore memory CLI")
  .version("0.1.0")
  .option("-b, --backend <name>", "后端名: 内置 sqlite|file|memory,官方 lancedb|pg,或第三方 npm 包名", "sqlite")
  .option("-d, --db <path>", "数据库路径(含义随 backend 变化)");

program
  .command("add")
  .description("写入一条记忆(自动冲突消解)")
  .argument("<content>", "记忆内容")
  .option("-t, --type <type>", "episodic|fact|semantic|procedural", "fact")
  .option("-i, --importance <n>", "重要性 0-1", parseFloat)
  .action(async (content: string, opts: { type: string; importance?: number }) => {
    const now = Math.floor(Date.now() / 1000);
    const rec = newRecord(content, opts.type as "fact", now);
    if (opts.importance !== undefined) rec.importance = opts.importance;
    const store = await openStore();
    const stored = await resolveAndInsert(store, rec, new LastWriteWins(), now);
    console.log(`+ ${stored.id} [${stored.memoryType}] ${stored.content}`);
  });

program
  .command("search")
  .description("按关键词检索记忆")
  .argument("[query]", "关键词")
  .option("-t, --type <type>", "按类型过滤")
  .option("-n, --limit <n>", "条数上限", parseInt, 10)
  .action(async (query: string | undefined, opts: { type?: string; limit: number }) => {
    const store = await openStore();
    const results = await store.list({
      text: query,
      memoryType: opts.type as never,
      limit: opts.limit,
    });
    if (results.length === 0) {
      console.log("(no results)");
      return;
    }
    for (const r of results) {
      console.log(`${r.id.slice(0, 8)}  [${r.memoryType}]  ${r.content}`);
    }
  });

program
  .command("top")
  .description("按策略排序,返回最值得注入上下文的记忆")
  .option("-n, --limit <n>", "条数上限", parseInt, 10)
  .action(async (opts: { limit: number }) => {
    const store = await openStore();
    const strat = new CompositeStrategy([
      new TimeDecayStrategy(),
      new AccessFrequencyStrategy(),
    ]);
    const ranked = rankByStrategy(await store.list({}), strat, Math.floor(Date.now() / 1000));
    for (const { record, score } of ranked.slice(0, opts.limit)) {
      console.log(
        `${score.toFixed(4)}  [${record.memoryType}]  ${record.content}  (reads=${record.accessCount})`,
      );
    }
  });

program
  .command("stats")
  .description("记忆库统计")
  .action(async () => {
    const store = await openStore();
    const types = ["episodic", "fact", "semantic", "procedural"] as const;
    console.log(`total: ${await store.count()}`);
    for (const t of types) {
      console.log(`  ${t}: ${(await store.list({ memoryType: t })).length}`);
    }
  });

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  program.parseAsync().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
