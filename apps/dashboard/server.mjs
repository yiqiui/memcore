/**
 * memcore dashboard API server:本地 Node http(零框架依赖)。
 * 后端经 memcore 注册表挂载(MEMCORE_BACKEND / MEMCORE_DB),与 CLI/MCP 同一套规则。
 */
import { createServer as createHttp } from "node:http";
import { readFileSync, existsSync, statSync } from "node:fs";
import { join, extname, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AccessFrequencyStrategy,
  CompositeStrategy,
  LastWriteWins,
  TimeDecayStrategy,
  TrigramEmbedder,
  newRecord,
  openStore,
  rankByStrategy,
  resolveAndInsert,
  supportsVectorSearch,
} from "@memcore/core";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 8787);
const home = process.env.HOME ?? process.env.USERPROFILE ?? ".";
const dbPath = process.env.MEMCORE_DB ?? `${home}/.memcore/mem.db`;
const backend = process.env.MEMCORE_BACKEND ?? "sqlite";
const defaultNs = process.env.MEMCORE_NAMESPACE ?? "default";
function reqNs(url) {
  return url.searchParams.get("ns") ?? defaultNs;
}

const store = await openStore(backend, dbPath);
let embed = new TrigramEmbedder().embed.bind(new TrigramEmbedder());
if (process.env.MEMCORE_EMBED === "local") {
  const { localEmbed } = await import("@memcore/embed-local");
  embed = localEmbed();
}
const strategy = new CompositeStrategy([
  new TimeDecayStrategy(),
  new AccessFrequencyStrategy(),
]);

const MIME = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
};

function json(res, code, body) {
  res.writeHead(code, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf-8"));
}

const http = createHttp(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const path = url.pathname;
  try {
    if (path === "/api/config") {
      return json(res, 200, { backend, dbPath, vector: supportsVectorSearch(store), namespace: defaultNs });
    }
    if (path === "/api/stats") {
      const n = reqNs(url);
      const types = ["episodic", "fact", "semantic", "procedural"];
      const byType = {};
      let total = 0;
      for (const t of types) {
        byType[t] = (await store.list({ memoryType: t, namespace: n })).length;
        total += byType[t];
      }
      return json(res, 200, { total, byType, vector: supportsVectorSearch(store), namespace: n });
    }
    if (path === "/api/records" && req.method === "GET") {
      const records = await store.list({
        text: url.searchParams.get("q") ?? undefined,
        memoryType: url.searchParams.get("type") ?? undefined,
        namespace: reqNs(url),
        includeExpired: true, // 管理面板要看全量,前端标记过期
      });
      return json(res, 200, records);
    }
    if (path === "/api/records" && req.method === "POST") {
      const body = await readBody(req);
      const now = Math.floor(Date.now() / 1000);
      const rec = newRecord(String(body.content ?? ""), body.type ?? "fact", now, {
        namespace: body.namespace ?? reqNs(url),
      });
      if (body.importance !== undefined) rec.importance = Number(body.importance);
      const stored = await resolveAndInsert(store, rec, new LastWriteWins(), now);
      return json(res, 200, stored);
    }
    const m = path.match(/^\/api\/records\/([^/]+)$/);
    if (m && req.method === "DELETE") {
      await store.delete(m[1]);
      return json(res, 200, { deleted: m[1] });
    }
    if (m && req.method === "PATCH") {
      const body = await readBody(req);
      const rec = await store.get(m[1]);
      if (!rec) return json(res, 404, { error: "not found" });
      if (body.importance !== undefined) rec.importance = Number(body.importance);
      await store.insert(rec);
      return json(res, 200, rec);
    }
    if (m && req.method === "POST" && path.endsWith("/access")) {
      await store.updateAccess(m[1], Math.floor(Date.now() / 1000));
      return json(res, 200, { ok: true });
    }
    if (path === "/api/top") {
      const limit = Number(url.searchParams.get("limit") ?? 10);
      const ranked = rankByStrategy(
        await store.list({ namespace: reqNs(url) }),
        strategy,
        Math.floor(Date.now() / 1000),
      );
      return json(res, 200, ranked.slice(0, limit).map(({ record, score }) => ({ ...record, score })));
    }
    if (path === "/api/semantic" && req.method === "POST") {
      if (!supportsVectorSearch(store)) {
        return json(res, 400, { error: "backend does not support vector search (use -b lancedb / pg / memory)" });
      }
      const body = await readBody(req);
      const hits = await store.searchSemantic({
        vector: embed(String(body.query ?? "")),
        k: Number(body.k ?? 10),
        memoryType: body.type,
        namespace: body.namespace ?? reqNs(url),
      });
      return json(res, 200, hits);
    }
    if (!path.startsWith("/api/")) {
      // 静态托管 vite 构建产物
      const dist = join(__dirname, "dist");
      let file = join(dist, path === "/" ? "index.html" : path);
      if (!existsSync(file) || statSync(file).isDirectory()) {
        file = join(dist, "index.html");
      }
      if (existsSync(file)) {
        res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
        return res.end(readFileSync(file));
      }
      return json(res, 200, { name: "memcore dashboard", hint: "run `npm run dev` or `npm run build` first" });
    }
    json(res, 404, { error: "not found" });
  } catch (err) {
    json(res, 500, { error: String(err?.message ?? err) });
  }
});

http.listen(PORT, () => {
  console.log(`memcore dashboard API on http://localhost:${PORT} (backend=${backend}, db=${dbPath})`);
});
