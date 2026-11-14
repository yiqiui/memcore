# Changelog

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
