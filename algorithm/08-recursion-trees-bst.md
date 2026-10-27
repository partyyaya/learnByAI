# 第 08 章：遞迴、二元樹與 BST

> 先備：[鏈結串列](./06-linked-lists.md) 的節點參考與 [堆疊、佇列](./07-stack-queue-monotonic.md)。本章先建立遞迴契約，再處理樹。

## 8.1 本章目標

1. 說清楚遞迴函式的輸入、回傳值、終止條件與縮小方式。
2. 區分前序、中序、後序與層序走訪。
3. 分析節點數 n、樹高 h 與最大層寬 w 的影響。
4. 理解 BST 的全域範圍限制，而非只比較父子。

## 8.2 遞迴不是「先假裝它會自己算」

每個遞迴函式都要先回答四個問題：

| 問題 | 以樹深度為例 |
|------|--------------|
| 這次呼叫解什麼？ | 回傳以 root 為根的子樹高度 |
| 何時可直接回答？ | 空樹高度是 0 |
| 下一次問題如何變小？ | 分別處理左右子樹 |
| 如何組成答案？ | 左右高度取最大，再加目前節點一層 |

函式回傳時，呼叫端的區域變數仍保留在自己的堆疊框架中。遞迴深度與總呼叫數是兩回事：平衡樹雖然深度 O(log n)，走遍全部節點仍需 O(n) 次工作。

## 8.3 二元樹的表示

二元樹每個節點至多有兩個孩子。以下類別供本章共用；評測若提供 TreeNode，就使用它的定義。

```ts
class TreeNode {
  constructor(
    public val: number = 0,
    public left: TreeNode | null = null,
    public right: TreeNode | null = null,
  ) {}
}
```

本章的輸入是合法樹，沿 left／right 不會遇到環，也不會讓兩個父節點共用同一個孩子。若資料可能違反這個契約，就要當一般圖處理。

## 8.4 核心題：104. Maximum Depth of Binary Tree

```ts
function maxDepth(root: TreeNode | null): number {
  if (root === null) return 0;
  const leftDepth = maxDepth(root.left);
  const rightDepth = maxDepth(root.right);
  return 1 + Math.max(leftDepth, rightDepth);
}
```

```text
      3
     / \
    9  20
      /  \
     15   7

空節點回傳 0
9、15、7 回傳 1
20 收到 1、1，回傳 2
3 收到 1、2，回傳 3
```

每個節點計算一次，時間 O(n)。呼叫堆疊最多保存一條根到葉的路徑，空間 O(h)：平衡時 O(log n)，退化成鏈時 O(n)。

這也是一種分治：分別求出子問題，再合併回來。不能只看函式裡有兩個遞迴呼叫就判斷為 O(2ⁿ)，要看不同呼叫究竟處理多少資料、是否重複。

## 8.5 前序、中序、後序是「何時處理自己」

```text
       2
      / \
     1   3

前序：2, 1, 3  （自己 → 左 → 右）
中序：1, 2, 3  （左 → 自己 → 右）
後序：1, 3, 2  （左 → 右 → 自己）
```

若父節點要用孩子的結果，例如樹高、子樹總和，就自然採後序。若要把祖先限制傳下去，例如 BST 範圍，就會在進入孩子之前決定參數。

以下用顯式 stack 寫中序，避免依賴系統遞迴深度：

```ts
function inorderTraversal(root: TreeNode | null): number[] {
  const answer: number[] = [];
  const stack: TreeNode[] = [];
  let current = root;
  while (current !== null || stack.length > 0) {
    while (current !== null) {
      stack.push(current);
      current = current.left;
    }
    const node = stack.pop()!;
    answer.push(node.val);
    current = node.right;
  }
  return answer;
}
```

時間 O(n)、工作空間 O(h)、輸出 O(n)。stack 保存的是「左邊處理完後，還要回來處理的節點」。

## 8.6 層序：102. Binary Tree Level Order Traversal

DFS 先往深處走；BFS 用 queue，先處理距離根近的節點。同一層開始時，先固定本層的 queue 終點，避免把下一層一起吃進來。

```ts
function levelOrder(root: TreeNode | null): number[][] {
  if (root === null) return [];
  const queue: TreeNode[] = [root];
  let head = 0;
  const answer: number[][] = [];
  while (head < queue.length) {
    const end = queue.length;
    const level: number[] = [];
    while (head < end) {
      const node = queue[head++];
      level.push(node.val);
      if (node.left !== null) queue.push(node.left);
      if (node.right !== null) queue.push(node.right);
    }
    answer.push(level);
  }
  return answer;
}
```

時間 O(n)、輸出 O(n)。抽象 queue 的有效節點數是 O(w)，但此處陣列保留已出隊的位置，實際工作空間為 O(n)。

## 8.7 BST：整個子樹都受限制

本章採不允許重複值的 BST 定義：左子樹**所有值**都小於根，右子樹**所有值**都大於根。

```text
      10
     /  \
    5   15
       /  \
      6   20
```

6 小於自己的父節點 15，卻位於 10 的右子樹，所以這不是合法 BST。只比較父子會漏掉這個錯誤。

### 搜尋

```ts
function searchBST(root: TreeNode | null, val: number): TreeNode | null {
  let current = root;
  while (current !== null && current.val !== val) {
    current = val < current.val ? current.left : current.right;
  }
  return current;
}
```

每次選一邊，時間 O(h)、額外空間 O(1)。只有樹高受控時才是 O(log n)；普通 BST 可能退化成 O(n)。

### 驗證：98. Validate Binary Search Tree

```ts
function isValidBST(root: TreeNode | null): boolean {
  function check(node: TreeNode | null, low: number, high: number): boolean {
    if (node === null) return true;
    if (node.val <= low || node.val >= high) return false;
    return check(node.left, low, node.val)
      && check(node.right, node.val, high);
  }
  return check(root, -Infinity, Infinity);
}
```

題目節點值是有限整數，因此可以用無窮作外側界線。時間 O(n)、空間 O(h)。往左把上界縮到目前值，往右把下界提高，祖先限制就不會遺失。

## 課後練習與自我檢查

| 階段 | 題目 | 練習目的 |
|------|------|----------|
| 暖身 | 144. Binary Tree Preorder Traversal | 寫清楚空節點與處理順序 |
| 核心 | 104. Maximum Depth of Binary Tree；102. Binary Tree Level Order Traversal | 後序回傳與 BFS 分層 |
| 變形 | 700. Search in a Binary Search Tree；98. Validate Binary Search Tree | 搜尋方向與祖先範圍 |
| 挑戰 | 236. Lowest Common Ancestor of a Binary Tree | 設計子樹回傳契約；節點身分而非值 |

過關條件：能分辨「遞迴傳入的限制」與「遞迴回傳的答案」，並分析平衡與退化樹的空間差異。

---

[上一章：07](./07-stack-queue-monotonic.md) · [課程目錄](./README.md) · [下一章：09](./09-backtracking.md)
