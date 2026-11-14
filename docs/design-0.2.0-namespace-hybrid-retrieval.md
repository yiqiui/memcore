# memcore 0.2.0 设计:多租户隔离 + BM25 混合检索

状态:草案待评审 | 作者:memcore 维护者 | 日期:2026-11-14

背景:对 mem0 / Letta / Graphiti / cognee / Memobase / LangMem / supermemory / memvid 的功能矩阵对比得出两个准入级缺失(P0):多租户隔离、关键词/BM25 检索。本设计覆盖这两项,顺带明确 P1(TTL、history)的预留位,避免二次迁移。

原则:零新依赖(SQLite FTS5 内置);策略可插拔定位不破坏;所有后端行为一致并有测试锁定;0.1.0 数据库自动迁移。

---

## 1. 多租户隔离

### 1.1 模型选型

| 方案 | 描述 | 评价 |
|---|---|---|
| A. 单一 namespace 字段 | 记录与查询都带 `namespace: string`,默认 `"default"`;层级用命名约定(`user:alice`、`proj:x/user:alice`) | 改动最小、一个索引、语义可预测(严格分区) |
| B. 结构化 user_id/agent_id/run_id | mem0 式三列可空 | 查询人体贴市场预期,但三列组合语义复杂(继承?全局共享?),对策略内核过早 |
| C. LangMem 式 namespace 数组 | `namespace: string[]` 层级 + 前缀查询 | 灵活但引入前缀匹配语义,backends 下推复杂 |

**选 A**。理由:隔离本质是"分区键",A 足够;B/C 的表达力可日后以"约定 + helper"叠加而不破坏 schema(字符串编码 `user:alice/agent:coder`);核心保持可预测。文档明确推荐命名约定,并提供 `ns.user("alice")` 之类的 helper 生成约定串。

### 1.2 数据模型与接口变更

```ts
// types.ts
interface MemoryRecord {
  ...
  namespace: string;          // 新增,必填
}
newRecord(content, type, now, opts?: { namespace?: string })  // 默认 "default"

interface SearchQuery {
  ...
  namespace?: string;         // 新增;undefined 视为 "default"(不跨区查询)
}
```

隔离语义(**严格分区,无继承**):查询只返回 `namespace` 精确匹配的记录;不存在跨 namespace 的可见性。需要共享时显式写多个 namespace(或未来加 `shareWith`)。理由:可审计、可预测,和"确定性"定位一致;隐式继承是事故来源。

### 1.3 各后端实现

- **SQLite**:`ALTER TABLE memories ADD COLUMN namespace TEXT NOT NULL DEFAULT 'default'`;新索引 `(namespace, memory_type)`;所有查询带 `WHERE namespace = ?`(list/get/updateAccess/delete 全部加,含 `resolve_and_insert` 的候选查询)。迁移:建表语句更新 + 打开旧库时检测列缺失自动 ALTER + 重建索引(见 §3 迁移)。
- **LanceDB**:行加 `namespace` 列;旧表打开时若缺列,Lance 支持加列(add_columns),默认值回填 `"default"`;查询下推 `where namespace = '...'`。
- **pg**:`namespace TEXT NOT NULL DEFAULT 'default'` + `(namespace, memory_type)` 索引;向量列不动。
- **File / InMemory**:记录带字段即可,过滤逻辑统一走 `filterRecords`(加 namespace 判断)。

### 1.4 冲突消解与策略的 namespace 语义

- `resolveAndInsert` 的候选查询必须带 namespace —— **去重只发生在分区内**(alice 的 "dark mode" 和 bob 的 "dark mode" 是两条记忆)。
- `rankByStrategy` 不感知 namespace(输入记录列表,调用方负责带 scope 查询)。
- 语义检索:向量列不分区,`searchSemantic` 查询带 namespace 过滤(后处理或谓词下推均可,MVP 用后处理,量级见 §2.6)。

### 1.5 上层暴露

- **MCP**:五个 tool 全部加可选 `namespace` 参数(默认 `"default"`);README 写明多用户/多项目配置方式(每个 Claude 项目可配不同 `MEMCORE_NAMESPACE` 环境变量默认值)。
- **CLI**:`-n, --namespace <name>` 全局选项;`stats` 按当前 namespace 输出。
- **Dashboard**:顶栏 namespace 切换器(切换即刷新全部数据);API server 加 `MEMCORE_NAMESPACE` 默认值 + 请求级 `?ns=` 覆盖。
- **pg/LanceDB 连接串**:不变;namespace 是行级不是库级。

### 1.6 不做什么(明确排除)

- 跨 namespace 共享/继承;基于 role 的访问控制;run_id(单机 MCP 场景用不上,需要时是 namespace 约定问题)。

---

## 2. BM25 混合检索

### 2.1 目标与市场空档

头部项目人人有混合检索,但**融合权重无一家可完整配置**(mem0 固定三路融合、Graphiti 预置 recipe)。memcore 把"融合"做成和衰减/冲突同级的可插拔策略 —— `FusionStrategy`,这是本项目定位的自然延伸。

### 2.2 检索路径

```
searchHybrid(store, opts) ─┬─ 关键词路径: FullTextSearchable 后端(FTS5) 或 JS BM25 回退
                           ├─ 语义路径: VectorSearchable(预存向量) 或按需嵌入(embedFn)
                           └─ FusionStrategy.fuse(路径结果[]) → Top-K HybridHit
```

### 2.3 SQLite FTS5 细节

- 虚拟表:`CREATE VIRTUAL TABLE memories_fts USING fts5(content, namespace UNINDEXED, content='memories', content_rowid=rowid, tokenize='trigram')`。
- **选 trigram 而非 unicode61 的理由**:unicode61 不切 CJK,中文搜索直接失效;trigram 对中英都给出子串级匹配,且保留 bm25() 排序能力。代价:查询串需 ≥3 字符(trigram 最小单位),**短查询回退**到 LIKE 子串过滤(已有行为)。
- 同步:触发器(AFTER INSERT / DELETE OF / UPDATE OF content)自动维护,不依赖调用方。
- 迁移:打开旧库时检测 `memories_fts` 不存在则创建 + `INSERT INTO memories_fts(rowid, content, namespace) SELECT rowid, content, namespace FROM memories`。FTS 表与 namespace:内容表含 namespace 列(UNINDEXED),分区过滤在主表 JOIN 上做。
- 查询形态:`SELECT rowid, bm25(memories_fts) AS score FROM memories_fts WHERE memories_fts MATCH ? AND namespace = ? ORDER BY score LIMIT ?`;MATCH 语法对用户输入做转义(包成双引号短语,避免 FTS 语法注入)。

### 2.4 JS 回退 BM25(File / InMemory / 任意无 FTS 后端)

- 纯 TS 实现 BM25(k1=1.5, b=0.75),文档集 = `store.list({ namespace, memoryType? })` 全量后内存打分 —— 定位是单机本地,量级(万级)可接受;pg/Lance 走各自原生路径时不用它。
- **分词器可注入**:`Tokenizer = (text: string) => string[]`;默认实现 = 小写化 + 非字母数字切词 + CJK 双字组(bigram)。允许用户注入 jieba 等专业分词而不改 core。
- 确定性:同一输入同一输出,进召回测试集。

### 2.5 语义路径

- 若传入 `embedFn`:对查询与记录**按需嵌入**(与 MCP search_semantic 相同逻辑,任意后端可用),嵌入结果带进程内 LRU 缓存(record id + content hash → vector),避免同一批记录反复推理。
- 若未传 embedFn 且后端 `supportsVectorSearch`:走 `searchSemantic`(要求调用方已 setEmbedding,适合 LanceDB/pg 重度用户)。
- 两者都不满足:语义路径缺席,退化为纯 BM25(行为明确定义,不报错)。

### 2.6 融合:`FusionStrategy`

```ts
interface FusionStrategy {
  fuse(paths: { kind: "bm25" | "semantic"; hits: { record; score }[] }[], limit: number): HybridHit[];
}
class RrfFusion { constructor(k = 60) }                    // 默认;Rank-based,免归一化
class WeightedFusion { constructor(weights?: { bm25?; semantic? }) }  // min-max 归一化 + 加权和
```

- 默认 **RRF**(k=60):对 scale 不敏感,参数少,文献标准。
- `WeightedFusion` 回应"融合权重无人可配"的空档;每路径分数先 min-max 归一再加权。
- `HybridHit = { record, score, signals: { bm25?: number; semantic?: number } }` —— 信号分透传,dashboard 可视化"这条为什么被召回"。
- **短查询/空路径处理**:只有一路有结果时直接返回该路;两路都空返回空。

### 2.7 上层 API

```ts
// core 顶层入口
searchHybrid(store, {
  query: string,              // 关键词路径 + 嵌入输入
  namespace?, memoryType?, limit = 10,
  embedFn?,                   // 缺省时语义路径行为见 §2.5
  fusion?, tokenizer?,
}): Promise<HybridHit[]>
```

- **MCP**:`search_memory` 加 `mode: "keyword" | "semantic" | "hybrid"`(默认 hybrid);`search_semantic` 保留(等价 mode=semantic 的便捷入口)。
- **CLI**:`mem search` 加 `--mode`,`mem top` 不变(策略排序 ≠ 检索)。
- **Dashboard**:搜索框 + mode 切换;hybrid 结果展示双信号分。

### 2.8 规模与性能边界(诚实声明)

- JS BM25 与按需嵌入都是 O(N) 内存路径;单机万级记录可用,十万级必须走 FTS5/Lance 原生路径(均有)。README 写明边界,不夸大。
- sqlite/file 后端没有向量列 —— 语义路径依赖 embedFn(按需),SQL 后端重度用户被引导到 Lance/pg。

---

## 3. 迁移与兼容(0.1.0 → 0.2.0)

1. SQLite:打开时 PRAGMA table_info 检查 namespace 列 → `ALTER TABLE ... ADD COLUMN namespace TEXT NOT NULL DEFAULT 'default'`;检查 memories_fts → 创建 + 回填;版本号存 `PRAGMA user_version = 2`。
2. LanceDB:schema 缺 namespace 列 → `addColumns` + 回填(scan & rewrite 或默认值语义确认后定,MVP 用"读时缺省")。
3. pg:`ALTER TABLE ... ADD COLUMN IF NOT EXISTS`,幂等。
4. File:旧 JSON 无 namespace 字段 → 读时缺省 `"default"`,写时带上(一次性自愈)。
5. API 兼容:`newRecord` 加可选参数不破坏;`SearchQuery.namespace` 可选不破坏;`HybridHit` 是新类型。**0.2.0 无破坏性变更**(记录新增字段在 TS 里是必填 —— 对直接构造 `MemoryRecord` 字面量的外部用户是破坏,发布说明标注 + 提供迁移说明;内部全部走 `newRecord`)。

## 4. 测试计划

- **单元**:namespace 严格分区矩阵(A 写 B 查空;冲突消解按分区;ranking 不受影响);trigram FTS 同步(insert/update/delete 三向);MATCH 转义;JS BM25 分词与评分;RRF/Weighted 排序;短查询回退;LRU 嵌入缓存。
- **迁移**:0.1.0 格式 fixture(手工构造旧 schema 的 SQLite/JSON)打开后自动迁移,数据不丢,旧查询行为不变。
- **召回测试集扩展**:`recall.test.ts` 增加 hybrid 场景(中文 BM25 命中、hybrid 融合把"关键词强 + 语义强"的记录排第一、RRF 与 Weighted 的顺序差异断言)。
- **端到端**:MCP 带 namespace 的多用户写入/检索;CLI `-n`;dashboard namespace 切换;clone 流程复验。
- **CI**:pgvector 容器测试带 namespace 用例;嵌入召回测试不变。

## 5. 工作量与顺序

| 步骤 | 内容 | 估时 |
|---|---|---|
| 1 | namespace:core 模型 + 四后端 + 迁移 + 测试 | 0.5d |
| 2 | FTS5(trigram/触发器/转义)+ JS BM25 + 分词器 | 1d |
| 3 | FusionStrategy(RRF/Weighted)+ searchHybrid + 嵌入缓存 | 1d |
| 4 | MCP/CLI/Dashboard 暴露 + e2e | 0.5d |
| 5 | 召回测试集扩展 + README/CHANGELOG + 发版 0.2.0 | 0.5d |

## 6. P1 预留(本次不实现,设计上不堵路)

- **TTL**:`expirationAt?: number` 字段 + 检索时过滤(`now < expirationAt` 或 NULL);衰减策略加 TTL 感知子策略。字段现在不加,避免和 namespace 迁移叠 加 —— 下次迁移一起。
- **history/审计**:合并消解时把被替换记录写入 `memories_history`(SQLite 表 / 其他后端按能力降级);接口 `store.history(namespace?, limit?)`。与 namespace 同期考虑 schema,实现放 0.3。
- **溯源**:metadata 约定 `{ source, tool, at }`,检索结果透传 —— 纯文档约定,随时可加。

## 7. 待确认的开放问题

1. namespace 命名约定采用 `user:alice` 冒号制还是 `user/alice` 路径制?(影响 helper 命名与文档,不影响 schema)
2. MCP `search_memory` 默认 mode:hybrid(推荐,行为最接近用户预期)还是保持 keyword(行为与 0.1.0 一致)?
3. `WeightedFusion` 默认权重(bm25 0.4 / semantic 0.6?)—— 建议先只内置 RRF,Weighted 文档示例给权重,避免拍脑袋默认值。
