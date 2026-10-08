/** Local ONNX inference. Imported only by the isolated child and explicit preparation/evaluation commands. */
import { AutoTokenizer, env, pipeline } from '@huggingface/transformers'
import { EMBEDDING_MODELS, type EmbeddingModelName } from './embedding-catalog.ts'
import { verifyEmbeddingFiles } from './embedding-files.ts'

export async function loadLocalEmbedder(
  name: EmbeddingModelName,
  cacheDir: string,
  prepare = false,
) {
  const model = EMBEDDING_MODELS[name]
  env.cacheDir = cacheDir
  // Runtime inference cannot download a model, send text anywhere, or silently select a newer revision.
  env.allowRemoteModels = prepare
  env.allowLocalModels = true
  const location = prepare ? model.id : `${cacheDir}/${model.id}/${model.revision}`
  if (!prepare) await verifyEmbeddingFiles(location, model)
  const extractor = await pipeline('feature-extraction', location, {
    revision: model.revision,
    dtype: 'q8',
    device: 'cpu',
    session_options: { intraOpNumThreads: 2, interOpNumThreads: 1 },
  })
  // v4 pipeline discovers the tokenizer via the remote file list; supply the cached tokenizer explicitly offline.
  if (!extractor.tokenizer)
    extractor.tokenizer = await AutoTokenizer.from_pretrained(location, {
      revision: model.revision,
      local_files_only: !prepare,
    })
  return {
    modelVersion: model.version,
    dimension: model.dimension,
    async embed(text: string, purpose: 'query' | 'document'): Promise<number[]> {
      const instruction = (chunk: string) =>
        purpose === 'query'
          ? name === 'qwen'
            ? `Instruct: 检索与问题相关的聊天消息或个人记忆。\nQuery: ${chunk}`
            : `为这个句子生成表示以用于检索相关文章：${chunk}`
          : chunk
      const points = [...text]
      const vector = Array<number>(model.dimension).fill(0)
      // Long messages contribute every span. Bound each inference rather than silently dropping a tail fact.
      for (let offset = 0; offset < points.length; offset += 384) {
        const output = await extractor(instruction(points.slice(offset, offset + 384).join('')), {
          pooling: model.pooling,
          normalize: true,
        })
        for (let i = 0; i < vector.length; i++)
          vector[i] = (vector[i] ?? 0) + Number(output.data[i] ?? 0)
      }
      const norm = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0))
      for (let i = 0; i < vector.length; i++) vector[i] = (vector[i] ?? 0) / norm
      if (vector.length !== model.dimension || vector.some((v) => !Number.isFinite(v)))
        throw new Error('invalid local embedding')
      return vector
    },
    async close() {
      await extractor.dispose()
    },
  }
}
