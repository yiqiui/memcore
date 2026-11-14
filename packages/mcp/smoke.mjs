import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";

const serverPath = fileURLToPath(new URL("./dist/index.js", import.meta.url));
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [serverPath],
  env: { ...process.env, MEMCORE_DB: "D:/tmp/memcore-e2e/mcp-embed.db", MEMCORE_BACKEND: "memory", MEMCORE_EMBED: "local" },
});
const client = new Client({ name: "smoke", version: "0" });
await client.connect(transport);

const r1 = JSON.parse(
  (await client.callTool({ name: "add_memory", arguments: { content: "tests must run before pushing", type: "procedural" } })).content[0].text,
);
const r2 = JSON.parse(
  (await client.callTool({ name: "add_memory", arguments: { content: "run tests before pushing", type: "procedural" } })).content[0].text,
);
console.log("第二次写入 merged =", r2.merged);
const stats = JSON.parse(
  (await client.callTool({ name: "memory_stats", arguments: {} })).content[0].text,
);
console.log("语义合并 total =", stats.total, stats.byType);
const hits = JSON.parse(
  (await client.callTool({ name: "search_semantic", arguments: { query: "run the tests first", k: 3 } })).content[0].text,
);
console.log("语义检索 top1 =", hits[0]?.content, "score =", hits[0]?.score?.toFixed(4));
await client.close();
process.exit(0);
