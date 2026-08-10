import { describe, expect, it } from 'vitest'
import { formatDate, formatNumber, initials } from './format'

// 純函式測試（第 14 章 §3）。
// 這類測試最划算：不用 DOM、不用 Provider、毫秒級跑完，
// 而且格式化函式壞掉會同時影響整個後台每一頁。
//
// 節奏固定三段：準備輸入 → 執行 → 斷言輸出。

describe('formatDate', () => {
  it('把 ISO 字串格式化為 YYYY-MM-DD', () => {
    // 刻意不加結尾的 Z：帶 Z 代表 UTC，會被轉成當地時區，
    // 在 UTC+8 跑是 3/7、在 UTC-5 跑可能變成 3/6——測試就會「換台電腦就掛」。
    // 不加 Z 表示當地時間，任何時區結果都一致。
    expect(formatDate('2024-03-07T09:30:00')).toBe('2024-03-07')
  })

  it('個位數的月與日要補 0', () => {
    // 這是 padStart 的邊界，最容易寫錯成 '2024-3-7'
    expect(formatDate('2024-01-05T00:00:00')).toBe('2024-01-05')
  })

  it('也接受 timestamp（列表的 updatedAt 就是這種格式）', () => {
    // 月份參數是 0-based，2 代表 3 月
    const timestamp = new Date(2024, 2, 7, 9, 30).getTime()
    expect(formatDate(timestamp)).toBe('2024-03-07')
  })

  it('空值回傳橫線，不會炸掉畫面', () => {
    // 後端漏給欄位時，表格要顯示 '-' 而不是 Invalid Date 或整頁白畫面
    expect(formatDate(null)).toBe('-')
    expect(formatDate(undefined)).toBe('-')
    expect(formatDate('')).toBe('-')
  })

  it('無法解析的字串也回傳橫線', () => {
    expect(formatDate('不是日期')).toBe('-')
  })
})

describe('formatNumber', () => {
  it('四位數以上加千分位', () => {
    expect(formatNumber(12345)).toBe('12,345')
  })

  it('三位數不加逗號', () => {
    // 邊界：999 / 1000 是分隔符出現與否的交界
    expect(formatNumber(999)).toBe('999')
    expect(formatNumber(1000)).toBe('1,000')
  })

  it('字串數字也能處理（API 回傳字串時常見）', () => {
    expect(formatNumber('2500')).toBe('2,500')
  })

  it('非數字回傳 "0"', () => {
    expect(formatNumber('abc')).toBe('0')
    expect(formatNumber(undefined)).toBe('0')
  })
})

describe('initials', () => {
  it('取名字第一個字並轉大寫', () => {
    expect(initials('meihui')).toBe('M')
  })

  it('中文名取第一個字', () => {
    expect(initials('王小明')).toBe('王')
  })

  it('前後空白不影響結果', () => {
    expect(initials('  admin  ')).toBe('A')
  })

  it('沒有名字時回傳問號', () => {
    // 頭像元件永遠要有東西可顯示，不能是空白圓圈
    expect(initials('')).toBe('?')
    expect(initials()).toBe('?')
  })
})
