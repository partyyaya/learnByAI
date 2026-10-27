# 第 11 章：區間問題與貪心

> 先備：[第 02 章](./02-arrays-hashing-sorting.md) 的排序與 [第 03 章](./03-two-pointers-sliding-window.md) 的排除理由。貪心是主線工具，不需要等到進階圖才學。

## 11.1 本章目標

1. 依問題選擇起點排序或終點排序。
2. 區分「整理區間」與「選擇互不衝突的區間」。
3. 用交換論證、不變量與反例檢查貪心策略。

## 11.2 先定義端點是否重疊

`[1, 2]` 與 `[2, 3]` 算不算重疊，取決於題目：

- 合併閉區間時，共享端點通常要合併。
- 活動安排若前一場在 2 結束、下一場可在 2 開始，就可相接。

比較符號要從契約推出，不能記成「區間題固定用 `<`」。

## 11.3 暖身：56. Merge Intervals

把閉區間按起點遞增排序。若新區間起點不超過目前合併段的終點，兩者相交，就延伸終點；否則開始新的一段。

```ts
function merge(intervals: number[][]): number[][] {
  const sorted = intervals.map(([start, end]) => [start, end])
    .sort((a, b) => a[0] - b[0]);
  const answer: number[][] = [];
  for (const [start, end] of sorted) {
    const last = answer[answer.length - 1];
    if (last === undefined || start > last[1]) {
      answer.push([start, end]);
    } else {
      last[1] = Math.max(last[1], end);
    }
  }
  return answer;
}
```

掃描時，answer 已完整表示處理過的所有區間之聯集。由於後面的起點只會更大，新的區間只需與最後一段比較。

例如 `[[1,4],[2,3]]` 應保留 `[1,4]`，不能直接把終點換成 3。時間採排序 O(n log n)，複製與輸出各 O(n)，另計排序工作空間。

合併是在保留所有覆蓋範圍，並沒有挑選要保留哪些原始區間。下一題才是最佳化選擇。

## 11.4 核心題：435. Non-overlapping Intervals

移除最少區間，等價於保留最多互不重疊的區間。本題允許端點相接，且每段 start < end。

### 為什麼不是先選最早開始？

`[1,10]、[2,3]、[3,4]`：先選最早開始的 `[1,10]`，只保留一段；選兩個短區間則可保留兩段。

選「最短長度」也不保證最佳：`[0,3]、[3,6]、[2,4]`，最短的 `[2,4]` 會擋住另外兩段。

### 改成選最早結束，並證明

在所有可選區間裡挑結束最早的 g。假設某個最佳解第一段是 o，由於 `end(g) <= end(o)`，把 o 換成 g 不會妨礙最佳解後面的區間，也沒有減少選取數量。

因此存在一個以 g 開頭的最佳解。剩下問題依然是相同形式，可以重複選擇。這就是交換論證；不是只因為幾個例子通過就相信策略。

```ts
function eraseOverlapIntervals(intervals: number[][]): number {
  const sorted = intervals.map(([start, end]) => [start, end])
    .sort((a, b) => a[1] - b[1]);
  let end = -Infinity;
  let kept = 0;
  for (const [start, finish] of sorted) {
    if (start >= end) {
      kept++;
      end = finish;
    }
  }
  return intervals.length - kept;
}
```

時間 O(n log n)，本版複製輸入需 O(n) 額外空間，另計排序工作空間。

## 11.5 變形：55. Jump Game

nums[i] 是從 i 最多能往右跳幾格，所有值非負，輸入非空。題目問是否能到最後一格。

不要先承諾一條「每次跳最遠」的實際路徑；維護所有已知可達位置共同形成的最遠邊界：

```ts
function canJump(nums: number[]): boolean {
  let farthest = 0;
  for (let i = 0; i < nums.length; i++) {
    if (i > farthest) return false;
    farthest = Math.max(farthest, i + nums[i]);
    if (farthest >= nums.length - 1) return true;
  }
  return false;
}
```

不變量：掃描 i 前，farthest 是前面已確認可達位置所能延伸到的最遠索引。由於可以跳「至多」nums[i] 步，範圍內的位置都可達；如果 i 已在範圍外，更後面的格子也無法替我們跨回這個缺口。

`[2,3,1,1,4]` 可達；`[3,2,1,0,4]` 卡在索引 3。時間 O(n)、額外空間 O(1)。

## 11.6 貪心與 DP 的差別

貪心需要證明某個選擇現在就能確定，不用保留被排除的其他選擇。DP 則保留不同狀態的答案，直到具備足夠資訊再比較。

例如硬幣 `[1,3,4]` 湊 6：每次拿最大硬幣得到 `4+1+1`，但最少枚數是 `3+3`。這個反例表示「拿最大」不成立，不代表所有湊錢問題都不能最佳化；第 15 章會用 DP 解。

貪心不能只靠「最小／最大」關鍵字辨認。請先寫選擇規則，再嘗試交換論證或持續領先的證明，並刻意構造相反例子。

## 課後練習與自我檢查

| 階段 | 題目 | 練習目的 |
|------|------|----------|
| 暖身 | 56. Merge Intervals | 起點排序與合併邊界 |
| 核心 | 435. Non-overlapping Intervals | 終點排序與交換論證 |
| 變形 | 55. Jump Game；452. Minimum Number of Arrows to Burst Balloons | 可達範圍；共享端點的不同意義 |
| 挑戰 | 45. Jump Game II | 按目前可達範圍分層，推導最少跳數 |

過關條件：能用反例否定錯誤排序，並完整說明「換成我的選擇，不會讓最佳解變差」的理由。

---

[上一章：10](./10-heap-priority-queue.md) · [課程目錄](./README.md) · [下一章：12](./12-graphs-dfs-bfs.md)
