# 第 10 章：Heap 與優先佇列

> 先備：[第 02 章](./02-arrays-hashing-sorting.md) 的比較器與 [第 08 章](./08-recursion-trees-bst.md) 的樹。這是第 17 章 Dijkstra 的必要工具。

## 10.1 本章目標

1. 理解 Heap 與排序陣列、BST 的差別。
2. 用陣列實作上浮、下沉與優先佇列。
3. 推導第 K 大元素為什麼適合維護大小 K 的小根堆。

## 10.2 為什麼只找最小值還需要新結構？

只找一次最小值，線性掃描 O(n) 就夠了。如果不斷加入資料、每次都要取出目前最小值：

- 每次重掃：單次取出 O(n)。
- 每次重新排序：做了超過「只需要最小值」的工作。
- Heap：插入與取出頂端 O(log n)，只查看頂端 O(1)。

優先佇列是「依優先度取出」的介面，二元 Heap 是一種實作。它與 FIFO queue 的取出順序不同。

## 10.3 完全二元樹與陣列位置

Heap 的形狀是完全二元樹：由上而下、由左至右填滿，所以可以直接用陣列表示。

```text
        2                  index: 0  1  2  3  4
      /   \                value: 2  5  3  9  7
     5     3
    / \
   9   7

索引 i 的父節點：floor((i - 1) / 2)，i > 0
左孩子：2 * i + 1
右孩子：2 * i + 2
```

小根堆要求每個父節點都不大於孩子，因此根一定最小。但兄弟與不同子樹之間沒有排序保證，不能用二分搜尋找任意值，也不能把內部陣列當成排序結果。

## 10.4 插入上浮、取出下沉

**插入**：先放尾端，維持完全二元樹形狀；如果比父節點優先，就交換並繼續向上。

**取出**：保存根，把最後一個元素移到根；每次與兩個孩子中更優先的那個交換，直到父子順序恢復。

兩者最多走一條樹高，Heap 高度 O(log n)。下沉時若只固定選左孩子，可能仍違反右孩子的順序。

## 10.5 可重用的 TypeScript Heap

`compare(a, b) < 0` 表示 a 比 b 優先。泛型 T 讓同一套結構可保存數字，也可保存 `[距離, 節點]`。

```ts
class Heap<T> {
  private data: T[] = [];

  constructor(private compare: (a: T, b: T) => number) {}

  get size(): number {
    return this.data.length;
  }

  peek(): T | undefined {
    return this.data[0];
  }

  push(value: T): void {
    this.data.push(value);
    let i = this.data.length - 1;
    while (i > 0) {
      const parent = Math.floor((i - 1) / 2);
      if (this.compare(this.data[i], this.data[parent]) >= 0) break;
      [this.data[i], this.data[parent]] = [this.data[parent], this.data[i]];
      i = parent;
    }
  }

  pop(): T | undefined {
    if (this.data.length === 0) return undefined;
    const top = this.data[0];
    const last = this.data.pop()!;
    if (this.data.length > 0) {
      this.data[0] = last;
      let i = 0;
      while (true) {
        const left = 2 * i + 1;
        const right = left + 1;
        let best = i;
        if (left < this.data.length
          && this.compare(this.data[left], this.data[best]) < 0) best = left;
        if (right < this.data.length
          && this.compare(this.data[right], this.data[best]) < 0) best = right;
        if (best === i) break;
        [this.data[i], this.data[best]] = [this.data[best], this.data[i]];
        i = best;
      }
    }
    return top;
  }
}
```

建立小根堆用 `new Heap<number>((a, b) => a - b)`；大根堆則用 `(a, b) => b - a`。空堆的 peek／pop 回傳 undefined。

Heap 不保證同優先度資料的先後順序；如果業務需要固定順序，將序號納入比較器。入堆後不要任意修改影響優先度的欄位，否則原本的堆順序會失效。

本類別逐筆 push 建立 n 個元素需 O(n log n)。若已有整個陣列，可從最後一個非葉節點向上做下沉，建堆可達 O(n)：多數節點靠近葉端，不會各自下沉完整樹高。

## 10.6 核心題：215. Kth Largest Element in an Array

排序後取 `n-k` 是容易理解的解法。若只在乎最大的 K 個值，可以讓小根堆保存目前最大的 K 個候選，根就是這群候選中最弱的一個。

以下與上面的 Heap 類別放在同一份程式中；契約為 `1 <= k <= nums.length`。

```ts
function findKthLargest(nums: number[], k: number): number {
  const heap = new Heap<number>((a, b) => a - b);
  for (const x of nums) {
    heap.push(x);
    if (heap.size > k) heap.pop();
  }
  return heap.peek()!;
}
```

例如 `[3, 2, 1, 5, 6, 4]`、k=2：處理 5 後保留 `{3,5}`，處理 6 後保留 `{5,6}`，最後 4 被淘汰，答案為 5。

每次加入新值後，淘汰 K+1 個候選中最小的，剩下的必然仍是已看過資料中最大的 K 個。重複值也各算一個元素，不是第 K 大的不同值。

時間 O(n log(k+1))，通常寫 O(n log k)，k=1 時是 O(n)；額外空間 O(k)。

## 10.7 何時用排序，何時用 Heap？

| 需求 | 較直接的工具 |
|------|--------------|
| 一次取得全部排序結果 | 排序 |
| 不斷新增、取出目前最小／最大 | Heap |
| 串流維護最大的 K 個 | 大小 K 的小根堆 |
| 滑動視窗最大值 | 單調 deque；Heap 需額外處理過期元素 |
| 任意值是否存在 | Set／Map；Heap 不擅長任意查找 |

Heap 沒有自動理解「這筆資料過期了」。Dijkstra 會保留同節點的多筆距離，取出後再比對最新距離，詳見第 17 章。

## 課後練習與自我檢查

| 階段 | 題目 | 練習目的 |
|------|------|----------|
| 暖身 | 1046. Last Stone Weight | 大根堆與反覆取出 |
| 核心 | 215. Kth Largest Element in an Array | 小根堆保存最大 K 個 |
| 變形 | 703. Kth Largest Element in a Stream；347. Top K Frequent Elements | 線上更新；依頻率比較 |
| 挑戰 | 23. Merge k Sorted Lists | 堆中只保留各串列目前的候選節點 |

過關條件：空堆、單元素、重複值都能正確取出；能說明 Top K 為何用小根堆，且不把堆內陣列誤認為有序。

---

[上一章：09](./09-backtracking.md) · [課程目錄](./README.md) · [下一章：11](./11-intervals-greedy.md)
