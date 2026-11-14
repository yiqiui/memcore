# memcore

存储无关、策略可插拔的 AI Agent 记忆引擎内核(TypeScript monorepo)。

**0.3.0**:多租户隔离、BM25 混合检索(FTS5 trigram 中文可用 / JS BM25 回退 / RRF 融合可插拔)、**TTL 过期**(`add_memory` 的 `ttl_seconds`,过期自动从所有查询排除)、**history/审计**(合并/删除的旧记录快照,`memory_history` tool / `mem history`)。设计文档见 `docs/design-0.2.0-namespace-hybrid-retrieval.md`。

## 定位

不做框架、不做完整记忆产品,只做记忆层里**方法论最未收敛**的两件事:

1. **存储无关的核心抽象**(`MemoryStore`,全异步):后端自由挂载,同一接口、同一行为。
2. **可插拔策略**:
   - `MemoryStrategy`:时间衰减(指数半衰期)、访问频率晋升、组合加权 —— 排序/晋升/淘汰的唯一依据。
   - `ConflictResolver`:同类型相似内容的写入如何合并(LastWriteWins / ImportanceMerge)—— 当前记忆层各家方案分歧最大的部分,这里显式做成可替换的策略点。

差异化主张:**确定性(不调 LLM)、零原生依赖(SQLite 用 Node 内置 node:sqlite)、极小依赖、本地优先**。

## Dashboard

```bash
npm run build -w @memcore/dashboard
npm run server -w @memcore/dashboard   # API + 静态托管,默认 http://localhost:8787
# 开发模式:npm run dev -w @memcore/dashboard(Vite 5173,代理 /api → 8787)
```

三个标签页:记忆列表(过滤/写入/重要性编辑/删除/访问计数)、策略排序 Top-20(分数条可视化)、语义检索(嵌入相似度 Top-K)。与 CLI/MCP 共享 MEMCORE_BACKEND/MEMCORE_DB。

## 召回质量测试集

`packages/core/src/eval/recall.test.ts`:**20 个真实场景,确定性、无 LLM、无网络**——偏好更新、重复合并(完全/大小写/语义近似)、时间衰减压制、高频晋升、重要性压过新鲜度、类型分离、陈旧记忆可达性、语义检索排序等,任意机器结果逐位一致。这是与"调 LLM 做记忆"方案最直观的差异化证据。

## 后端矩阵

| 包 | 后端 | 依赖 | 适用场景 |
|---|---|---|---|
| `@memcore/core` | InMemoryStore | 无 | 测试、策略验证 |
| `@memcore/core` | SqliteStore | 无(Node 内置 node:sqlite) | 默认本地单机 |
| `@memcore/core` | FileStore | 无 | 纯文件 JSON,可用 git 管理,原子写入 |
| `@memcore/lancedb` | LanceDbStore | @lancedb/lancedb | 本地列式,向量列就绪(setEmbedding) |
| `@memcore/pg` | PgStore | pg | 服务端部署;检测到 pgvector 自动加 embedding vector(1536) 列,`searchSemantic` 走原生 `<=>` 算子 |

三个内嵌后端(core 内的)在测试中逐行为断言一致;LanceDB 4 个集成测试通过;pg 后端通过 `MEMCORE_TEST_PG` 环境变量门控测试。

切换方式(CLI):`mem -b lancedb -d ./data add "..."`,或环境变量 `MEMCORE_BACKEND` / `MEMCORE_DB`(MCP server 与 dashboard 同样支持)。

**语义检索**:`VectorSearchable` 接口(`setEmbedding` / `searchSemantic`),LanceDB 走原生向量索引、pg 走 `<=>` 算子、内存后端用 `cosineTopK` 参考实现;`supportsVectorSearch(store)` 探测能力。

**嵌入来源**:
- `TrigramEmbedder`(core 内置):零依赖、确定性、离线,适合近似重复检测与 CI
- `@memcore/embed-local`:transformers.js 本地 ONNX(Xenova/all-MiniLM-L6-v2,q8 量化 ~23MB),384 维句级语义,首次下载后完全离线
- 任意模型/API:实现 `EmbeddingFn` 接口即可注入

**真实嵌入实测**(q8):同义改写相似度 0.9308,无关句 0.1265 —— 判定阈值 0.9 有清晰边界。

MCP 开启本地嵌入:`MEMCORE_EMBED=local npx @memcore/mcp`(需先 `npm i @memcore/embed-local`)。开启后 `add_memory` 的冲突消解升级为语义判定(0.9 阈值),`search_semantic` 用真实模型按需嵌入排序。

`MEMCORE_TEST_EMBED=1 npm test` 运行真实嵌入召回测试(4 场景:改写合并、不误杀、语义 Top-K、类型过滤);默认跳过,CI 无网可用。

**发布材料**:MIT LICENSE、CHANGELOG.md、各包 `prepublishOnly` 钩子与完整 npm 元数据已就绪;`npm publish` 需要你自己的 npm 账号(`npm pack --dry-run` 已验证打包内容,@memcore/core 约 20KB)。

## 技术选型

TypeScript 单仓(而非 Rust/Python)的理由:第一公里分发是 MCP(`npx` 一行配置),策略内核无性能瓶颈,core/MCP/CLI/dashboard 共享一套类型,单人迭代最快。Rust 原型保留在 `../memcore-rust/` 作参考,若未来出现真实性能需求再移植。

```
packages/
├── core   # 策略内核:npm 包 @memcore/core
│   └── src/{types,store,sqlite-store,strategy,conflict,index}.ts
├── mcp    # MCP server:@memcore/mcp(npx -y memcore-mcp)
└── cli    # 命令行:mem add/search/top/stats
```

## 快速开始

### 无 npm 账号?从源码直接用(已验证)

```bash
git clone https://github.com/yiqiui/memcore && cd memcore
npm install && npm run build          # ~1 分钟,零原生依赖,无需编译工具
```

Claude Code / Cursor 的 MCP 配置直接指向本地构建产物:

```json
{
  "mcpServers": {
    "memcore": {
      "command": "node",
      "args": ["/absolute/path/to/memcore/packages/mcp/dist/index.js"],
      "env": { "MEMCORE_BACKEND": "lancedb", "MEMCORE_DB": "/path/to/data" }
    }
  }
}
```

CLI 同理:`node packages/cli/dist/index.js -b lancedb -d ./data add "..."`。
发布到 npm 后(见下)可简化为 `npx -y @memcore/mcp`。

### 发布(维护者)

GitHub Actions 已配好两条流水线:
- **ci.yml**:push/PR 时自动 `npm ci + build + test`,并开启真实嵌入召回测试与 pgvector 容器测试
- **release.yml**:push tag `v*` 时按依赖顺序发布 6 个 npm 包并生成 GitHub Release。需在仓库 Settings → Secrets 配置 `NPM_TOKEN`(npmjs.com 的自动化 token)



### 库

```ts
import { SqliteStore, newRecord, resolveAndInsert, LastWriteWins,
         rankByStrategy, CompositeStrategy, TimeDecayStrategy, AccessFrequencyStrategy } from "@memcore/core";

const store = new SqliteStore("mem.db");
const now = Math.floor(Date.now() / 1000);

// 写入(自动冲突消解)
resolveAndInsert(store, newRecord("user prefers dark mode", "fact", now), new LastWriteWins(), now);

// 按策略排序取 Top-K
rankByStrategy(store.list({}), new CompositeStrategy([
  new TimeDecayStrategy(),
  new AccessFrequencyStrategy(),
]), now);
```

### 接入 Claude Code / Cursor(MCP)

```json
{
  "mcpServers": {
    "memcore": {
      "command": "npx",
      "args": ["-y", "@memcore/mcp"]
    }
  }
}
```

暴露 5 个 tool:`add_memory`(写入+冲突消解)、`search_memory`(keyword/semantic/hybrid 三模式,默认 hybrid)、`search_semantic`(嵌入语义检索)、`rank_memory`(策略排序 Top-K)、`memory_stats`。全部 tool 支持可选 `namespace` 参数(多租户严格分区);`MEMCORE_NAMESPACE` 设默认分区。

后端选择:`MEMCORE_BACKEND=lancedb` / `MEMCORE_DB=./data` 环境变量;未注册的后端名会自动动态加载 `@memcore/<name>` 或按 npm 包名加载(第三方)。

### CLI

```bash
npm install -w @memcore/cli && npm run build -w @memcore/cli
node packages/cli/dist/index.js add "user prefers dark mode" -t fact
node packages/cli/dist/index.js search dark
node packages/cli/dist/index.js top
node packages/cli/dist/index.js stats
```

数据库路径用 `MEMCORE_DB` 环境变量指定,默认 `~/.memcore/mem.db`(父目录自动创建)。

## 验证

```bash
npm install
npm run build
npm test
```

48 个测试全绿(含 4 个真实嵌入场景):三内嵌后端(内存/SQLite/纯文件)行为一致性断言、时间衰减单调性与半衰期语义、访问频率单调性、冲突合并(精确/嵌入相似度)、FileStore 持久化与原子写入、向量检索排序(LanceDB 原生 + 内存余弦)、召回质量测试集 20 场景、MCP 五个 tool 的端到端调用;pg 后端测试由 `MEMCORE_TEST_PG` 门控。

CLI 端到端验收:同一组操作(写入/重复合并/检索/统计)在 sqlite、file、lancedb 三个后端上输出完全一致。

## 路线图

- [ ] 发布 npm —— 全部材料与 release.yml 就绪,配置 NPM_TOKEN 后 push tag 即发
- [x] Dashboard(React + Vite):记忆浏览/编辑/策略排序/语义检索
- [x] 语义检索:`VectorSearchable` 接口,LanceDB 原生向量 / pgvector `<=>` / 内存余弦三路打通
- [x] 冲突消解升级:嵌入相似度判定(`SimilarityConflictResolver` + `TrigramEmbedder`,可换任意嵌入模型)
- [x] 20 场景召回质量测试集
- [x] TTL 过期 + history/审计(0.3.0)
- [ ] 更多策略:基于访问频率的自动晋升/淘汰、来源可信度加权
- [x] 真实嵌入模型接入:`@memcore/embed-local`(transformers.js ONNX,本地离线)+ 4 场景嵌入召回测试
