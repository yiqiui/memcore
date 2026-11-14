import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { InMemoryStore } from "@memcore/core";
import { createServer } from "./index.js";

async function makeClient() {
  const store = new InMemoryStore();
  const server = createServer(store);
  const client = new Client({ name: "test-client", version: "0.0.0" });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverT), client.connect(clientT)]);
  return client;
}

function textOf(res: unknown): string {
  const r = res as { content: { type: string; text: string }[] };
  return r.content[0].text;
}

describe("memcore mcp tools", () => {
  it("add_memory 写入并可 search_memory 检索", async () => {
    const client = await makeClient();
    await client.callTool({
      name: "add_memory",
      arguments: { content: "user prefers dark mode", type: "fact" },
    });
    const res = await client.callTool({
      name: "search_memory",
      arguments: { query: "dark" },
    });
    const results = JSON.parse(textOf(res));
    expect(results.length).toBe(1);
    expect(results[0].content).toBe("user prefers dark mode");
  });

  it("重复写入自动冲突消解", async () => {
    const client = await makeClient();
    await client.callTool({
      name: "add_memory",
      arguments: { content: "deploy via ci", type: "procedural" },
    });
    const res = await client.callTool({
      name: "add_memory",
      arguments: { content: "Deploy via CI", type: "procedural" },
    });
    const stored = JSON.parse(textOf(res));
    expect(stored.merged).toBe(true);

    const stats = JSON.parse(
      textOf(
        await client.callTool({ name: "memory_stats", arguments: {} }),
      ),
    );
    expect(stats.total).toBe(1);
    expect(stats.byType.procedural).toBe(1);
  });

  it("rank_memory 按策略返回 Top-K", async () => {
    const client = await makeClient();
    for (const content of ["a", "b", "c"]) {
      await client.callTool({
        name: "add_memory",
        arguments: { content, type: "fact", importance: 1 },
      });
    }
    const res = await client.callTool({
      name: "rank_memory",
      arguments: { limit: 2 },
    });
    const top = JSON.parse(textOf(res));
    expect(top.length).toBe(2);
    expect(top[0].score).toBeGreaterThanOrEqual(top[1].score);
  });
});
