# 第 13 章：拓撲排序與並查集

> 先備：[第 12 章](./12-graphs-dfs-bfs.md) 的建圖、連通塊與 BFS。

## 13.1 本章目標

1. 用入度表示尚未滿足的依賴，實作 Kahn 拓撲排序。
2. 用處理節點數判斷有向圖是否存在環。
3. 用路徑壓縮與按大小合併實作 DSU。
4. 分清有向依賴與無向連通性，不把兩種工具混用。

## 13.2 拓撲排序（Topological Sort）

### 13.2.1 它在解什麼？

拓撲排序處理的是：

- **有向無環圖（DAG）**
- 且邊表示「先後依賴關係」

例如：

- 修課先修關係
- 任務依賴
- 建構順序

### 13.2.2 Kahn 演算法（入度法）

步驟：

1. 統計每個節點的 **入度**
2. 把所有入度為 0 的點放進 queue
3. 每次取出一個點，視為「可以先做」
4. 刪掉它對外的邊，鄰居入度减 1
5. 若鄰居入度變 0，就加入 queue

示意圖：

```text
先修關係：
A -> C
B -> C
C -> D

初始入度：
A:0  B:0  C:2  D:1

queue 初始放入 [A, B]

取出 A 後：
C 入度 2 -> 1

取出 B 後：
C 入度 1 -> 0，C 進 queue

取出 C 後：
D 入度 1 -> 0，D 進 queue

拓撲順序可為：
A, B, C, D
```

### 13.2.3 如何判斷有沒有環？

若最後能被取出的節點數量 **小於總節點數**，表示：

- 有些點永遠無法變成入度 0
- 代表圖中存在環

---

## 13.3 並查集（Union-Find / DSU）

並查集適合處理的問題是：

> 一堆元素分成若干集合，過程中不斷合併，並查詢兩個元素是否屬於同一組

### 13.3.1 兩個核心操作

1. `find(x)`：找出 `x` 所屬集合的代表元
2. `union(a, b)`：把 `a` 與 `b` 所在集合合併

示意圖：

```text
一開始每個點都是自己的老大：
1   2   3   4

union(1, 2) 後：
1 <- 2

union(3, 4) 後：
3 <- 4

union(2, 4) 後，兩群合併：
1 <- 2
^
|
3 <- 4

此時 find(2) 與 find(4) 會找到同一個代表元，
表示它們已屬於同一組。
```

### 13.3.2 常見用途

- 判斷連通性
- 動態合併群組（新增連結；標準 DSU 不支援刪邊後拆分）
- 偵測無向圖成環
- 最小生成樹（Kruskal）

### 13.3.3 為什麼它快？

搭配：

- **路徑壓縮（path compression）**
- **按秩 / 按大小合併（union by rank/size）**

初始化 O(n)，一系列操作的每次均攤時間為 O(α(n))，α 是反 Ackermann 函式，成長非常慢。這不是保證每次單一操作最壞 O(1)。

### 13.3.4 它不擅長什麼？

並查集擅長回答：

- 這兩點有沒有在同一個連通塊？

但它不會直接告訴你：

- 具體路徑是什麼
- 拓撲順序是什麼
- 最短路是多少

所以不要把 DSU 當萬用圖工具。

---

### 13.3.5 可重用的 DSU 實作

契約為元素編號 `0..n-1`。parent 指向父節點，根的 parent 是自己；只有根的 size 有效。

```ts
class DSU {
  private parent: number[];
  private sizes: number[];
  components: number;

  constructor(n: number) {
    this.parent = Array.from({ length: n }, (_, i) => i);
    this.sizes = new Array<number>(n).fill(1);
    this.components = n;
  }

  find(x: number): number {
    while (x !== this.parent[x]) {
      this.parent[x] = this.parent[this.parent[x]];
      x = this.parent[x];
    }
    return x;
  }

  union(a: number, b: number): boolean {
    let rootA = this.find(a);
    let rootB = this.find(b);
    if (rootA === rootB) return false;
    if (this.sizes[rootA] < this.sizes[rootB]) {
      [rootA, rootB] = [rootB, rootA];
    }
    this.parent[rootB] = rootA;
    this.sizes[rootA] += this.sizes[rootB];
    this.components--;
    return true;
  }
}
```

find 用路徑折半，把節點往祖父接近；union 把較小樹接到較大樹，避免一直形成長鏈。只有原本不同集合被合併時，components 才減一。

在逐條加入無向邊時，若 union 回傳 false，表示端點本來就已連通；對一般無向簡單圖，加入該邊會成環。這個規則不能直接拿來判斷有向環。

例如有向邊 `0→1、0→2、1→2` 沒有環，卻會在忽略方向做第三次 union 時發現端點已連通。

## 13.4 核心實作：有向依賴

### 題目：207. Course Schedule（課表）

- **連結**：[https://leetcode.com/problems/course-schedule/](https://leetcode.com/problems/course-schedule/)

#### 題意（白話）

總共有 `numCourses` 門課，編號 `0` 到 `numCourses - 1`。
`prerequisites[i] = [a, b]` 表示：

- 想修 `a`，必須先修 `b`

請判斷是否有可能修完所有課。

#### 為什麼選這題當本章收尾？

1. 它是 **有向圖 + 依賴關係** 的標準題。
2. 可以直接練習 **拓撲排序** 與 **環檢測**。
3. 題目名字直白，能幫你把「入度 = 尚未滿足的前置條件數」這個概念記住。

#### 建圖方式

若 `b -> a`，表示：

- 修完 `b` 之後，`a` 才有資格被修

所以：

- 鄰接串列裡，把 `a` 放到 `graph[b]`
- 同時 `indegree[a]++`

#### 演算法思路（Kahn）

1. 先把所有入度為 0 的課放進 queue，表示它們不需要前置課。
2. 每拿出一門課，就代表成功修完一門。
3. 把它指向的後續課入度减 1。
4. 若某門課入度變成 0，就代表它的前置條件已全部滿足，可以入隊。
5. 最後若修完課數等於 `numCourses`，就代表可以完成；否則圖中有環。

#### 參考實作（TypeScript）

```ts
function canFinish(numCourses: number, prerequisites: number[][]): boolean {
  const graph: number[][] = Array.from({ length: numCourses }, () => []);
  const indegree = new Array<number>(numCourses).fill(0);

  for (const [course, pre] of prerequisites) {
    graph[pre].push(course);
    indegree[course]++;
  }

  const queue: number[] = [];
  let head = 0;

  for (let i = 0; i < numCourses; i++) {
    if (indegree[i] === 0) {
      queue.push(i);
    }
  }

  let taken = 0;

  while (head < queue.length) {
    const cur = queue[head++];
    taken++;

    for (const next of graph[cur]) {
      indegree[next]--;
      if (indegree[next] === 0) {
        queue.push(next);
      }
    }
  }

  return taken === numCourses;
}
```

#### 複雜度整理

- **時間**：每個節點與每條邊都處理一次 → **O(V + E)**
- **空間**：圖與入度陣列 → **O(V + E)**

其中：

- `V` = 課程數
- `E` = 先修關係數

#### 常見錯誤

1. **邊方向畫反**
   `[a, b]` 是 `b -> a`，不是 `a -> b`。

2. **只從某個起點出發**
   圖可能不連通，所以初始時要把所有入度 0 的節點都放進 queue。

3. **用 `shift()` 當 queue**
   在 JS/TS 中大量 `shift()` 可能多出額外成本，常改用陣列 + `head` 指標。

---
## 13.5 連通性實作：547. Number of Provinces

輸入是對稱的 n×n 鄰接矩陣，1 表示兩城市直接相連。搭配上面的 DSU 類別使用：

```ts
function findCircleNum(isConnected: number[][]): number {
  const n = isConnected.length;
  const dsu = new DSU(n);
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (isConnected[i][j] === 1) dsu.union(i, j);
    }
  }
  return dsu.components;
}
```

只掃矩陣上半部，避免每條無向邊做兩次。掃矩陣已需 O(n²)，加上合併操作，可給 O(n²·α(n)) 的時間上界，額外空間 O(n)。DSU 不會讓讀取整張矩陣的成本消失。

## 13.6 選工具與限制

| 需求 | 適合工具 |
|------|----------|
| 靜態無向圖連通塊 | DFS／BFS 或 DSU |
| 不斷新增連結並問是否同組 | DSU |
| 有向依賴、產生先後順序 | 拓撲排序 |
| 判斷有向圖是否有環 | Kahn 或有遞迴中狀態的 DFS |
| 刪除連結後重新拆分集合 | 標準 DSU 無法直接處理 |
| 求兩點間路徑與距離 | DFS／BFS／最短路，DSU 不保存路徑 |

Kahn 的輸出不一定唯一；同時有多個入度為 0 的點時，選誰先處理都可能合法。若處理數不足，只能斷定圖中有環，剩下的點也可能只是被環阻擋，不代表每個剩餘點本身都在環上。

## 課後練習與自我檢查

| 階段 | 題目 | 練習目的 |
|------|------|----------|
| 暖身 | 547. Number of Provinces | 與前章 DFS 比較，熟悉 find／union |
| 核心 | 207. Course Schedule | 入度、方向、處理節點數 |
| 變形 | 210. Course Schedule II | 從是否可行改成輸出拓撲順序 |
| 挑戰 | 684. Redundant Connection | 找出使無向圖成環的新增邊 |

過關條件：能說明重複 union 為何不減少 components，以及有向環不能直接套用無向 DSU 判斷。

---

[上一章：12](./12-graphs-dfs-bfs.md) · [課程目錄](./README.md) · [下一章：14](./14-dynamic-programming.md)
