import { useCallback, useEffect, useState } from "react";
import { api } from "./api.js";
import type { ConfigDto, MemoryRecordDto, StatsDto } from "./api.js";

const TYPES = ["fact", "episodic", "semantic", "procedural"] as const;

type Tab = "records" | "top" | "semantic";

export default function App() {
  const [config, setConfig] = useState<ConfigDto | null>(null);
  const [stats, setStats] = useState<StatsDto | null>(null);
  const [records, setRecords] = useState<MemoryRecordDto[]>([]);
  const [ranked, setRanked] = useState<MemoryRecordDto[]>([]);
  const [tab, setTab] = useState<Tab>("records");
  const [q, setQ] = useState("");
  const [typeFilter, setTypeFilter] = useState("");
  const [newContent, setNewContent] = useState("");
  const [newType, setNewType] = useState<string>("fact");
  const [semanticQuery, setSemanticQuery] = useState("");
  const [semanticHits, setSemanticHits] = useState<MemoryRecordDto[] | null>(null);
  const [namespace, setNamespace] = useState("default");
  const [error, setError] = useState("");

  const refresh = useCallback(async () => {
    try {
      setError("");
      const [c, s, r, t] = await Promise.all([
        api.config(),
        api.stats(namespace),
        api.records(q || undefined, typeFilter || undefined, namespace),
        api.top(20, namespace),
      ]);
      setConfig(c);
      setStats(s);
      setRecords(r);
      setRanked(t);
    } catch (e) {
      setError(String(e));
    }
  }, [q, typeFilter, namespace]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const add = async () => {
    if (!newContent.trim()) return;
    await api.add(newContent.trim(), newType, undefined, namespace);
    setNewContent("");
    await refresh();
  };

  const remove = async (id: string) => {
    await api.remove(id);
    await refresh();
  };

  const bump = async (id: string) => {
    await api.touch(id);
    await refresh();
  };

  const setImportance = async (id: string, v: number) => {
    await api.setImportance(id, Math.min(1, Math.max(0, v)));
    await refresh();
  };

  const semanticSearch = async () => {
    if (!semanticQuery.trim()) return;
    try {
      setSemanticHits(await api.semantic(semanticQuery.trim(), 10));
    } catch (e) {
      setError(String(e));
    }
  };

  return (
    <div className="app">
      <header>
        <h1>memcore</h1>
        <span className="subtitle">
          {config ? `backend: ${config.backend} · db: ${config.dbPath}` : "loading…"}
        </span>
        <div className="add-row" style={{ marginTop: 8 }}>
          <input
            placeholder="namespace(user:alice / proj:x …)"
            value={namespace}
            onChange={(e) => setNamespace(e.target.value.trim() || "default")}
            style={{ maxWidth: 280 }}
          />
        </div>
        {stats && (
          <div className="stats">
            <span className="stat total">total {stats.total}</span>
            {TYPES.map((t) => (
              <button key={t} className={`stat ${typeFilter === t ? "active" : ""}`} onClick={() => setTypeFilter(typeFilter === t ? "" : t)}>
                {t} {stats.byType[t] ?? 0}
              </button>
            ))}
            <span className={`badge ${stats.vector ? "ok" : ""}`}>
              {stats.vector ? "vector search ✓" : "no vector"}
            </span>
          </div>
        )}
      </header>

      {error && <div className="error">{error}</div>}

      <nav>
        {(["records", "top", "semantic"] as Tab[]).map((t) => (
          <button key={t} className={tab === t ? "active" : ""} onClick={() => setTab(t)}>
            {t === "records" ? "记忆列表" : t === "top" ? "策略排序" : "语义检索"}
          </button>
        ))}
      </nav>

      {tab === "records" && (
        <section>
          <div className="toolbar">
            <input placeholder="关键词过滤…" value={q} onChange={(e) => setQ(e.target.value)} />
            <button className="ghost" onClick={() => setTypeFilter("")}>
              清除过滤
            </button>
          </div>
          <div className="add-row">
            <input
              placeholder="写入一条新记忆(自动冲突消解)…"
              value={newContent}
              onChange={(e) => setNewContent(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && void add()}
            />
            <select value={newType} onChange={(e) => setNewType(e.target.value)}>
              {TYPES.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
            <button onClick={() => void add()}>写入</button>
          </div>
          <table>
            <thead>
              <tr>
                <th>内容</th>
                <th>类型</th>
                <th>重要性</th>
                <th>读取</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {records.map((r) => (
                <tr key={r.id} style={r.expirationAt && r.expirationAt * 1000 < Date.now() ? { opacity: 0.45 } : undefined}>
                  <td className="content">
                    {r.content}
                    {r.expirationAt && r.expirationAt * 1000 < Date.now() && (
                      <span className="tag" style={{ marginLeft: 6, color: "var(--danger)" }}>
                        expired
                      </span>
                    )}
                  </td>
                  <td>
                    <span className={`tag ${r.memoryType}`}>{r.memoryType}</span>
                  </td>
                  <td>
                    <input
                      className="imp"
                      type="number"
                      min={0}
                      max={1}
                      step={0.1}
                      value={r.importance}
                      onChange={(e) => void setImportance(r.id, Number(e.target.value))}
                    />
                  </td>
                  <td>{r.accessCount}</td>
                  <td className="row-actions">
                    <button className="ghost" onClick={() => void bump(r.id)}>
                      +access
                    </button>
                    <button className="danger" onClick={() => void remove(r.id)}>
                      删除
                    </button>
                  </td>
                </tr>
              ))}
              {records.length === 0 && (
                <tr>
                  <td colSpan={5} className="empty">
                    (no records)
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </section>
      )}

      {tab === "top" && (
        <section>
          <p className="hint">
            按组合策略(时间衰减 + 访问频率)排序 —— "现在最值得注入 Agent 上下文的记忆"
          </p>
          <ol className="ranked">
            {ranked.map((r) => (
              <li key={r.id}>
                <div className="score-bar" style={{ width: `${Math.min(100, (r.score ?? 0) * 200)}%` }} />
                <span className="score">{(r.score ?? 0).toFixed(3)}</span>
                <span className={`tag ${r.memoryType}`}>{r.memoryType}</span>
                <span className="content">{r.content}</span>
                <span className="meta">reads={r.accessCount}</span>
              </li>
            ))}
            {ranked.length === 0 && <li className="empty">(empty)</li>}
          </ol>
        </section>
      )}

      {tab === "semantic" && (
        <section>
          <p className="hint">
            语义检索:查询文本 → 嵌入向量 → Top-K 相似记忆
            {!config?.vector && "(当前后端不支持,请用 lancedb / pg / memory)"}
          </p>
          <div className="add-row">
            <input
              placeholder="语义查询,如 dark theme preference…"
              value={semanticQuery}
              onChange={(e) => setSemanticQuery(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && void semanticSearch()}
            />
            <button onClick={() => void semanticSearch()}>检索</button>
          </div>
          <ol className="ranked">
            {(semanticHits ?? []).map((h) => (
              <li key={h.id}>
                <div className="score-bar" style={{ width: `${Math.min(100, (h.score ?? 0) * 100)}%` }} />
                <span className="score">{(h.score ?? 0).toFixed(3)}</span>
                <span className={`tag ${h.memoryType}`}>{h.memoryType}</span>
                <span className="content">{h.content}</span>
              </li>
            ))}
            {semanticHits && semanticHits.length === 0 && <li className="empty">(no hits)</li>}
          </ol>
        </section>
      )}
    </div>
  );
}
