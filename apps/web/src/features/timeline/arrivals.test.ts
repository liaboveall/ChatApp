import { describe, expect, test } from 'vitest'
import { type ArrivalRow, arrivalsOf } from './arrivals.ts'

const theirs = (id: string): ArrivalRow => ({ key: `m:${id}`, mine: false })
const mine = (id: string): ArrivalRow => ({ key: `m:${id}`, mine: true })
const pending = (id: string): ArrivalRow => ({ key: `o:${id}`, mine: true })
const start: ArrivalRow = { key: 'start', mine: false }

const kinds = (found: ReturnType<typeof arrivalsOf>): Record<string, string> =>
  Object.fromEntries(
    [...found].map(([key, arrival]) => [
      key,
      arrival.kind === 'sent' ? `sent, was ${arrival.from}` : arrival.kind,
    ]),
  )

describe('arrivalsOf', () => {
  test('nothing new, nothing arrives', () => {
    const rows = [start, theirs('1'), mine('2')]
    expect(arrivalsOf(rows, rows).size).toBe(0)
  })

  test('a message at the foot of the list arrives', () => {
    const before = [start, theirs('1')]
    expect(kinds(arrivalsOf(before, [...before, theirs('2')]))).toEqual({ 'm:2': 'new' })
  })

  test('the first message of an empty conversation arrives', () => {
    expect(kinds(arrivalsOf([start], [start, theirs('1')]))).toEqual({ 'm:1': 'new' })
  })

  test('a message I am sending arrives as its pending bubble', () => {
    const before = [theirs('1')]
    expect(kinds(arrivalsOf(before, [...before, pending('a')]))).toEqual({ 'o:a': 'new' })
  })

  test('my message that takes the place of its pending bubble is told apart from an arrival', () => {
    const before = [theirs('1'), pending('a')]
    expect(kinds(arrivalsOf(before, [theirs('1'), mine('2')]))).toEqual({ 'm:2': 'sent, was o:a' })
  })

  test('with two in the line, the one that is confirmed is paired with its own pending bubble', () => {
    const before = [theirs('1'), pending('a'), pending('b')]
    expect(kinds(arrivalsOf(before, [theirs('1'), mine('2'), pending('b')]))).toEqual({
      'm:2': 'sent, was o:a',
    })
  })

  test('my message from another device, with nothing pending here, arrives like any other', () => {
    const before = [theirs('1')]
    expect(kinds(arrivalsOf(before, [...before, mine('2')]))).toEqual({ 'm:2': 'new' })
  })

  test('a message that comes while one of mine is still being sent arrives above it', () => {
    const before = [theirs('1'), pending('a')]
    expect(kinds(arrivalsOf(before, [theirs('1'), theirs('2'), pending('a')]))).toEqual({
      'm:2': 'new',
    })
  })

  test('a confirmation and a reply in the same step: one is a confirmation, one arrives', () => {
    const before = [theirs('1'), pending('a')]
    expect(kinds(arrivalsOf(before, [theirs('1'), mine('2'), theirs('3')]))).toEqual({
      'm:2': 'sent, was o:a',
      'm:3': 'new',
    })
  })

  test('an older page above what was there is not an arrival', () => {
    const before = [theirs('5'), theirs('6')]
    expect(arrivalsOf(before, [theirs('3'), theirs('4'), ...before]).size).toBe(0)
  })

  test('the top of the conversation coming into reach is not an arrival', () => {
    const before = [theirs('1'), theirs('2')]
    expect(arrivalsOf(before, [start, ...before]).size).toBe(0)
  })

  test('another part of the conversation is not an arrival', () => {
    const before = [theirs('1'), theirs('2')]
    const after = [theirs('7'), theirs('8'), theirs('9'), theirs('10')]
    expect(arrivalsOf(before, after).size).toBe(0)
  })

  test('a burst after catching up moves nothing, and a confirmation in it is still told apart', () => {
    const before = [theirs('1'), pending('a')]
    const after = [theirs('1'), mine('2'), theirs('3'), theirs('4'), theirs('5'), theirs('6')]
    expect(kinds(arrivalsOf(before, after))).toEqual({ 'm:2': 'sent, was o:a' })
  })
})
