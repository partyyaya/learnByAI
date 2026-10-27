# 第 05 章：二元搜尋與答案空間搜尋

> 先備：[第 01 章](./01-foundations-complexity.md) 的複雜度與 [第 02 章](./02-arrays-hashing-sorting.md) 的有序陣列。

## 5.1 本章目標

讀完本章後，你應該能夠：

1. 理解二元搜尋的核心不是「背模板」，而是維護 **區間不變量**。
2. 區分 **找某個值**、**找左界 / 右界**、**找最小可行答案** 這三種常見變形。
3. 把二元搜尋從「搜尋陣列」延伸到 **答案空間搜尋**。

---

## 5.2 二元搜尋真正依賴的是什麼？

很多人把 binary search 理解成：

> 只有在排序陣列裡找數字時才會用

其實更本質的說法是：

> 當搜尋空間具有 **單調性**，就能考慮二分。

常見單調性有兩種：

1. **陣列值有序**
   例如 `nums[mid] < target` 時，答案只可能在右邊。

2. **判定函式有序**
   例如某個速度 `speed` 可行，那比它更快的速度也都可行。

第二種就是所謂的 **答案空間搜尋**。

---

## 5.3 先想清楚：你到底在找什麼？

二分題常見分成三類：

### 5.3.1 找某個值是否存在

先用 704. Binary Search 練習精確查找。契約是遞增排序且不重複的陣列，找不到回傳 -1：

```ts
function search(nums: number[], target: number): number {
  let left = 0;
  let right = nums.length - 1;
  while (left <= right) {
    const mid = left + Math.floor((right - left) / 2);
    if (nums[mid] === target) return mid;
    if (nums[mid] < target) left = mid + 1;
    else right = mid - 1;
  }
  return -1;
}
```

若目標存在，它始終在閉區間 `[left, right]` 內。比較後可排除 mid，所以更新會跳過它。`left === right` 時仍有一格待檢查；`left > right` 才代表找不到。時間 O(log n)、額外空間 O(1)。空陣列也會直接回傳 -1。

### 5.3.2 找第一個滿足條件的位置

例如：

- 第一個 `>= target` 的位置
- 第一個 `> target` 的位置
- 最左邊的合法答案

這類本質上是在找 **邊界**。

### 5.3.3 找最小 / 最大可行答案

例如：

- 最小吃香蕉速度
- 最小容量
- 最大可行平均值

這類通常陣列本身不一定有序，但 **答案是否可行** 會形成單調布林值。

---

## 5.4 不變量（Invariant）比模板更重要

二分最容易寫錯的地方，不是語法，而是：

- 你現在的搜尋區間代表什麼？
- `left`、`right` 各自是否仍可能是答案？

若這件事沒先定義清楚，後面的 `mid`、縮區間方式都容易混亂。

### 5.4.1 常見約定一：閉區間 `[left, right]`

特色：

- `left` 與 `right` 都可能是答案
- 迴圈通常寫成 `while (left <= right)`

```text
閉區間：

index:   0  1  2  3  4
nums :  [1][3][5][7][9]
         L-----------R

意思是：從 left 到 right 都還可能是答案
```

這種寫法很適合：

- 找某個值是否存在
- 直接回傳 index 或 `-1`

### 5.4.2 lower bound：待檢查區間與答案範圍不同

找第一個 `>= target` 的位置時，初始化 `left = 0`、`right = n`。此時應明確分成兩個概念：

- **待檢查元素**位於半開區間 `[left, right)`。
- **邊界答案**仍可能位於閉區間 `[left, right]`，包含 right。
- 所有 `index < left` 的元素都 `< target`。
- 所有 `index >= right` 且仍在陣列內的元素都 `>= target`。

若 `nums[mid] >= target`，設定 `right = mid` 後，不需要再檢查 mid，但它仍可能是最終邊界。不能說「right 永遠不可能是答案」。

```ts
function lowerBound(nums: number[], target: number): number {
  let left = 0;
  let right = nums.length;
  while (left < right) {
    const mid = left + Math.floor((right - left) / 2);
    if (nums[mid] >= target) right = mid;
    else left = mid + 1;
  }
  return left;
}
```

結束時 `left === right`，待檢查區間為空，但答案已確定。若全部元素都太小，回傳 n，表示插入到尾端；空陣列回傳 0。時間 O(log n)、額外空間 O(1)。

答案空間二分也常用 `while (left < right)`，但它可以維護的是**閉區間內的可行答案**。不能只從迴圈比較符號判斷區間定義；要把不變量寫清楚。

---

## 5.5 找左界與右界

### 5.5.1 左界：第一個 `>= target`

這是很多題的基礎，例如：

- 插入位置
- 範圍查找的左端點

半開區間的典型想法：

- 若 `nums[mid] >= target`，代表答案在 `mid` 或更左邊 → `right = mid`
- 否則答案一定在右邊 → `left = mid + 1`

最後 `left` 會停在「第一個滿足條件的位置」。

示意圖：

```text
nums   = [1, 2, 4, 4, 4, 7]
target = 4

我們要找的是第一個 >= 4 的位置

index:   0  1  2  3  4  5
nums :  [1][2][4][4][4][7]
               ^
             答案在這裡（左界）

當 nums[mid] >= 4 時，不直接停下來，
而是繼續往左半邊縮，確認前面還有沒有更早的 4。
```

### 5.5.2 右界：最後一個 `<= target`

通常不直接寫「最後一個」，而是先找：

- 第一個 `> target` 的位置

然後再减一：

```text
rightBound = firstGreater(target) - 1
```

這種想法通常比硬寫「最後一個」更穩定。

### 5.5.3 後處理很重要

二分找到的位置不一定真的存在你要的值。

例如找 `first >= target` 後，若：

- index 已經越界，或
- `nums[index] !== target`

那就代表陣列中沒有 `target`。

---

## 5.6 答案空間搜尋（Binary Search on Answer）

### 5.6.1 什麼叫「答案空間」？

有些題不是問「某個值在不在陣列裡」，而是問：

- 最小可行速度是多少？
- 最小容量是多少？
- 最大可行距離是多少？

這時候你不是在搜陣列索引，而是在搜 **可能答案的數值範圍**。

### 5.6.2 先寫判定函式 `ok(x)`

答案空間搜尋最關鍵的是：

> 給定一個候選答案 `x`，你能不能在合理時間內判斷它是否可行？

只要 `ok(x)` 具備單調性，就能二分。

常見模式：

- `x` 可行，則更大的也可行 → 找 **最小可行**
- `x` 可行，則更小的也可行 → 找 **最大可行**

```text
找最小可行答案時，常長這樣：

x  : 1  2  3  4  5  6  7
ok : F  F  F  T  T  T  T
               ^
            第一個 True

二分的目標就是找到這個邊界點
```

### 5.6.3 為什麼面試官喜歡這類題？

因為它會檢查你是否真的理解二分的本質：

- 不是背陣列模板
- 而是能把問題抽成「單調判定 + 搜尋邊界」

---

## 5.7 常見錯誤

1. **區間定義混用**
   一下用閉區間，一下又用半開區間，最容易造成漏解或死迴圈。

2. **`mid` 更新後沒讓區間縮小**
   例如某些情況寫成 `left = mid`，就可能卡住不動。

3. **忘記二分需要單調性**
   若 `ok(x)` 不是單調的，二分就沒有保證。

4. **只顧找到位置，沒做後處理**
   找左界、右界時，最後那個 index 是否越界、是否真符合條件，都要再驗一次。

---

## 5.8 小結

- 二元搜尋的核心是 **縮小仍可能有答案的區間**。
- 找邊界時，常比「找精確值」更重要。
- 當題目有 **單調的可行性判定**，就可以把二分用到答案本身。

看到「最小可行」「最大可行」「第一個滿足條件」時，請優先想到二分。

---

## 課後練習：對應題目

### 題目：875. Koko Eating Bananas（愛吃香蕉的珂珂）

- **連結**：[https://leetcode.com/problems/koko-eating-bananas/](https://leetcode.com/problems/koko-eating-bananas/)

#### 題意（白話）

有一堆香蕉 `piles`，`piles[i]` 是第 `i` 堆的香蕉數。
Koko 每小時選一堆來吃，若她的速度是 `k`，則一小時最多吃 `k` 根。

給定總時數 `h`，請找出：

- **最小的整數速度 `k`**
- 使得她能在 `h` 小時內吃完所有香蕉

#### 為什麼選這題當本章收尾？

1. 這題不是在有序陣列裡找值，而是在找 **最小可行答案**。
2. 很適合練習「先定義 `ok(speed)`，再二分」。
3. 是答案空間搜尋的代表題，之後像容量、最短時間、最小成本題型都常長這樣。

#### 關鍵單調性

定義：

- `ok(speed)` = 用速度 `speed` 吃香蕉，是否能在 `h` 小時內吃完

若某個速度 `speed` 可行，那麼：

- 比它更快的速度也一定可行

這就形成了：

```text
false false false true true true
```

這種「先不行，後都行」的單調結構，非常適合找 **第一個 true**。

#### 判定函式怎麼算？

對每一堆 `pile`，若速度是 `speed`，需要的時間是：

```text
ceil(pile / speed)
```

全部加起來，若總時數 `<= h`，則這個速度可行。

#### 參考實作（TypeScript）

題目保證 piles 非空、每堆為正整數，且 `h >= piles.length`。因此最大堆大小一定是可行上界；若沒有這個保證，要先處理無解情況。這段維護的是「最小可行速度在閉區間 `[left, right]` 中」，不是把 right 當成答案之外。

```ts
function minEatingSpeed(piles: number[], h: number): number {
  let left = 1;
  let right = 0;
  for (const pile of piles) right = Math.max(right, pile);

  const canFinish = (speed: number): boolean => {
    let hours = 0;

    for (const pile of piles) {
      // 不滿一小時的剩餘也要算 1 小時，所以用 ceil
      hours += Math.ceil(pile / speed);
    }

    return hours <= h;
  };

  while (left < right) {
   // 取整數中點；此題數值在 number 的安全整數範圍內
   const mid = left + Math.floor((right - left) / 2);

   if (canFinish(mid)) {
     right = mid;
   } else {
     left = mid + 1;
   }
  }

  return left;
}
```

#### 複雜度整理

- **時間**：每次檢查 `canFinish` 要掃一次 `piles`，是 O(n)；二分次數約 O(log M)，`M` 為最大堆大小，所以總計 **O(n log M)**
- **空間**：只用常數變數 → **O(1)**

#### 常見錯誤

1. **把這題當貪心亂猜速度**
   真正關鍵是「速度可行性有單調性」，所以應該二分。

2. **上界設錯**
   最大速度設成 `max(piles)` 就夠了，因為再快也沒有必要。

3. **天花板除法寫錯**
   TypeScript 可直接寫：`Math.ceil(pile / speed)`
   （整數語言常見等價寫法是 `(pile + speed - 1) / speed` 的整數除法）

---

## 課後練習路線

| 階段 | 題目 | 練習目的 |
|------|------|----------|
| 暖身 | 704. Binary Search；35. Search Insert Position | 先精確查找，再找邊界 |
| 核心 | 34. Find First and Last Position of Element in Sorted Array | lower bound、upper bound 與找不到的後處理 |
| 變形 | 875. Koko Eating Bananas | 將最小可行值改寫成單調判定 |
| 挑戰 | 1011. Capacity To Ship Packages Within D Days | 自行設計判定函式與可行上界 |

自我檢查：對 `[1, 2, 2, 4]` 找 2、3、5，lower bound 各是多少？能否說明每次迴圈都縮小範圍，以及 right 何時仍可作答案？

---

[上一章：04](./04-prefix-sum-hash-table.md) · [課程目錄](./README.md) · [下一章：06](./06-linked-lists.md)
