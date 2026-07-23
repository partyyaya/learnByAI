// 型別測試工具 —— 讓「型別」也能寫測試
// 用法見 type-testing.ts

/**
 * 嚴格比較兩個型別是否完全相等（連 readonly、optional 差異都會抓出來）。
 * 這是社群 type-challenges 使用的標準寫法。
 */
export type Equal<X, Y> =
  (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2
    ? true
    : false;

/** 只接受 `true`；若傳入 `false` 就會出現型別錯誤（等於「型別斷言失敗」）。 */
export type Expect<T extends true> = T;

/** 只接受 `false`。 */
export type ExpectFalse<T extends false> = T;

/** 兩型別不相等時為 `true`。 */
export type NotEqual<X, Y> = Equal<X, Y> extends true ? false : true;

/**
 * 執行期輔助：把游標移到參數上，即可在編輯器看到推導出來的型別。
 * 純粹用來「觀察型別」，執行時什麼都不做。
 *
 * @example
 *   expectType(someValue); // hover 看型別
 */
export function expectType<T>(_value: T): void {
  // 故意留空
}
