import { describe, expect, test } from 'bun:test'
import { markdownPreviewText } from './markdown-text.ts'

describe('Markdown conversation previews', () => {
  test('extracts the screenshot titles and joins paragraphs, quotes and lists into one line', () => {
    expect(
      markdownPreviewText(
        '**当前会话总结**\n\n> **周六爬山计划总结**\n\n- **时间**：八点\n- 地点：地铁站',
      ),
    ).toBe('当前会话总结 周六爬山计划总结 时间：八点 地点：地铁站')
    expect(markdownPreviewText('# 标题\n\n1. 第一项\n2. 第二项')).toBe('标题 第一项 第二项')
  })

  test('uses CJK emphasis and strikethrough rules without splitting inline words', () => {
    expect(markdownPreviewText('中文**加粗**，*斜体*和~~旧计划~~。')).toBe(
      '中文加粗，斜体和旧计划。',
    )
  })

  test('keeps literal code and escaped punctuation rather than erasing stars with a regex', () => {
    expect(markdownPreviewText('`**literal**` 与 \\*\\*原样\\*\\*')).toBe('**literal** 与 **原样**')
    expect(markdownPreviewText('```js\nconst value = "**literal**";\n```\n\n完成')).toBe(
      'const value = "**literal**"; 完成',
    )
  })

  test('keeps link and image labels without their destinations', () => {
    expect(
      markdownPreviewText(
        '阅读[**文档**](https://example.com)和![路线图](https://example.com/map.png)',
      ),
    ).toBe('阅读文档和路线图')
  })

  test('preserves mention tokens for name resolution after parsing', () => {
    const token = '<@user:00000000-0000-4000-8000-000000000002>'
    expect(markdownPreviewText(`**请 ${token} 确认**`)).toBe(`请 ${token} 确认`)
  })

  test('HTML and unsupported references remain literal, and empty bodies retain their meaning', () => {
    expect(markdownPreviewText('<script>alert(1)</script>')).toBe('<script>alert(1)</script>')
    expect(markdownPreviewText('[文档][ref]\n\n[ref]: https://example.com')).toBe(
      '[文档][ref] [ref]: https://example.com',
    )
    expect(markdownPreviewText(null)).toBeNull()
    expect(markdownPreviewText('')).toBe('')
    expect(markdownPreviewText('普通聊天\n  第二行')).toBe('普通聊天 第二行')
  })
})
