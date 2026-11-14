import { pipeline, env } from "@huggingface/transformers";
import type { EmbeddingFn } from "@memcore/core";

/**
 * 本地 ONNX 嵌入器:首次使用时下载并缓存模型到本地,之后完全离线运行。
 * 默认 Xenova/all-MiniLM-L6-v2(384 维,量化后约 23MB,句级语义相似度效果好)。
 * 与 @memcore/core 的 EmbeddingFn 接口兼容,可直接注入 SimilarityConflictResolver
 * 或 VectorSearchable 后端的 setEmbedding。
 */
export class LocalEmbedder {
  private extractor?: Promise<
    (text: string, opts: { pooling: "mean"; normalize: boolean }) => Promise<{ data: Float32Array }>
  >;

  constructor(
    public model = "Xenova/all-MiniLM-L6-v2",
    public cacheDir?: string,
    /** 默认 q8 量化:体积约为 fp32 的 1/4,CPU 推理更快,精度损失可忽略 */
    public dtype: "fp32" | "q8" = "q8",
  ) {
    if (cacheDir) env.cacheDir = cacheDir;
    // Node 环境下禁用本地模型目录探测,直接走远程下载 + 本地缓存
    env.allowLocalModels = false;
  }

  private async load() {
    this.extractor ??= pipeline("feature-extraction", this.model, {
      dtype: this.dtype,
    }) as never as Promise<
      (text: string, opts: { pooling: "mean"; normalize: boolean }) => Promise<{ data: Float32Array }>
    >;
    return this.extractor;
  }

  async embed(text: string): Promise<number[]> {
    const extractor = await this.load();
    const output = await extractor(text, { pooling: "mean", normalize: true });
    return Array.from(output.data);
  }

  /** EmbeddingFn 形态,便于直接注入 core 的策略与后端。 */
  asFn(): EmbeddingFn {
    return (text) => this.embed(text);
  }
}

/** 便捷工厂:`const embed = localEmbed();` */
export function localEmbed(model?: string): EmbeddingFn {
  return new LocalEmbedder(model).asFn();
}
