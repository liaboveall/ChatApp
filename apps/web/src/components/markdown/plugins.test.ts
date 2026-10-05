import { describe, expect, test } from 'vitest'
import { cjkAutolinkBoundary, type MdNode, restrictToSubset, softBreaks } from './plugins.ts'

const text = (value: string): MdNode => ({ type: 'text', value })
const root = (...children: MdNode[]): MdNode => ({ type: 'root', children })
const para = (...children: MdNode[]): MdNode => ({ type: 'paragraph', children })
const at = (start: number, end: number): MdNode['position'] => ({
  start: { offset: start },
  end: { offset: end },
})
/** The position of the first occurrence of `needle` in `source`. */
const spanOf = (source: string, needle: string): MdNode['position'] => {
  const start = source.indexOf(needle)
  return at(start, start + needle.length)
}

describe('cjkAutolinkBoundary', () => {
  const link = (url: string, label = url): MdNode => ({
    type: 'link',
    url,
    children: [text(label)],
  })

  test('cuts an automatic link at the first CJK character, and the rest becomes text', () => {
    const tree = root(para(link('https://example.com/docs然后继续')))
    cjkAutolinkBoundary()(tree)
    const [paragraph] = tree.children ?? []
    expect(paragraph?.children).toEqual([
      {
        type: 'link',
        url: 'https://example.com/docs',
        children: [text('https://example.com/docs')],
      },
      text('然后继续'),
    ])
  })

  test('cuts at full-width punctuation too', () => {
    const tree = root(para(link('https://example.com/a，谢谢')))
    cjkAutolinkBoundary()(tree)
    expect(tree.children?.[0]?.children?.[1]).toEqual(text('，谢谢'))
  })

  test('a link that starts with a CJK character is not a link', () => {
    const tree = root(para(link('http://中文.example', '中文.example')))
    cjkAutolinkBoundary()(tree)
    expect(tree.children?.[0]?.children).toEqual([text('中文.example')])
  })

  test('a link the person wrote with their own label is left alone', () => {
    const own: MdNode = { type: 'link', url: 'https://example.com', children: [text('点这里')] }
    const tree = root(para(own))
    cjkAutolinkBoundary()(tree)
    expect(tree.children?.[0]?.children).toEqual([own])
  })

  test('recognises www. and mail autolinks by their implied scheme', () => {
    const www = root(para(link('http://www.example.com中文', 'www.example.com中文')))
    cjkAutolinkBoundary()(www)
    expect(www.children?.[0]?.children?.[0]).toMatchObject({
      type: 'link',
      url: 'http://www.example.com',
    })
    const mail = root(para(link('mailto:a@example.com谢谢', 'a@example.com谢谢')))
    cjkAutolinkBoundary()(mail)
    expect(mail.children?.[0]?.children?.[1]).toEqual(text('谢谢'))
  })
})

describe('restrictToSubset', () => {
  const run = (tree: MdNode, source = ''): MdNode => {
    restrictToSubset()(tree, { value: source })
    return tree
  }

  test('keeps every node type the product allows', () => {
    const tree = root(
      para(
        text('a'),
        { type: 'strong', children: [text('b')] },
        { type: 'emphasis', children: [text('c')] },
        { type: 'delete', children: [text('d')] },
        { type: 'inlineCode', value: 'e' },
        { type: 'break' },
        { type: 'link', url: 'https://x.test', children: [text('f')] },
      ),
      { type: 'code', value: 'g' },
      { type: 'blockquote', children: [para(text('h'))] },
      { type: 'list', children: [{ type: 'listItem', children: [para(text('i'))] }] },
    )
    const before = JSON.stringify(tree)
    expect(JSON.stringify(run(tree))).toBe(before)
  })

  test('a heading becomes a paragraph with the same words', () => {
    const tree = run(root({ type: 'heading', depth: 2, children: [text('Title')] }))
    expect(tree.children?.[0]).toMatchObject({ type: 'paragraph', children: [text('Title')] })
    expect(tree.children?.[0]?.depth).toBeUndefined()
  })

  test('a table, a rule, a footnote definition and a definition are shown as the text that was typed', () => {
    const source = '| a | b |\n|---|---|\n\n---\n\n[^1]: note\n\n[x]: https://x.test'
    const tree = run(
      root(
        { type: 'table', position: spanOf(source, '| a | b |\n|---|---|'), children: [] },
        {
          type: 'thematicBreak',
          position:
            spanOf(source, '---\n\n[^1]') &&
            at(source.indexOf('---\n\n[^1]'), source.indexOf('---\n\n[^1]') + 3),
        },
        {
          type: 'footnoteDefinition',
          position: spanOf(source, '[^1]: note'),
          children: [para(text('note'))],
        },
        { type: 'definition', position: spanOf(source, '[x]: https://x.test') },
      ),
      source,
    )
    expect(tree.children?.map((c) => [c.type, c.children?.[0]?.value])).toEqual([
      ['paragraph', '| a | b |\n|---|---|'],
      ['paragraph', '---'],
      ['paragraph', '[^1]: note'],
      ['paragraph', '[x]: https://x.test'],
    ])
  })

  test('inline references and raw HTML inside a paragraph become text in place', () => {
    const source = 'see [^1] and <b>bold</b> and [a][b]'
    const tree = run(
      root(
        para(
          text('see '),
          { type: 'footnoteReference', position: spanOf(source, '[^1]') },
          text(' and '),
          { type: 'html', value: '<b>', position: spanOf(source, '<b>') },
          text('bold'),
          { type: 'html', value: '</b>', position: spanOf(source, '</b>') },
          text(' and '),
          { type: 'linkReference', position: spanOf(source, '[a][b]'), children: [text('a')] },
        ),
      ),
      source,
    )
    expect(tree.children?.[0]?.children?.map((c) => [c.type, c.value])).toEqual([
      ['text', 'see '],
      ['text', '[^1]'],
      ['text', ' and '],
      ['text', '<b>'],
      ['text', 'bold'],
      ['text', '</b>'],
      ['text', ' and '],
      ['text', '[a][b]'],
    ])
  })

  test('a task list keeps its markers as text instead of becoming checkboxes', () => {
    const done: MdNode = { type: 'listItem', checked: true, children: [para(text('done'))] }
    const todo: MdNode = { type: 'listItem', checked: false, children: [para(text('todo'))] }
    const plain: MdNode = { type: 'listItem', checked: null, children: [para(text('plain'))] }
    run(root({ type: 'list', children: [done, todo, plain] }))
    expect(done.children?.[0]?.children?.map((c) => c.value).join('')).toBe('[x] done')
    expect(todo.children?.[0]?.children?.map((c) => c.value).join('')).toBe('[ ] todo')
    expect(done.checked).toBeNull()
    expect(plain.children?.[0]?.children?.[0]?.value).toBe('plain')
  })

  test('an item that is only a checkbox still shows its marker', () => {
    const empty: MdNode = { type: 'listItem', checked: false, children: [] }
    run(root({ type: 'list', children: [empty] }))
    expect(empty.children?.[0]?.children?.[0]?.value).toBe('[ ]')
  })

  test('a node type nobody has heard of is text, whatever a future plugin invents', () => {
    const tree = run(
      root({ type: 'someNewThing', position: at(0, 5), children: [text('x')] }),
      'hello',
    )
    expect(tree.children?.[0]).toEqual({ type: 'paragraph', children: [text('hello')] })
  })

  test('nothing inside a replaced node is visited again', () => {
    const tree = run(
      root({
        type: 'table',
        position: at(0, 3),
        children: [{ type: 'heading', children: [text('x')] }],
      }),
      'abc',
    )
    expect(JSON.stringify(tree)).not.toContain('heading')
  })
})

describe('softBreaks', () => {
  test('a line break inside text becomes a break node', () => {
    const tree = root(para(text('one\ntwo\nthree')))
    softBreaks()(tree)
    expect(tree.children?.[0]?.children).toEqual([
      text('one'),
      { type: 'break' },
      text('two'),
      { type: 'break' },
      text('three'),
    ])
  })

  test('leading and trailing line breaks do not leave empty text', () => {
    const tree = root(para(text('\nafter'), { type: 'strong', children: [text('b\n')] }))
    softBreaks()(tree)
    expect(tree.children?.[0]?.children?.[0]).toEqual({ type: 'break' })
    expect(tree.children?.[0]?.children?.[1]).toEqual(text('after'))
    expect(tree.children?.[0]?.children?.[2]?.children).toEqual([text('b'), { type: 'break' }])
  })

  test('code is left exactly as it is', () => {
    const tree = root({ type: 'code', value: 'a\nb' }, para({ type: 'inlineCode', value: 'c\nd' }))
    softBreaks()(tree)
    expect(tree.children?.[0]?.value).toBe('a\nb')
    expect(tree.children?.[1]?.children?.[0]?.value).toBe('c\nd')
  })

  test('text without a line break is untouched', () => {
    const tree = root(para(text('plain')))
    softBreaks()(tree)
    expect(tree.children?.[0]?.children).toEqual([text('plain')])
  })
})
