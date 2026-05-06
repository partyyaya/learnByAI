# 10｜測試資料、Fixtures 與可維護性

> 測試套件規模變大後，真正的挑戰常不是寫測試，而是維護測試資料。本章教你把測試資料工程化。

## 學習目標

- 知道 Fixture、Factory、Builder 的差異與使用時機。
- 建立可重用的測試資料生成策略。
- 降低重複 setup 與案例耦合。
- 讓新增測試案例成本可控。

## 前置知識

- 已完成 `09` 章，建立完整測試分層概念。
- 熟悉 TypeScript 物件與函式抽象。

## 三種資料模式

### Fixture（固定樣本）

- 適合：靜態案例、快照對照、簡單測試。
- 風險：欄位變更時需大量同步修改。

### Factory（工廠函式）

- 適合：需要少量覆寫且常重複建立資料。
- 優點：可讀性高、彈性好。

### Builder（建造者）

- 適合：資料結構複雜、需鏈式設定多種情境。
- 代價：初期實作較多。

## Factory 範例

```ts
type User = {
  id: string;
  name: string;
  role: "admin" | "member";
  isActive: boolean;
};

export function makeUser(overrides: Partial<User> = {}): User {
  return {
    id: "u-001",
    name: "Gary",
    role: "member",
    isActive: true,
    ...overrides
  };
}
```

使用方式：

```ts
const admin = makeUser({ role: "admin" });
const inactiveMember = makeUser({ isActive: false });
```

## 專案結構建議

```text
src/
  test/
    factories/
      user.factory.ts
      order.factory.ts
    fixtures/
      users.json
    helpers/
      renderWithProviders.ts
```

## 維護性守則

1. 測試資料命名應反映意圖（`inactiveMember` 比 `user2` 好）。
2. 測試資料應與行為情境直接對應，不要塞無關欄位。
3. 共用 helper 要小而清楚，避免「神級 helper」。
4. 每次重構資料模型時，同步更新 factory 預設值。

## 常見錯誤

- 把 production JSON 直接拿來當 fixture，資料過重且不聚焦。
- 測試間共用可變物件，導致污染。
- helper 過度封裝，閱讀測試時反而看不懂情境。

## 面試與實務延伸

- 你會如何評估何時從 fixture 進化到 factory？
- 當測試資料欄位常變動時，怎麼降低修改範圍？
- 如何平衡 DRY（不重複）與可讀性？

## 本章練習

1. 選 2 個重複度高的測試檔，抽出共用 factory。
2. 用 `renderWithProviders` 類 helper 收斂重複 setup。
3. 將 `user1`、`data2` 這類命名改成情境命名。

## 驗收清單

- [ ] 我能區分 fixture/factory/builder 的使用時機。
- [ ] 新增測試案例不需要大量複製貼上。
- [ ] 測試資料可讀、可重用、可維護。

---

完成後請前往 [11-ci-quality-gates-and-test-reporting.md](./11-ci-quality-gates-and-test-reporting.md)。
