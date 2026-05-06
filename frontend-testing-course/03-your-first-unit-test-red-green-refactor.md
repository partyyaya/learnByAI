# 03｜第一個單元測試：Red-Green-Refactor

> 這章會帶你從零寫出第一支可運作的單元測試，並真正走完一次 Red-Green-Refactor（RGR）循環。

## 學習目標

- 能獨立寫出第一個單元測試案例。
- 理解 Red-Green-Refactor 的節奏與價值。
- 會寫清楚、可維護的斷言。
- 知道如何為既有程式補第一層保護網。

## 前置條件

- 已完成 `02` 章工具安裝與測試命令設定。
- 專案可執行 `npm run test`。

## 為什麼第一支測試要選「純函式」

純函式通常：

- 輸入與輸出清楚，沒有 UI 或網路依賴。
- 測試快速，失敗原因容易定位。
- 最適合新手建立成功經驗。

## 範例需求：折扣價計算

需求規則：

1. 原價不可小於 0。
2. 折扣率範圍為 0 到 1。
3. 結果四捨五入到小數點後 2 位。

### `src/utils/price.ts`

```ts
export function calcDiscountedPrice(price: number, discountRate: number): number {
  if (price < 0) {
    throw new Error("price must be >= 0");
  }
  if (discountRate < 0 || discountRate > 1) {
    throw new Error("discountRate must be between 0 and 1");
  }

  const result = price * (1 - discountRate);
  return Number(result.toFixed(2));
}
```

## 第一步：先寫失敗測試（Red）

### `src/utils/price.test.ts`

```ts
import { describe, expect, it } from "vitest";
import { calcDiscountedPrice } from "./price";

describe("calcDiscountedPrice", () => {
  it("should return discounted price with 2 decimals", () => {
    expect(calcDiscountedPrice(100, 0.2)).toBe(80);
    expect(calcDiscountedPrice(99, 0.15)).toBe(84.15);
  });

  it("should throw when price is negative", () => {
    expect(() => calcDiscountedPrice(-1, 0.2)).toThrowError("price must be >= 0");
  });

  it("should throw when discountRate is out of range", () => {
    expect(() => calcDiscountedPrice(100, 1.2)).toThrowError(
      "discountRate must be between 0 and 1"
    );
  });
});
```

執行：

```bash
npm run test
```

如果你先寫測試、還沒實作函式，這時應該會看到紅燈，這就是 Red。

## 第二步：寫最小實作讓測試通過（Green）

- 實作剛好足夠通過測試，不要一次加入太多額外邏輯。
- 測試轉綠後再進下一步。

## 第三步：整理程式碼但維持測試綠燈（Refactor）

可做的事情：

- 抽出重複邏輯。
- 改善命名可讀性。
- 補上必要註解或型別。

重點：重構後測試仍維持通過，代表行為沒有被意外改壞。

## 斷言設計技巧

- 優先比對使用者/業務可觀察結果，而不是內部實作。
- 一個測試只驗證一個主要行為，失敗訊號才明確。
- 錯誤訊息應可幫你快速定位原因。

## 新手最常見問題

- 問題：不知道要測哪些 case。
  - 建議：先測「正常路徑 + 邊界值 + 無效輸入」三類。
- 問題：測試很難懂。
  - 建議：測試名稱使用「情境 + 預期」句型，例如 `當折扣為 20% 時應回傳 80`。
- 問題：測試每次都改很大。
  - 建議：表示你可能測到實作細節，請回到行為導向。

## 本章練習

1. 針對你專案中的一個工具函式，寫 3 到 5 個測試案例。
2. 至少包含一個邊界值測試（例如空字串、0、最大值）。
3. 在一次重構後，確認測試仍全部通過。

## 驗收清單

- [ ] 我完成第一個可執行的單元測試檔。
- [ ] 我能說清楚 Red-Green-Refactor 的三步驟。
- [ ] 我知道如何挑選第一批補測目標（純函式優先）。

---

接下來建議進入 `04` 章，開始把測試從函式提升到元件與使用者互動層級。
