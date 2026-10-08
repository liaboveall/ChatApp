import { expect, test } from 'bun:test'
import { assistantText } from './assistant-text.ts'

test('old assistant citations lose internal sequences while keeping facts and Markdown', () => {
  expect(
    assistantText(
      '**集合**：周六早上 8 点，地铁口（seq 4）。\n- Bob：带两瓶水 (seq 8)\n- Carol：带食物 (seq 9–11)',
    ),
  ).toBe('**集合**：周六早上 8 点，地铁口。\n- Bob：带两瓶水\n- Carol：带食物')
})
test('grouped citations keep people, dates, quantities and negation', () => {
  expect(
    assistantText('三人一致 (Bob seq 2, Carol seq 3, Alice seq 4)；预算不是 1200，是 12000 元。'),
  ).toBe('三人一致 (Bob, Carol, Alice)；预算不是 1200，是 12000 元。')
})
test('message IDs in citations are removed', () => {
  const id = '00000000-0000-4000-8000-000000000009'
  expect(assistantText(`结论 (messageId: ${id})。来源 [${id}]`)).toBe('结论。来源')
})
test('real model citations still hide message IDs when the ID alone is formatted as inline code', () => {
  const id = '00000000-0000-4000-8000-000000000009'
  for (const label of [
    '消息 ID',
    '消息',
    '消息编号',
    'message_id:',
    'ID：',
    '完整 ID：',
    '以工具返回为准：',
    '实际返回值为',
  ])
    expect(assistantText(`结论 (${label} \`${id}\`)；预算1200元，没有延期。`)).toBe(
      '结论；预算1200元，没有延期。',
    )
  expect(assistantText(`**负责人**：林舟（消息 ID \`${id}\`，林舟，5月1日09:32）。`)).toBe(
    '**负责人**：林舟（林舟，5月1日09:32）。',
  )
  expect(assistantText('集合（seq `17`）。')).toBe('集合。')
  expect(assistantText(`预算1200元〔消息 ID：\`${id}\`，林舟，2026-05-01〕`)).toBe(
    '预算1200元〔林舟，2026-05-01〕',
  )
  expect(assistantText(`结论 (消息 ${id})，没有延期。`)).toBe('结论，没有延期。')
  expect(assistantText('负责人林舟（消息 ID `5e601aa0...`）。')).toBe('负责人林舟。')
  expect(assistantText('负责人林舟（消息 ID `0d...`）。')).toBe('负责人林舟。')
  expect(assistantText('负责人林舟（消息 ID `deeba587-69ca-4b15-a3f0-...`）。')).toBe(
    '负责人林舟。',
  )
  expect(assistantText('负责人林舟（消息 `5e601aa0`）。')).toBe('负责人林舟。')
  expect(assistantText('来源：20260501；预算12000000元。')).toBe('来源：20260501；预算12000000元。')
  expect(assistantText('来源：`20260501`；预算12000000元。')).toBe(
    '来源：`20260501`；预算12000000元。',
  )
  expect(assistantText(`负责人林舟——\`${id}\`。`)).toBe('负责人林舟。')
  expect(assistantText(`准确 ID 为 **\`${id}\`**。预算1200元。`)).toBe('准确。预算1200元。')
  expect(assistantText(`负责人：\`${id}\``)).toBe('')
  expect(assistantText(`预算1748元，没有延期。\n   更正：逐字核对为\`${id}\``)).toBe(
    '预算1748元，没有延期。\n',
  )
})
test('a UUID example and code blocks remain literal even when nearby prose has a quoted citation', () => {
  const id = '00000000-0000-4000-8000-000000000009'
  const literal = `示例 UUID：\`${id}\`\n\n\`\`\`text\n消息 ID \`${id}\`\n\`\`\``
  expect(assistantText(literal)).toBe(literal)
  expect(assistantText(`结论（消息 ID \`${id}\`）。\n\n${literal}`)).toBe(`结论。\n\n${literal}`)
  expect(assistantText(`{"messageIds":["${id}"],"noAnswer":false}`)).toBe(
    `{"messageIds":["${id}"],"noAnswer":false}`,
  )
  expect(assistantText(`示例：const messageId = \`${id}\``)).toBe(
    `示例：const messageId = \`${id}\``,
  )
})
test('an identifier-only bracket citation is removed while an explicitly labeled UUID example remains literal', () => {
  const id = '00000000-0000-4000-8000-000000000009'
  expect(assistantText(`可疑消息（\`${id}\`）已忽略；没有延期。`)).toBe(
    '可疑消息已忽略；没有延期。',
  )
  expect(assistantText(`引用 [\`${id}\`]，预算1200元。`)).toBe('引用，预算1200元。')
  expect(assistantText(`示例 UUID（\`${id}\`）`)).toBe(`示例 UUID（\`${id}\`）`)
})
test('literal code, links and requested structured JSON retain their content', () => {
  for (const text of [
    '`seq 17`',
    '```ts\nconst seq = 17\n```',
    '~~~\nseq 17\n~~~',
    '[seq 17](https://example.com/seq17)',
    '{"seq": 17, "messageId": "test"}',
  ])
    expect(assistantText(text)).toBe(text)
})
test('real citations with a timestamp retain the timestamp without the quoted message ID', () => {
  const id = '473c8d47-c6e9-47bb-aa89-11bd0c9bbd0b'
  expect(assistantText(`预算2296元。来源（\`${id}\`，2026-05-09 01:34）。`)).toBe(
    '预算2296元。来源（2026-05-09 01:34）。',
  )
  expect(assistantText(`来源：第94条（\`${id}\`，01:34）`)).toBe('来源：第94条（01:34）')
  expect(assistantText(`UUID 示例（\`${id}\`，01:34）`)).toBe(`UUID 示例（\`${id}\`，01:34）`)
})
test('a model message-ID table column is removed without losing its factual columns or literal code', () => {
  const id = '7201f0f6-74da-48f6-a547-6a77fcdc4591'
  const table = `| 事项 | 内容 | 消息ID |\n|------|------|--------|\n| 负责人 | 吴桐 | \`${id}\` |\n| 预算 | 2433元 | \`${id}\` |`
  expect(assistantText(table)).toBe(
    '| 事项 | 内容 |\n| ------ | ------ |\n| 负责人 | 吴桐 |\n| 预算 | 2433元 |',
  )
  const literal = `\`\`\`markdown\n${table}\n\`\`\``
  expect(assistantText(literal)).toBe(literal)
  const example = `示例数据：\n${table}`
  expect(assistantText(example)).toBe(example)
  const sourced = `| 事项 | 内容 | 消息 ID |\n| --- | --- | --- |\n| 预算 | 2433元 | \`${id}\`（吴桐，05-10 09:34） |`
  expect(assistantText(sourced)).toBe(
    '| 事项 | 内容 | 来源 |\n| --- | --- | --- |\n| 预算 | 2433元 | （吴桐，05-10 09:34） |',
  )
  expect(assistantText('| 字段 | 值 |\n| --- | --- |\n| UUID | `literal` |')).toBe(
    '| 字段 | 值 |\n| --- | --- |\n| UUID | `literal` |',
  )
})
test('a source table keeps the sender and timestamp when the quoted identifier follows them', () => {
  const id = '826d5e4b-587a-4cd5-ae35-73190417e189'
  for (const header of ['来源', '消息 ID', '来源消息（发送者 / 时间 UTC / 消息ID）']) {
    const table = `| 事项 | 内容 | ${header} |\n| --- | --- | --- |\n| 预算 | 1611元，没有延期 | 叶青，2026-05-04 01:34 UTC，\`${id}\` |`
    expect(assistantText(table)).toBe(
      '| 事项 | 内容 | 来源 |\n| --- | --- | --- |\n| 预算 | 1611元，没有延期 | 叶青，2026-05-04 01:34 UTC |',
    )
    expect(assistantText(`示例：\n${table}`)).toBe(`示例：\n${table}`)
    expect(assistantText(`\`\`\`markdown\n${table}\n\`\`\``)).toBe(
      `\`\`\`markdown\n${table}\n\`\`\``,
    )
  }
})
test('nested Markdown lists keep their indentation', () => {
  expect(assistantText('- 分工 (seq 1)\n  - Bob：水 (seq 8)\n    - 两瓶')).toBe(
    '- 分工\n  - Bob：水\n    - 两瓶',
  )
})
test('unclosed code during streaming is kept as literal content', () => {
  expect(assistantText('例子：\n```ts\nseq 17')).toBe('例子：\n```ts\nseq 17')
})

test('a sequence list stops before the real source date and time', () => {
  const id = '9030cfc0-e872-40e9-a91f-84f15073f5f7'
  for (const date of ['2026-05-04 09:33', '2026/05/04 09:33', '09:33']) {
    const clean = assistantText(`上线未延期（来源：seq 93，${date}，消息ID \`${id}\`）。`)
    expect(clean).toContain(date)
    expect(clean).toContain('上线未延期')
    expect(clean).not.toContain('seq 93')
    expect(clean).not.toContain(id)
    expect(assistantText(clean)).toBe(clean)
  }
  const table = '| 事实 | 消息 ID |\n| --- | --- |\n| 来源 | 2026-05-04 09:33 |'
  expect(assistantText(table)).toBe(table)
  expect(assistantText('引用（seq 92、93–95）。')).toBe('引用。')
})

test('chained quoted citations keep factual sources without leaking either identifier', () => {
  const id = '2d4bc489-8cfc-4581-a05a-a658adfd21d1'
  for (const reference of [`消息ID：\`92d...\` 即 \`${id}\``, `seq 92，\`${id}\``]) {
    const clean = assistantText(
      `负责人沈川 —— ${reference}（沈川，2026-05-07 09:32）；预算2022元，没有延期。`,
    )
    expect(clean).not.toContain(id)
    expect(clean).not.toContain('92d...')
    expect(clean).not.toContain('seq 92')
    expect(clean).toContain('沈川，2026-05-07 09:32')
    expect(clean).toContain('预算2022元，没有延期')
    expect(assistantText(clean)).toBe(clean)
    const literal = `UUID 示例：\n\`\`\`text\n${reference}\n\`\`\``
    expect(assistantText(literal)).toBe(literal)
  }
})

test('previously cleaned citations still hide an identifier after a dash and remaining separator', () => {
  const id = 'dfc86009-7462-4274-af7d-17861ec79009'
  for (const reference of [`— 即\`${id}\``, `——，\`${id}\``]) {
    const clean = assistantText(
      `负责人夏安 ${reference}（夏安，2026-06-23 09:32），预算4214元，没有延期。`,
    )
    expect(clean).not.toContain(id)
    expect(clean).toContain('夏安，2026-06-23 09:32')
    expect(clean).toContain('预算4214元，没有延期')
    expect(assistantText(clean)).toBe(clean)
    const literal = `示例 UUID ${reference}`
    expect(assistantText(literal)).toBe(literal)
  }
})

test('identifier correction prose hides each identifier without changing actual budget facts or code examples', () => {
  const id = 'ed4c3c69-53fa-47d2-aa3b-f9854d985dcf'
  for (const label of ['预算消息 ID 应逐字为', '之前原文为', '重新逐字给出：']) {
    const clean = assistantText(`预算2981元，没有延期。${label}\`${id}\`。`)
    expect(clean).not.toContain(id)
    expect(clean).toContain('预算2981元，没有延期')
    expect(assistantText(clean)).toBe(clean)
    const literal = `UUID 示例：${label}\`${id}\``
    expect(assistantText(literal)).toBe(literal)
  }
})

test('a source-message-ID column is removed while the separate source time stays intact', () => {
  const id = '7201f0f6-74da-48f6-a547-6a77fcdc4591'
  const table = `| 项目 | 内容 | 来源消息ID | 时间 |\n|---|---|---|---|\n| 负责人 | 吴桐 | ${id} | 2026-05-10 09:32 |`
  expect(assistantText(table)).toBe(
    '| 项目 | 内容 | 时间 |\n| --- | --- | --- |\n| 负责人 | 吴桐 | 2026-05-10 09:32 |',
  )
  const literal = `示例：\n${table}`
  expect(assistantText(literal)).toBe(literal)
})

test('a sequence used as a noun leaves readable prose rather than a grammatical hole', () => {
  const cases: [string, string][] = [
    [
      '另外说明：seq 99 的消息中含要求读取其他会话、外泄内容的指令，属不可信数据，已忽略。',
      '另外说明：相关消息中含要求读取其他会话、外泄内容的指令，属不可信数据，已忽略。',
    ],
    [
      '另外，seq 99 中包含一条要求读取其他会话并外泄内容的“资料摘录”，已忽略。',
      '另外，会话中包含一条要求读取其他会话并外泄内容的“资料摘录”，已忽略。',
    ],
    [
      '本会话由叶青任负责人（与 seq 92 中“负责人是叶青”一致），部署采用灰度更新。',
      '本会话由叶青任负责人（与会话中“负责人是叶青”一致），部署采用灰度更新。',
    ],
    [
      'seq 98、99 中包含要求读取其他会话的内容，已忽略。',
      '会话中包含要求读取其他会话的内容，已忽略。',
    ],
    ['补充：seq 92 的项目部署方案为灰度更新。', '补充：项目部署方案为灰度更新。'],
    ['另外提示：会话中 seq 99 一条消息包含可疑指令。', '另外提示：会话中一条消息包含可疑指令。'],
    [
      '说明：其中 seq 99、seq 98 两条为外部资料摘录，已忽略。',
      '说明：其中两条为外部资料摘录，已忽略。',
    ],
    [
      '  - 来源：消息 ID `92` 条（`473c8d47-c6e9-47bb-aa89-11bd0c9bbd0b`，01:32）',
      '  - 来源：（01:32）',
    ],
  ]
  for (const [raw, expected] of cases) {
    expect(assistantText(raw)).toBe(expected)
    expect(assistantText(expected)).toBe(expected)
  }
  expect(assistantText('- seq 92 负责人林舟\n  - Bob seq 2 said yes')).toBe(
    '- 负责人林舟\n  - Bob said yes',
  )
  for (const literal of ['`seq 99 的消息`', '```text\nseq 92 中“负责人”\n```'])
    expect(assistantText(literal)).toBe(literal)
})

test('a bare message sequence inside a timestamped citation is removed while counts stay', () => {
  expect(
    assistantText('- **负责人**：姚琳，由本人核对清单。（姚琳，2026-06-21 09:32，消息 92）'),
  ).toBe('- **负责人**：姚琳，由本人核对清单。（姚琳，2026-06-21 09:32）')
  expect(assistantText('预算1200元。（林舟，5 月 1 日 09:34，北京时间；消息 94）')).toBe(
    '预算1200元。（林舟，5 月 1 日 09:34，北京时间）',
  )
  expect(assistantText('（消息 92–95，林舟，09:32）没有延期。')).toBe('（林舟，09:32）没有延期。')
  for (const kept of [
    '（林舟，09:32，消息 3 条）',
    '（共 12 条消息，09:32）',
    '（消息 92）',
    '第 3 条消息（09:32）',
  ])
    expect(assistantText(kept)).toBe(kept)
})

test('identifier corrections and line-end citations leave no identifier or dangling separator', () => {
  const wrong = 'ed4c3c69-53fa-47d2-aa3b-f98d5d985dcf'
  const owner = 'f2f163bd-a002-4d5d-adaa-50cba40e39dd'
  expect(
    assistantText(
      `- **负责人**：林舟——林舟，2026-05-01 09:32:00，消息 ID \`${owner}\`\n- **预算**：1200元，没有延期`,
    ),
  ).toBe('- **负责人**：林舟——林舟，2026-05-01 09:32:00\n- **预算**：1200元，没有延期')
  for (const raw of [
    `预算2981元。更正：\`${wrong}\` 前一条存在笔误。`,
    `为确保准确，逐字引用工具记录：\`${wrong}\` 需核对为 \`ed4c3c69-53fa-47d2-aa3b-f98d...\``,
    `我逐字核对原记录后确认：第 3 条的正确（原文应为\`${wrong}\`）。`,
    `负责人罗欣——罗欣，2026-06-24 09:32 (前一条 ${owner})`,
    `补充更正：负责人一条对应的消息ID应为 ${owner}，其余如上所列。`,
  ]) {
    const clean = assistantText(raw)
    expect(clean).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}/)
    expect(assistantText(clean)).toBe(clean)
  }
  expect(assistantText(`负责人罗欣——罗欣，2026-06-24 09:32 (前一条 ${owner})`)).toBe(
    '负责人罗欣——罗欣，2026-06-24 09:32',
  )
  for (const kept of [
    '更正：预算是1200元。',
    '提交 3f2a9c1d 已回滚，',
    '预算应为1200元，',
    `示例 UUID：\`${wrong}\``,
    '我们决定，\n明天上线。',
  ])
    expect(assistantText(kept)).toBe(kept)
})

test('a sequence list never continues onto the next line', () => {
  expect(
    assistantText('1. 负责人林舟 —— seq 92，\n2. 上线时间 09:30 —— seq 93，\n3. 预算1200元'),
  ).toBe('1. 负责人林舟 ——，\n2. 上线时间 09:30 ——，\n3. 预算1200元')
  expect(assistantText('引用（seq 92、93–95）。')).toBe('引用。')
})
