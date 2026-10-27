# 第 12 章：圖與網格 DFS／BFS

> 先備：[第 07 章](./07-stack-queue-monotonic.md) 的 stack／queue 與 [第 08 章](./08-recursion-trees-bst.md) 的樹走訪。

## 12.1 本章目標

1. 從節點與邊建立鄰接串列。
2. 用 visited 避免重複走訪，處理不連通的圖。
3. 把網格看成隱含的圖，用 DFS 找連通塊。
4. 用 BFS 求無權最短距離，理解入隊時標記的重要性。

## 12.2 圖比樹多了什麼？

一般圖可能有環、不連通，且邊可能有方向。無向樹是連通且無環的無向圖，n 個節點有 n−1 條邊。

沿二元樹的孩子指標走，不會走回父節點；但用無向鄰接串列表示樹時，A 的鄰居有 B，B 的鄰居也有 A，仍需略過父節點或記錄 visited。

先問三件事：節點是什麼、邊表示什麼、邊是否有方向。課程先修關係是有向邊；道路若雙向通行則要存兩個方向。

## 12.3 表示法與建圖

| 表示法 | 空間 | 適合操作 |
|--------|------|----------|
| 鄰接串列 | O(V+E) | 枚舉一個點的鄰居，適合稀疏圖 |
| 鄰接矩陣 | O(V²) | O(1) 檢查兩點間有沒有邊 |
| 邊列表 | O(E) | 枚舉所有邊；之後 Kruskal 會使用 |

下例契約為節點編號 `0..n-1`，每條邊 `[u,v]` 都是合法編號。

```ts
function buildUndirectedGraph(n: number, edges: number[][]): number[][] {
  const graph: number[][] = Array.from({ length: n }, () => []);
  for (const [u, v] of edges) {
    graph[u].push(v);
    graph[v].push(u);
  }
  return graph;
}
```

不能用 `new Array(n).fill([])`，否則所有節點會共用同一個鄰居陣列。有向圖則只存題意指定的方向。

## 12.4 DFS：先走完一個連通塊

下面以顯式 stack 避免深遞迴。契約是輸入為無向圖的鄰接串列；有向圖的可達關係不能直接當成無向連通塊。

```ts
function countComponents(graph: number[][]): number {
  const visited = new Array<boolean>(graph.length).fill(false);
  let components = 0;
  for (let start = 0; start < graph.length; start++) {
    if (visited[start]) continue;
    components++;
    const stack = [start];
    visited[start] = true;
    while (stack.length > 0) {
      const node = stack.pop()!;
      for (const next of graph[node]) {
        if (visited[next]) continue;
        visited[next] = true;
        stack.push(next);
      }
    }
  }
  return components;
}
```

外層迴圈不可省略：從某個起點 DFS，只能找到它所屬的連通塊。孤立節點本身也是一個連通塊。

每個節點只進 stack 一次，每條無向邊在兩端各看一次，所以時間 O(V+E)、額外空間 O(V)。這裡的 visited 在整次搜尋中保留；與回溯的 path 狀態不同，不要在返回時撤銷。

## 12.5 核心題：200. Number of Islands

把每格陸地看成節點，上下左右相鄰的陸地之間有邊。圖可以直接由座標計算，不必真的建立所有邊。

契約為矩形網格，元素是 `'0'` 或 `'1'`；下例也允許空網格，且不修改原輸入。

```ts
function numIslands(grid: string[][]): number {
  if (grid.length === 0 || grid[0].length === 0) return 0;
  const rows = grid.length;
  const cols = grid[0].length;
  const seen = Array.from({ length: rows }, () => new Array<boolean>(cols).fill(false));
  const directions = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  let islands = 0;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (grid[r][c] !== '1' || seen[r][c]) continue;
      islands++;
      const stack: [number, number][] = [[r, c]];
      seen[r][c] = true;
      while (stack.length > 0) {
        const [row, col] = stack.pop()!;
        for (const [dr, dc] of directions) {
          const nr = row + dr;
          const nc = col + dc;
          if (nr < 0 || nr >= rows || nc < 0 || nc >= cols) continue;
          if (grid[nr][nc] !== '1' || seen[nr][nc]) continue;
          seen[nr][nc] = true;
          stack.push([nr, nc]);
        }
      }
    }
  }
  return islands;
}
```

每格最多入 stack 一次，鄰居數固定為四，時間與額外空間都是 O(rows·cols)。若改成直接把陸地塗成水，可以省下 seen，但 stack 最壞仍可能 O(rows·cols)，不能直接宣稱額外空間 O(1)。

對角相接不算同一島。`[['1','0'],['0','1']]` 的答案是 2。

## 12.6 BFS：無權最短距離

在無權圖或每條邊成本相同且為正的圖上，最短成本等價於最少邊數。BFS 保證先處理距離 d 的節點，再處理 d+1。

```ts
function shortestDistances(graph: number[][], start: number): number[] {
  const distance = new Array<number>(graph.length).fill(-1);
  const queue: number[] = [start];
  let head = 0;
  distance[start] = 0;
  while (head < queue.length) {
    const node = queue[head++];
    for (const next of graph[node]) {
      if (distance[next] !== -1) continue;
      distance[next] = distance[node] + 1;
      queue.push(next);
    }
  }
  return distance;
}
```

契約為非空圖且 start 是合法索引；圖可有向或無向。-1 代表不可達，distance 同時充當 visited。

### 為什麼入隊時就標記？

若兩個同層節點都連到 C，在 C 出隊之前它們都可能嘗試加入 C。入隊時標記，才能保證每個節點只入隊一次，並固定第一次發現的最短距離。

時間 O(V+E)，queue 與 distance 共 O(V) 空間。若要回傳路徑，可在第一次發現 next 時記錄 `parent[next] = node`，最後從終點逆向追溯並反轉。

### 多源 BFS

若有多個擴散起點，把所有起點的距離設為 0 並一次入隊，就能求每個節點到最近起點的距離。994. Rotting Oranges 中，所有初始腐爛橘子都必須同時入隊；逐個起點各跑一次不是同一個時間模型。

## 12.7 DFS、BFS 與下一步

| 問題 | 工具與理由 |
|------|------------|
| 可不可達、連通塊數量 | DFS 或 BFS 都可以 |
| 無權最少步數 | BFS，依距離層次擴張 |
| 列出所有合法路徑 | 回溯；是否撤銷 visited 依路徑契約決定 |
| 依賴順序或有向環 | 下一章的拓撲排序；只用布林 visited 不足以區分有向回邊 |
| 邊權不同的最低成本 | 第 17 章；普通 BFS 不再保證成本最短 |

## 課後練習與自我檢查

| 階段 | 題目 | 練習目的 |
|------|------|----------|
| 暖身 | 1971. Find if Path Exists in Graph | 無向建圖與 visited |
| 核心 | 200. Number of Islands | 網格連通塊與四方向邊界 |
| 變形 | 994. Rotting Oranges | 多源 BFS 與不可達的新鮮橘子 |
| 挑戰 | 127. Word Ladder | 自行定義鄰居，計入產生鄰居的成本 |

過關條件：能處理環、孤立點與不連通圖，並解釋 BFS 為什麼第一次發現就是最少步數。

---

[上一章：11](./11-intervals-greedy.md) · [課程目錄](./README.md) · [下一章：13](./13-topological-sort-union-find.md)
