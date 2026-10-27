# 第 02 章：陣列、字串、雜湊與排序

> 先備：[第 01 章](./01-foundations-complexity.md)。本章先把後續滑動視窗、前綴和與貪心會用到的操作練熟。

## 2.1 本章目標

1. 區分陣列索引、值與物件參考。
2. 依問題選擇 Set、計數 Map 或索引 Map。
3. 從 Two Sum 暴力解推導一次掃描。
4. 正確排序數字，判斷排序是否破壞題意。

## 2.2 陣列與字串的操作成本

| 操作 | 常用分析模型 | 注意事項 |
|------|--------------|----------|
| `nums[i]` | O(1) | 越界會得到 `undefined` |
| 陣列尾端 `push / pop` | 均攤 O(1) | 尾端適合當堆疊 |
| 陣列開頭或中間插刪 | 通常 O(n) | `shift / unshift / splice` 可能搬移元素 |
| 複製 n 個元素 | O(n) 時間與空間 | 展開、`slice` 都有成本 |
| 掃描整個陣列 | O(n) | 每輪還做什麼也要一起算 |

字串不可原地改字元。若要修改，可轉成字元陣列再組回字串，但要計入配置與複製成本。

### 索引的「一格」不一定是一個可見字元

JavaScript 的 `s.length` 與 `s[i]` 以 UTF-16 code unit 計算。`"😀".length` 是 2；`Array.from("😀")` 則得到一個 code point。組合字與家庭 emoji 仍可能含多個 code point。

本課的基本字串題依題目限定的英文字母、數字或符號處理。若要支援一般文字，先定義計算單位：code unit、code point，或可見字元（grapheme cluster）。不能只把原模板套上去就聲稱全面支援 Unicode。

## 2.3 Set：我只想知道它出現過沒有

假設題目只問有沒有重複值，暴力比較所有配對需 O(n²)。改成每次檢查「之前看過沒有」，就能一次掃描：

```ts
function containsDuplicate(nums: number[]): boolean {
  const seen = new Set<number>();
  for (const x of nums) {
    if (seen.has(x)) return true;
    seen.add(x);
  }
  return false;
}
```

平均時間 O(n)、額外空間 O(n)。讀到某個元素前，`seen` 恰好保存前面出現過的值；這就是不變量。

## 2.4 Map：我還需要次數或位置

| 想回答的問題 | 儲存形式 | 更新方式 |
|--------------|----------|----------|
| 出現幾次？ | `Map<值, 次數>` | 原次數加一 |
| 最後出現在哪？ | `Map<值, 索引>` | 每次覆寫 |
| 最早出現在哪？ | `Map<值, 索引>` | 只有不存在時才存 |
| 某個鍵是否存在？ | `has(key)` | 不要以值的真假代替 |

例如索引 0 是合法位置，`if (map.get(x))` 卻會把它當成假。使用 `has` 或明確比較 `undefined`。

```ts
function frequencies(nums: number[]): Map<number, number> {
  const count = new Map<number, number>();
  for (const x of nums) {
    count.set(x, (count.get(x) ?? 0) + 1);
  }
  return count;
}
```

`?? 0` 表示沒有值時從 0 開始。Map 使用物件作鍵時依參考辨識；兩個內容相同但分別建立的陣列，不會自動成為同一個鍵。之後若狀態是座標或多個數字，應使用明確編碼或巢狀結構。

## 2.5 核心題：1. Two Sum

第 01 章會枚舉每組 `(i, j)`。固定目前的數 `x` 後，其實只需要問：

```text
以前有沒有出現 target - x？如果有，它的索引是多少？
```

```ts
function twoSum(nums: number[], target: number): number[] {
  const indexByValue = new Map<number, number>();
  for (let i = 0; i < nums.length; i++) {
    const other = target - nums[i];
    if (indexByValue.has(other)) {
      return [indexByValue.get(other)!, i];
    }
    indexByValue.set(nums[i], i);
  }
  return [];
}
```

和前章一樣，本範例無解回傳 `[]`；原題保證一組解。`!` 是 TypeScript 的非空斷言，這裡由前面的 `has` 保證該值存在。

### 為什麼先查，再存？

讀到索引 `i` 時，Map 只保存 `i` 之前的元素，所以不會重用自己。對 `[3, 3]`、目標 `6`：

| i | 需要的值 | 查找結果 | 動作 |
|---|----------|----------|------|
| 0 | 3 | 沒有 | 存入 `3 → 0` |
| 1 | 3 | 索引 0 | 回傳 `[0, 1]` |

每個元素查找一次、至多存入一次，平均時間 O(n)、額外空間 O(n)。這個「只看歷史，再登記現在」的順序，也會出現在第 04 章前綴和計數。

## 2.6 排序：先決定比較規則

數字升冪使用 `nums.sort((a, b) => a - b)`。若省略比較器，預設依字串順序比較，`[2, 10, 1]` 會變成 `[1, 10, 2]`。

- 比較器回傳負數：a 排在 b 前面。
- 回傳正數：a 排在 b 後面。
- 回傳 0：兩者在此規則下相等。

`sort` 會改動原陣列。若要保留輸入，先 `const sorted = [...nums]` 再排序；這份複製需要 O(n) 空間。比較排序常採 O(n log n) 時間模型，內建排序的額外空間依執行引擎而異，不能一概寫 O(1)。

多欄位排序可先比主要欄位，相等時再比第二欄。例如區間先按起點、再按終點：

```ts
function sortIntervals(intervals: number[][]): number[][] {
  return intervals.map(([start, end]) => [start, end])
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
}
```

排序前先問：

1. 題目是否要求原始索引？需要一起保留索引嗎？
2. 是否要求原始順序的連續區間？排序會破壞它。
3. 位置是否代表距離、時間或相鄰關係？裝水、打家劫舍都不能任意排序。

本章先學會正確使用排序；第 11 章才推導「為什麼某種排序能支持貪心決策」。

## 2.7 JS／TS 容易忽略的成本與邊界

- **淺拷貝**：`[...matrix]` 只複製外層，內層陣列仍共用參考。
- **二維初始化**：用 `Array.from({ length: rows }, () => new Array<number>(cols).fill(0))`，避免 `fill` 同一個內層陣列。
- **數值範圍**：`number` 的安全整數範圍為 ±(2^53 − 1)。前綴和、路徑數與乘積都要看最大可能值；超過時需考慮 `bigint`，不能與 `number` 直接混算。
- **位元運算**：對 `number` 的位元運算有 32 位元限制，詳見第 16 章。不要把 `>> 1` 當成所有數值都安全的除二。
- **大量參數**：`Math.max(...nums)` 將整個陣列展開為函式參數；大型資料用迴圈找最大值，避免參數數量限制。

## 課後練習與自我檢查

| 階段 | 題目 | 練習目的 |
|------|------|----------|
| 暖身 | 217. Contains Duplicate | Set 與平均查找成本 |
| 核心 | 1. Two Sum | 互補查找、索引 0、先查後存 |
| 變形 | 242. Valid Anagram | 計數 Map，或依題目字元集使用固定陣列 |
| 挑戰 | 49. Group Anagrams | 設計能代表同一組字元的 key，計入建 key 的成本 |

過關條件：能解釋為什麼 Two Sum 要存索引、字元統計要存次數；能舉出排序會改變題意的例子。

---

[上一章：01](./01-foundations-complexity.md) · [課程目錄](./README.md) · [下一章：03](./03-two-pointers-sliding-window.md)
