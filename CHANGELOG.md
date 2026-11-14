# Changelog

## [0.3.0] - 2026-11-14

### Added

- **TTL**:`MemoryRecord.expirationAt`(unix 秒);过期记录默认从 list/searchFullText/searchHybrid/rank 全部排除,`includeExpired: true` 可见;MCP `add_memory` 加 `ttl_seconds`,CLI `add --ttl`;Dashboard 列表显示过期记录并标记
- **history/审计**(SQLite 后端):`memories_history` 表 + `HistoryAware` 能力接口;冲突合并时自动快照被替换的旧记录;MCP 新增 `memory_history` tool,CLI 新增 `mem history`
- 0.2.0 库自动迁移(expiration_at 列 + history 表,`PRAGMA user_version = 3`)

### Fixed

- LanceDB 全 null 批次无法推断 Arrow 列类型:种子行锚定 expiration_at 类型 + 迁移列显式 CAST(NULL AS DOUBLE)



## [0.2.0] - 2026-11-14

### Added

- **多租户隔离**:`MemoryRecord.namespace` 严格分区(默认 `default`,无继承),四后端下推 + `(namespace, memory_type)` 索引;冲突消解按分区独立;0.1.0 库自动迁移(`PRAGMA user_version` 门控)
- **BM25 全文检索**:`FullTextSearchable` 能力接口 + SQLite FTS5(trigram 分词,中文可用)实现;File/内存后端纯 TS BM25 回退,分词器可注入;短查询 LIKE 回退;MATCH 构造 = 精确短语 OR 英文多词 AND OR 中文滑动三元组
- **混合检索**:`searchHybrid` + `FusionStrategy`(默认 RRF k=60,另有 WeightedFusion);语义路优先原生向量、空结果回退按需嵌入(带 LRU 缓存 `memoizeEmbedder`);`HybridHit` 透传双路信号分
- MCP:全部 tool 加 `namespace` 参数;`search_memory` 加 `mode: keyword|semantic|hybrid`(默认 hybrid);`MEMCORE_NAMESPACE` 环境变量
- CLI:`-n` 分区选项;`search --mode`;stats 按分区内计数
- Dashboard:namespace 切换输入框,全部 API 带 `?ns=`



All notable changes to memcore are documented here. Format follows Keep a Changelog; versioning follows SemVer.

## [0.1.0] - 2026-11-14

### Added

- **策略内核**(`@memcore/core`)
  - `MemoryStore` 全异步存储接口:内存 / SQLite / 纯文件三种内嵌后端,行为逐断言一致
  - `MemoryStrategy`:时间衰减(指数半衰期)、访问频率晋升、`CompositeStrategy` 组合加权
  - `ConflictResolver`:LastWriteWins / ImportanceMerge / `SimilarityConflictResolver`(嵌入相似度判定)
  - `TrigramEmbedder`:零依赖、确定性的字符三元组嵌入(近似重复检测)
  - `VectorSearchable` 语义检索接口 + `cosineTopK` 参考实现
  - 后端注册表:`registerBackend` / `openStore`,支持第三方后端零代码改动接入
  - 召回质量测试集:20 个真实场景,确定性、无 LLM,100% 通过
- **MCP server**(`@memcore/mcp`):`add_memory` / `search_memory` / `search_semantic` / `rank_memory` / `memory_stats` 五个 tool,stdio 传输
- **CLI**(`@memcore/cli`):`mem add / search / top / stats`,`-b` 任意后端
- **后端包**:`@memcore/lancedb`(原生向量检索)、`@memcore/pg`(pgvector `<=>` 算子,无扩展时 JSONB 降级)
- **本地嵌入**(`@memcore/embed-local`):transformers.js ONNX(ALL-MiniLM-L6-v2 q8),离线运行;`MEMCORE_EMBED=local` 开启后 MCP 写入消解升级为语义判定,`search_semantic` 真实模型排序
- **向量检索**:`VectorSearchable` 接口,LanceDB / pg / 内存三路实现;MCP `search_semantic` 按需嵌入,任意后端可用
- **后端注册表**:`registerBackend` / `openStore` + 动态加载,第三方后端零代码改动接入
- 端到端验收:同一组操作在 sqlite / file / lancedb 三个后端输出完全一致

[0.1.0]: https://github.com/YOURNAME/memcore/releases/tag/v0.1.0
