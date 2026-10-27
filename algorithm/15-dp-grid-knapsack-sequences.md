# 第 15 章：網格、背包與序列 DP

> 先備：[第 14 章](./14-dynamic-programming.md)。每個例子都先說狀態、轉移與依賴，再決定迴圈方向。

## 15.1 本章目標

1. 區分最佳值、可行性與計數型狀態。
2. 理解 0/1 背包與完全背包的更新方向。
3. 用前綴狀態解兩個序列的問題，區分子序列與子陣列。
4. 在有新題型時重新定義狀態，不直接套兩層迴圈。

## 15.2 網格 DP：62. Unique Paths

在 m×n 網格中，從左上走到右下，每次只能向右或向下。

- **狀態**：`dp[r][c]` 是走到該格的方法數。
- **轉移**：最後一步只能來自上方或左方，因此兩者相加。
- **初始化**：起點有一種方式；第一列與第一欄各只有一種走法。
- **順序**：由上到下、由左到右，讓來源先算好。
- **答案**：`dp[m-1][n-1]`。

```ts
function uniquePaths(m: number, n: number): number {
  const dp = Array.from({ length: m }, () => new Array<number>(n).fill(1));
  for (let r = 1; r < m; r++) {
    for (let c = 1; c < n; c++) {
      dp[r][c] = dp[r - 1][c] + dp[r][c - 1];
    }
  }
  return dp[m - 1][n - 1];
}
```

契約是 m、n 為正整數，且結果與中間計數在 number 安全整數範圍內；一般化到更大網格時要使用 bigint 或依題目取模。時間 O(mn)、額外空間 O(mn)。

3×3 的表格為：

```text
1  1  1
1  2  3
1  3  6
```

若有障礙物，該格必須為 0，而且第一列／欄不能全部直接初始化為 1。若改成最小路徑成本，則改取上方與左方的最小值再加格子成本。狀態的含義決定使用加法還是 min。

## 15.3 0/1 背包：416. Partition Equal Subset Sum

正整數陣列能否拆成總和相同的兩組？總和若為奇數直接無解；否則只需找一組元素，和為 target=sum/2。

先想完整狀態：`possible[i][s]` 表示前 i 個元素能否湊出 s。每個元素只能用一次，所以：

```text
possible[i][s] = possible[i-1][s]
             或 possible[i-1][s-x]（s >= x）
possible[0][0] = true，其餘為 false
```

兩個來源都來自上一列。壓縮成一維時，容量必須倒著掃，確保 `dp[s-x]` 還沒有使用目前這個 x：

```ts
function canPartition(nums: number[]): boolean {
  const total = nums.reduce((sum, x) => sum + x, 0);
  if (total % 2 !== 0) return false;
  const target = total / 2;
  const dp = new Array<boolean>(target + 1).fill(false);
  dp[0] = true;
  for (const x of nums) {
    for (let s = target; s >= x; s--) {
      dp[s] = dp[s] || dp[s - x];
    }
  }
  return dp[target];
}
```

只給一個 2、容量 4：若正掃，先把 dp[2] 變成 true，接著 dp[4] 又讀到剛更新的 dp[2]，等於偷偷用兩次 2。倒掃就能避免。

時間 O(n·target)、空間 O(target)。這種複雜度依賴數值大小，屬於偽多項式；不是只看元素個數 n 就能判斷可行，target 太大仍會無法配置或超時。

## 15.4 完全背包：322. Coin Change

硬幣面額是正整數，每種可以無限使用，求湊成 amount 的最少枚數。

- **狀態**：`dp[s]` 是湊出金額 s 的最少枚數。
- **初始化**：`dp[0]=0`，其他為 Infinity，代表尚不可達。
- **轉移**：對每枚可用硬幣 x，比較 `dp[s-x]+1`。
- **順序**：金額由小到大，依賴的較小金額已算好。

```ts
function coinChange(coins: number[], amount: number): number {
  const dp = new Array<number>(amount + 1).fill(Infinity);
  dp[0] = 0;
  for (let s = 1; s <= amount; s++) {
    for (const coin of coins) {
      if (coin <= s) dp[s] = Math.min(dp[s], dp[s - coin] + 1);
    }
  }
  return dp[amount] === Infinity ? -1 : dp[amount];
}
```

契約為 amount 非負整數。時間 O(amount·硬幣種類數)、額外空間 O(amount)。第 11 章的 `[1,3,4]` 湊 6，在這裡會正確得到 2；不需要假設每次拿最大硬幣一定最好。

若選擇「硬幣在外、金額在內」的另一種寫法，完全背包也應正掃金額，允許同一輪重複使用目前硬幣。方向要由狀態依賴推導，不是所有背包一律倒掃。

## 15.5 計數時，迴圈順序會改變題意

518. Coin Change II 問的是組合數：`1+2` 與 `2+1` 算同一種。契約為面額互異且為正整數，amount 非負，所有計數在安全整數範圍內。

```ts
function change(amount: number, coins: number[]): number {
  const ways = new Array<number>(amount + 1).fill(0);
  ways[0] = 1;
  for (const coin of coins) {
    for (let s = coin; s <= amount; s++) {
      ways[s] += ways[s - coin];
    }
  }
  return ways[amount];
}
```

處理到某種硬幣時，ways[s] 只計算「使用已處理面額」的組合；新組合由加入這個面額產生，不會再把面額反向排列算一次。

若把金額放外層、硬幣放內層，依最後一枚硬幣累加，就會計算有順序的排列。以 `[1,2]` 湊 3 為例：組合是 `{1+1+1, 1+2}` 共 2 種；排列還多 `2+1`，共 3 種。

`ways[0]=1` 表示空組合提供一個起點。若設成 0，後續所有計數都無法開始。時間 O(amount·硬幣種類數)、額外空間 O(amount)。

## 15.6 單序列：300. Longest Increasing Subsequence

子序列可跳過元素，但保留相對順序；不是連續子陣列。先用 O(n²) DP 建立狀態，不急著使用二分優化。

- `dp[i]`：**以 nums[i] 結尾**的嚴格遞增子序列最大長度。
- 枚舉 j<i；若 nums[j]<nums[i]，可以把 nums[i] 接在 j 的最佳序列之後。
- 每個元素單獨就有長度 1。
- 答案是所有 dp[i] 的最大值，不一定是 dp[n-1]。

```ts
function lengthOfLIS(nums: number[]): number {
  const dp = new Array<number>(nums.length).fill(1);
  let best = 0;
  for (let i = 0; i < nums.length; i++) {
    for (let j = 0; j < i; j++) {
      if (nums[j] < nums[i]) dp[i] = Math.max(dp[i], dp[j] + 1);
    }
    best = Math.max(best, dp[i]);
  }
  return best;
}
```

時間 O(n²)、額外空間 O(n)，空輸入回傳 0。`[2,2,2]` 的答案是 1，不能把 `<` 改成 `<=`。之後可以用第 05 章 lower bound 維護不同長度的最小結尾，作 O(n log n) 挑戰，但那個 tails 陣列不一定就是實際的一條答案序列。

## 15.7 雙序列：1143. Longest Common Subsequence

`dp[i][j]` 表示 text1 前 i 個字元與 text2 前 j 個字元的最長共同子序列長度。

- 任一前綴為空，答案為 0。
- 最後字元相同：可在兩邊各縮短一格的答案後接上該字元，得到 `dp[i-1][j-1]+1`。
- 最後字元不同：至少略過其中一邊，取 `max(dp[i-1][j], dp[i][j-1])`。

```ts
function longestCommonSubsequence(text1: string, text2: string): number {
  const m = text1.length;
  const n = text2.length;
  const dp = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (text1[i - 1] === text2[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }
  return dp[m][n];
}
```

依題目字元集處理字串，時間與額外空間 O(mn)。`abcde` 與 `ace` 的答案是 3；不相等時不能直接歸零，那是另一種「共同連續子字串」狀態。

壓縮到一維時，除了左方與上方，還要保存更新前的左上角。先能解釋完整表格，再嘗試壓縮。

## 15.8 把狀態說成一句完整的話

| 狀態 | 必須說清楚的限制 |
|------|------------------|
| 網格路徑數 | 走到哪一格、允許哪些方向 |
| 背包可行性 | 使用前哪些物品、每件能用幾次、是否恰好湊足 |
| 零錢最少枚數 | 恰好湊成多少、不可達如何表示 |
| LIS | 以哪一個元素結尾、是否嚴格遞增 |
| LCS | 兩個前綴各多長、是否允許不連續 |

一維陣列不代表狀態只有一個概念。例如背包壓縮後，外層的物品輪次仍隱含在「哪些格子已更新」中，這正是遍歷方向影響正確性的原因。

## 課後練習與自我檢查

本章包含數個家族，建議分三次練，不要讀完全部公式才開始寫題。

| 階段 | 題目 | 練習目的 |
|------|------|----------|
| 暖身 | 62. Unique Paths；64. Minimum Path Sum | 同樣的依賴，計數與最小成本不同 |
| 核心 | 416. Partition Equal Subset Sum；322. Coin Change | 0/1 與可重複選、容量方向 |
| 變形 | 518. Coin Change II；300. Longest Increasing Subsequence | 組合／排列與以某元素結尾的狀態 |
| 挑戰 | 1143. Longest Common Subsequence；72. Edit Distance | 雙前綴狀態與不同操作的轉移 |

過關條件：不用背口訣，能用「上一列還是本列」推導容量方向；能說出為什麼空組合是 1，而空字串的 LCS 長度是 0。

---

[上一章：14](./14-dynamic-programming.md) · [課程目錄](./README.md) · [下一章：16](./16-bits-state-compression.md)
