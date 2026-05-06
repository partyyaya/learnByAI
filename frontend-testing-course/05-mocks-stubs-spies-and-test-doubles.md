# 05｜測試替身：Mock、Stub、Spy

> 本章會讓你學會「控制依賴」而不是「偽造整個世界」。測試替身用得好，測試會快又穩；用不好，會變成假測試。

## 學習目標

- 清楚區分 Mock、Stub、Spy 的角色。
- 知道什麼時候應該 mock，什麼時候不該 mock。
- 能為 API、分析追蹤、時間函式等外部依賴建立可控測試。
- 避免過度 mock 造成的脆弱與失真。

## 前置知識

- 已完成 `04` 章，能撰寫元件行為測試。
- 熟悉 `vi.fn()`、`vi.spyOn()` 等基本 API。

## 名詞釐清

### Stub

- 提供固定回傳值，讓流程可預測。
- 常用在 API 回應、設定值、時間來源。

### Mock

- 既能替代依賴，也可驗證互動次數與參數。
- 用來確認某函式「被正確呼叫」。

### Spy

- 監看現有函式呼叫，不一定替換實作。
- 適合追蹤 logger、analytics、事件派送。

## 何時該用測試替身

適合使用：

- 外部系統呼叫（HTTP、Storage、Browser API）。
- 不可控因素（時間、隨機值、網路波動）。
- 成本高且與本次測試目標無關的依賴。

不建議使用：

- 核心商業規則本體。
- 你真正想驗證的邏輯邊界。
- 為了讓測試「看起來比較綠」而強行 mock。

## 範例：追蹤事件呼叫測試

```ts
import { describe, expect, it, vi } from "vitest";
import { checkout } from "./checkout";
import * as analytics from "./analytics";

describe("checkout tracking", () => {
  it("should send purchase event once when checkout succeeds", async () => {
    const trackSpy = vi.spyOn(analytics, "trackEvent").mockImplementation(() => {});

    await checkout({
      items: [{ sku: "A1", qty: 1 }],
      paymentToken: "tok_ok"
    });

    expect(trackSpy).toHaveBeenCalledTimes(1);
    expect(trackSpy).toHaveBeenCalledWith("purchase_success", {
      itemCount: 1
    });
  });
});
```

## 決策指南：先問三件事

1. 這個依賴是否可控？如果不可控，可考慮替身。
2. 這個依賴是否是本測試重點？如果不是，可替代。
3. 替身會不會掩蓋真實風險？如果會，改用整合測試補回。

## 常見錯誤

- 把每個模組都 mock，導致測不到真實行為。
- 在不同測試間共用 mock 狀態，造成污染。
- 只驗證「有被呼叫」，不驗證參數與結果。
- 用 mock 掩蓋錯誤流程，導致線上才爆炸。

## 面試與實務延伸

- 請說明你在專案中如何決定「哪個層級」要 mock API。
- 何時會選擇用 MSW（整合層）取代 unit mock（函式層）？
- 如果 CI 出現偶發失敗，你會先檢查哪些替身設定？

## 本章練習

1. 找一支既有測試，評估是否過度 mock。
2. 將其中 1 個 mock 移除，改用更接近真實的整合測試。
3. 補上「錯誤路徑」驗證，確保替身不掩蓋失敗情境。

## 驗收清單

- [ ] 我能解釋 Mock、Stub、Spy 的差異。
- [ ] 我會在必要時才使用替身。
- [ ] 測試替身不會隱藏高風險問題。

---

完成後請前往 [06-testing-async-state-and-api-calls.md](./06-testing-async-state-and-api-calls.md)。
