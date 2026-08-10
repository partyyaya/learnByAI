// 單元測試：純函式（第 15 章）
// 純函式不需要掛元件、不需要 mock，跑得最快，優先補這一層。
import { describe, it, expect } from 'vitest'
import { excerpt, formatDate, authorName } from '~/utils/format'

describe('excerpt', () => {
  it('短內容原樣回傳', () => {
    expect(excerpt('短短一句')).toBe('短短一句')
  })

  it('超過上限就截斷並補刪節號', () => {
    const long = 'a'.repeat(80)
    expect(excerpt(long)).toBe('a'.repeat(60) + '…')
  })

  it('剛好等於上限不截斷（邊界）', () => {
    const exact = 'a'.repeat(60)
    expect(excerpt(exact)).toBe(exact)
  })

  it('可自訂長度', () => {
    expect(excerpt('1234567890', 5)).toBe('12345…')
  })

  it('null / undefined 回傳空字串，不會爆', () => {
    expect(excerpt(null)).toBe('')
    expect(excerpt(undefined)).toBe('')
  })
})

describe('formatDate', () => {
  it('ISO 字串格式化成 zh-TW 日期', () => {
    expect(formatDate('2025-03-08T10:20:30.000Z')).toBe(
      new Date('2025-03-08T10:20:30.000Z').toLocaleDateString('zh-TW')
    )
  })

  it('Date 物件也吃', () => {
    const d = new Date('2025-01-01T00:00:00.000Z')
    expect(formatDate(d)).toBe(d.toLocaleDateString('zh-TW'))
  })

  it('空值或不合法的日期回傳空字串（畫面不會出現 Invalid Date）', () => {
    expect(formatDate(null)).toBe('')
    expect(formatDate('')).toBe('')
    expect(formatDate('不是日期')).toBe('')
  })
})

describe('authorName', () => {
  it('有作者就用作者名', () => {
    expect(authorName({ author: { name: 'Gary' } })).toBe('Gary')
  })

  it('沒有作者（seed 的示範文章）掛站長', () => {
    expect(authorName({ author: null })).toBe('站長')
    expect(authorName({})).toBe('站長')
    expect(authorName(undefined)).toBe('站長')
  })
})
