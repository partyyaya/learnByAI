# 第 17 章：加權最短路與最小生成樹（選修）

> 先備：[Heap](./10-heap-priority-queue.md)、[貪心](./11-intervals-greedy.md)、[圖遍歷](./12-graphs-dfs-bfs.md) 與 [DSU](./13-topological-sort-union-find.md)。本章的 Dijkstra 搭配第 10 章 Heap 類別，Kruskal 搭配第 13 章 DSU 類別；請將對應類別一併放入程式。

## 17.1 本章目標

1. 分辨最少邊數、最低路徑成本與最低連接總成本。
2. 理解非負權 Dijkstra 的鬆弛、取出順序與過期候選。
3. 用 Kruskal 與 DSU 求無向圖的最小生成樹。

## 17.2 BFS 不再夠用的例子

有向邊為 `A→B=1、B→C=1、A→C=5`。BFS 以邊數分層，會認為直接 A→C 只需一步；但最低成本路徑是 A→B→C，總成本 2。

| 問題 | 合適工具 |
|------|----------|
| 無權或等正權最短路 | BFS |
| 非負權最短路 | Dijkstra |
| 可能有負權邊的最短路 | 需另選 Bellman-Ford 等方法，並處理相關負環 |
| 把所有點接起來，總邊成本最小 | 最小生成樹；不是單一起點的最短路 |

## 17.3 Dijkstra：每次確定目前最近的點

`distance[v]` 保存目前已知從起點到 v 的最小成本。沿邊 u→v、權重 w 嘗試：

```text
candidate = distance[u] + w
若 candidate < distance[v]，更新 distance[v]
```

這叫鬆弛（relaxation）。用小根堆選出候選距離最小的節點；當取出的距離仍是最新值，就可以確定其最短距離。

為什麼非負權重要？若目前最小候選為 d，任何尚未確定的路徑都不可能靠加上非負邊變得比 d 更小。若有負權邊，這個確定順序就失去保證。

### 完整實作

契約：節點 `0..n-1`、n≥1、start 合法、邊權非負且路徑和在安全整數範圍內。輸入 edges 是有向邊；要表示無向邊時須提供兩個方向。

```ts
function dijkstra(n: number, edges: number[][], start: number): number[] {
  const graph: [number, number][][] = Array.from({ length: n }, () => []);
  for (const [from, to, weight] of edges) {
    if (weight < 0) throw new RangeError('Dijkstra requires non-negative weights');
    graph[from].push([to, weight]);
  }
  const distance = new Array<number>(n).fill(Infinity);
  const heap = new Heap<[number, number]>((a, b) => a[0] - b[0]);
  distance[start] = 0;
  heap.push([0, start]);
  while (heap.size > 0) {
    const [cost, node] = heap.pop()!;
    if (cost !== distance[node]) continue;
    for (const [next, weight] of graph[node]) {
      const candidate = cost + weight;
      if (candidate < distance[next]) {
        distance[next] = candidate;
        heap.push([candidate, next]);
      }
    }
  }
  return distance;
}
```

不可達節點保留 Infinity。本實作不做 decrease-key，而是把更好的距離再推入堆，舊紀錄留待取出時丟棄。

### 為什麼不能入堆就標成已完成？

在上面的 A、B、C 範例中，C 先以成本 5 入堆，之後又透過 B 改善成 2。若第一次入堆就永久忽略 C，會漏掉更短路。

先取出成本 2 的 C 後，成本 5 的舊紀錄仍可能在堆裡。`cost !== distance[node]` 就是在辨識這種過期候選，不應再次展開它。

### 複雜度

建圖與距離陣列 O(V+E)，每次成功鬆弛至多對應一條邊，堆最壞保存 O(E) 筆紀錄。本版本可給時間 O(V + E log(E+2))、額外空間 O(V+E) 的上界。對簡單圖常寫成 O((V+E) log V)。若採真正的 decrease-key Heap，空間與分析方式會不同。

## 17.4 核心題：743. Network Delay Time

節點編號為 1..n，從 k 發訊號，要等最慢的可達節點也收到。若有任何節點不可達，回傳 -1。

```ts
function networkDelayTime(times: number[][], n: number, k: number): number {
  const edges = times.map(([from, to, weight]) => [from - 1, to - 1, weight]);
  const distance = dijkstra(n, edges, k - 1);
  let answer = 0;
  for (const cost of distance) {
    if (cost === Infinity) return -1;
    answer = Math.max(answer, cost);
  }
  return answer;
}
```

注意答案是所有最短距離的最大值，不是相加。不同路徑可同時傳播，不能把整張圖的耗時全部加總。

## 17.5 MST：連接所有點的最小總成本

最小生成樹處理無向圖，目標是選出連接所有節點、沒有環的 n−1 條邊，讓總權重最小。它不保證從某個起點到每個節點的路徑各自最短。

例如無向三角形 `A-B=2、B-C=2、A-C=3`：MST 選前兩條，總成本 4，但 A 到 C 的樹上路徑成本 4，比原圖直接邊的成本 3 大。

### Kruskal：按邊權排序，跳過成環的邊

1. 開始時每個節點是獨立集合。
2. 從最小邊開始看；若端點屬於不同集合，就選取並合併。
3. 若已同組，該邊會成環，跳過。
4. 選滿 n−1 條代表連通；否則原圖不連通，沒有生成樹。

為什麼最小跨集合邊可以選？把目前某個連通分量與其餘節點分開，這條候選是跨過此切割的最小邊之一。若最佳生成樹沒有它，加入後形成的環上必有另一條跨切割邊；用候選替換不會增加成本。這是貪心的切割／交換論證。

### 完整實作

契約為無向圖、n≥1、編號 `0..n-1`。每條無向邊列一次即可，權重可以為負；所有和需在安全整數範圍內。本函式用 null 表示不連通。

```ts
function minimumSpanningTreeCost(n: number, edges: number[][]): number | null {
  const sorted = edges.map(([u, v, weight]) => [u, v, weight])
    .sort((a, b) => a[2] - b[2]);
  const dsu = new DSU(n);
  let total = 0;
  let taken = 0;
  for (const [u, v, weight] of sorted) {
    if (!dsu.union(u, v)) continue;
    total += weight;
    taken++;
    if (taken === n - 1) break;
  }
  return taken === n - 1 ? total : null;
}
```

單節點且無邊回傳 0。排序時間 O(E log(E+1))，加上 DSU 初始化 O(V) 與操作 O(E·α(V))；複製邊與 DSU 占 O(E+V) 空間，另計排序工作空間。

1584. Min Cost to Connect All Points 可以把每對點之間的曼哈頓距離視為邊，再用此函式。但會產生 O(n²) 條邊，不能在分析時只把 E 當成 n。Prim 的稠密圖版本可作後續優化。

## 17.6 適用範圍與延伸

- Dijkstra 的條件是非負權，零權邊也可處理。
- 負權邊不一定形成負環；兩者是不同問題。
- 若從起點可到某個負環，且該環又能到達目標，該目標就沒有有限的最短路徑成本。
- 一般 MST 針對無向圖；有向圖的連接最佳化是不同模型。
- 所有點對的最短路、負權最短路、0/1 權重圖，可再學 Floyd-Warshall、Bellman-Ford、0-1 BFS，不必在第一輪一次學完。

## 課後練習與自我檢查

| 階段 | 題目 | 練習目的 |
|------|------|----------|
| 暖身 | 自訂：A→B=1、B→C=1、A→C=5 | 手動追蹤堆與過期候選 |
| 核心 | 743. Network Delay Time | Dijkstra、不可達與編號轉換 |
| 變形 | 1584. Min Cost to Connect All Points | 建立無向加權邊，使用 Kruskal |
| 挑戰 | 1631. Path With Minimum Effort | 路徑成本改成最大邊權，重新推導鬆弛規則 |

過關條件：能說明 BFS、Dijkstra、MST 各自最佳化的是什麼，且不在入堆時把尚可改善的距離永久鎖定。

---

[上一章：16](./16-bits-state-compression.md) · [課程目錄](./README.md)
