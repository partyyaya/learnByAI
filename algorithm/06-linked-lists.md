# 第 06 章：鏈結串列

> 先備：[第 02 章](./02-arrays-hashing-sorting.md) 的參考與陣列操作。本章先練「改連結」，再進到樹的節點關係。

## 6.1 本章目標

1. 理解串列節點與陣列索引的差異。
2. 使用 dummy node 統一表頭與中間節點的操作。
3. 能畫圖解釋反轉串列與快慢指標。

## 6.2 值不等於節點

單向串列的每個節點保存值與下一個節點的參考。以下類別供本章所有範例共用；線上評測若已提供 ListNode，就不必重複宣告。

```ts
class ListNode {
  constructor(
    public val: number = 0,
    public next: ListNode | null = null,
  ) {}
}
```

```text
head → [2 | next] → [7 | next] → [7 | null]
```

兩個 7 是不同節點。判斷有沒有環或兩條串列是否相交，要比較節點參考，不是比較值。

| 操作 | 成本 | 前提 |
|------|------|------|
| 讀第 k 個節點 | O(k) | 必須從表頭走過去 |
| 在已知節點後插入 | O(1) | 已有節點參考，不含尋找成本 |
| 刪除某節點的下一個節點 | O(1) | 已找到前驅 |
| 找某個值 | O(n) | 不支援陣列式隨機存取 |

## 6.3 dummy node：表頭也有前驅

203. Remove Linked List Elements 要移除所有值等於 val 的節點。若表頭也要刪，容易出現額外分支；先接一個不屬於答案的假節點，就能統一處理：

```ts
function removeElements(head: ListNode | null, val: number): ListNode | null {
  const dummy = new ListNode(0, head);
  let prev = dummy;
  while (prev.next !== null) {
    if (prev.next.val === val) {
      prev.next = prev.next.next;
    } else {
      prev = prev.next;
    }
  }
  return dummy.next;
}
```

刪除後不要立刻前進 prev，因為新的 `prev.next` 也可能要刪。例如 `[6, 6, 1]` 刪 6，需連續兩次改同一個前驅的 next。

時間 O(n)、額外空間 O(1)。這段會改動原串列的連結；dummy 的值本身不參與判斷。

## 6.4 核心題：206. Reverse Linked List

要把 `1 → 2 → 3 → null` 變成 `3 → 2 → 1 → null`，每一步都把目前節點接到「已反轉部分」前面。

```ts
function reverseList(head: ListNode | null): ListNode | null {
  let prev: ListNode | null = null;
  let current = head;
  while (current !== null) {
    const next: ListNode | null = current.next;
    current.next = prev;
    prev = current;
    current = next;
  }
  return prev;
}
```

迴圈開始時的契約是：prev 指向已反轉的前半段，current 指向尚未處理的後半段。必須先保存 next，否則改掉 `current.next` 後，就找不到剩下的串列。

| 步驟 | 已反轉部分 prev | 尚未處理 current |
|------|----------------|------------------|
| 初始 | null | 1 → 2 → 3 |
| 第一次後 | 1 → null | 2 → 3 |
| 第二次後 | 2 → 1 → null | 3 |
| 結束 | 3 → 2 → 1 → null | null |

時間 O(n)、額外空間 O(1)。空串列回傳 null，單節點也不需要特殊分支。

## 6.5 快慢指標：把步速差變成資訊

找中點時，slow 每次走一步，fast 每次走兩步。fast 到尾端時，slow 走過約一半。

141. Linked List Cycle 使用同一個步速差判斷有沒有環：

```ts
function hasCycle(head: ListNode | null): boolean {
  let slow = head;
  let fast = head;
  while (fast !== null && fast.next !== null) {
    slow = slow!.next;
    fast = fast.next.next;
    if (slow === fast) return true;
  }
  return false;
}
```

檢查相等放在移動後，避免把初始同在 head 誤判成有環。fast 能走兩步時，slow 還能走一步，所以此處非空斷言有依據。

若有環，兩者進環後，相對位置每輪前進一格，至多再走一圈就會相遇。若無環，fast 最終走到 null。時間 O(n)、額外空間 O(1)。

不要把快慢指標與第 03 章的滑動視窗混為一談：這裡沒有區間計數，依賴的是節點步速與環的結構。

## 6.6 邊界與操作順序

- 空串列、單節點、全部刪除、連續刪除都要檢查。
- 想改 `node.next` 之前，先確認後續還需不需要原來的 next。
- 函式若可能改變表頭，要回傳新的 head。
- 使用遞迴反轉也可行，但需要 O(n) 呼叫堆疊；不是 O(1) 額外空間。
- 題目若要求保留原串列，就不能直接套用會修改連結的版本。

## 課後練習與自我檢查

| 階段 | 題目 | 練習目的 |
|------|------|----------|
| 暖身 | 203. Remove Linked List Elements | dummy node 與連續刪除 |
| 核心 | 206. Reverse Linked List | 保存 next，再修改連結 |
| 變形 | 876. Middle of the Linked List；141. Linked List Cycle | 快慢指標與節點身分 |
| 挑戰 | 19. Remove Nth Node From End of List | dummy node 與固定指標間距 |

過關條件：不用執行程式也能畫出每次改連結後的串列，並解釋為什麼剩餘節點沒有遺失。

---

[上一章：05](./05-binary-search.md) · [課程目錄](./README.md) · [下一章：07](./07-stack-queue-monotonic.md)
