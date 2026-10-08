/** Immutable local model revisions. No inference code is imported by the API. */
export const EMBEDDING_MODELS = {
  qwen: {
    id: 'onnx-community/Qwen3-Embedding-0.6B-ONNX',
    revision: 'c25a394dd583836952667c12f008335071b3f43d',
    version: 'qwen3-06b-q8-c25a394d',
    dimension: 1024,
    pooling: 'last_token',
  },
  bge: {
    id: 'Xenova/bge-small-zh-v1.5',
    revision: '75c43b069aac4d136ba6bc1122f995fedcfd2781',
    version: 'bge-small-zh-q8-75c43b06',
    dimension: 512,
    pooling: 'cls',
  },
} as const
export type EmbeddingModelName = keyof typeof EMBEDDING_MODELS
