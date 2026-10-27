# 第 09 章：回溯與剪枝

> 先備：[第 08 章](./08-recursion-trees-bst.md) 的遞迴與樹。本章走訪的樹由「選擇」產生，不一定是輸入裡已有的節點。

## 9.1 本章目標

1. 用選擇樹描述枚舉，區分子集合、組合與排列。
2. 正確執行選擇、遞迴、撤銷。
3. 區分剪枝與去重，理解輸出大小帶來的成本。

## 9.2 從二元選擇樹開始

對 `[1, 2]` 的每個元素選擇「取」或「不取」：

```text
                    []
             不取1 /  \ 取1
                 []   [1]
         不取2 /  \取2  /  \
             []  [2] [1] [1,2]
```

每層決定一個元素，走到葉節點就得到一個子集合。回溯不是把所有遞迴都重算，而是在搜尋不同選擇；若共用一個 path 陣列，就要在返回上一層時恢復它。

## 9.3 核心題：78. Subsets

契約：nums 的元素互不相同。

```ts
function subsets(nums: number[]): number[][] {
  const answer: number[][] = [];
  const path: number[] = [];
  function dfs(index: number): void {
    if (index === nums.length) {
      answer.push([...path]);
      return;
    }
    dfs(index + 1); // 不選
    path.push(nums[index]);
    dfs(index + 1); // 選
    path.pop();    // 還原到呼叫這層之前
  }
  dfs(0);
  return answer;
}
```

### 為什麼答案要複製？

`answer.push(path)` 只保存同一個陣列參考。後續 push／pop 會改掉所有答案看到的內容，因此必須存當下的快照。

共有 2ⁿ 個子集合，複製輸出總成本 O(n·2ⁿ)，不能只寫 O(n)。工作空間 O(n)，來自 path 與呼叫堆疊；輸出空間 O(n·2ⁿ)。空輸入的子集合是 `[[]]`，不是 `[]`。

## 9.4 組合與排列：下一層可選誰？

| 題型 | 順序是否重要 | 常用狀態 |
|------|--------------|----------|
| 子集合／組合 | `[1,2]` 與 `[2,1]` 是同一組 | start 索引，只向後選 |
| 排列 | `[1,2]` 與 `[2,1]` 不同 | used 陣列，任何尚未使用的元素都可選 |
| 可重複選的組合 | 可重複使用某個元素 | 遞迴可傳相同索引，但必須有其他進展量 |

例如可重複選正整數來湊和，剩餘和會減少，才能確保終止；若允許 0 或負數，不能直接使用同一套終止與剪枝條件。

### 排列範例：46. Permutations

```ts
function permute(nums: number[]): number[][] {
  const answer: number[][] = [];
  const path: number[] = [];
  const used = new Array<boolean>(nums.length).fill(false);
  function dfs(): void {
    if (path.length === nums.length) {
      answer.push([...path]);
      return;
    }
    for (let i = 0; i < nums.length; i++) {
      if (used[i]) continue;
      used[i] = true;
      path.push(nums[i]);
      dfs();
      path.pop();
      used[i] = false;
    }
  }
  dfs();
  return answer;
}
```

本題同樣假設元素互異。工作空間 O(n)，包含複製答案的時間與輸出空間為 O(n·n!)。`used` 表示「目前路徑用過」，每條分支返回後要撤銷；它不是圖遍歷中「整次搜尋已完成」的全域 visited。

## 9.5 去重：同一層跳過相同選擇

90. Subsets II 允許重複值。先排序，讓同值相鄰；在同一層只讓第一個同值作起點，但下一層仍可選另一份同值。

```ts
function subsetsWithDup(nums: number[]): number[][] {
  const sorted = [...nums].sort((a, b) => a - b);
  const answer: number[][] = [];
  const path: number[] = [];
  function dfs(start: number): void {
    answer.push([...path]);
    for (let i = start; i < sorted.length; i++) {
      if (i > start && sorted[i] === sorted[i - 1]) continue;
      path.push(sorted[i]);
      dfs(i + 1);
      path.pop();
    }
  }
  dfs(0);
  return answer;
}
```

對 `[1, 2, 2]`，根層不需要分別從兩個 2 開始生成相同子集合，但已選一個 2 的下一層仍應允許得到 `[2, 2]`。所以條件是 `i > start`，不是一律 `i > 0`。

最壞時間 O(n log n + n·2ⁿ)，工作空間 O(n)（另計排序實作成本），輸出最多 O(n·2ⁿ)。

## 9.6 剪枝：尚未走完，就知道不可能

剪枝是排除不可能產生答案或不可能改善答案的分支；去重是避免重複產生同一答案。兩者理由不同。

例如從 n 個數中挑 k 個，目前已挑 path.length 個：

```text
還需要 = k - path.length
剩餘可選 = n - start
若剩餘可選 < 還需要，就直接返回。
```

每次剪枝都要回答「被刪掉的分支為什麼不可能有解」。以正數湊和為例，總和超過 target 後可停止；若允許負數，之後可能再降回 target，就不能如此剪枝。

## 9.7 接到 DP：什麼時候可以合併分支？

回溯常要列出所有路徑，即使兩條路徑到達同一位置，也可能代表不同輸出。DP 則通常只需最佳值、個數或可行性；如果未來答案只由某個狀態決定，就可共用子問題結果。

例如打家劫舍可把「目前處理到哪間房子」與明確的選擇契約變成狀態。第 14 章會從暴力遞迴開始加上記憶化，不能只把任何 dfs 的參數隨便當快取鍵。

## 課後練習與自我檢查

| 階段 | 題目 | 練習目的 |
|------|------|----------|
| 暖身 | 77. Combinations | start 索引與固定個數 |
| 核心 | 78. Subsets；46. Permutations | 選／不選、used 與撤銷 |
| 變形 | 90. Subsets II；39. Combination Sum | 同層去重與可重複選 |
| 挑戰 | 79. Word Search | 路徑內的格子標記與還原；圖表示可搭配第 12 章 |

過關條件：能說出每個可變狀態在哪一行建立、在哪一行撤銷，並把複製輸出的成本算進去。

---

[上一章：08](./08-recursion-trees-bst.md) · [課程目錄](./README.md) · [下一章：10](./10-heap-priority-queue.md)
