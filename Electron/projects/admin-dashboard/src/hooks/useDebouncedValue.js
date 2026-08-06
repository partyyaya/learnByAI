import { useEffect, useState } from "react";

/**
 * 搜尋框用。每打一個字就送一次請求太浪費，等使用者停手 delay 毫秒才送。
 *
 * 回傳的是「延遲後的值」，所以 useApi 的 deps 放這個而不是輸入框的即時值。
 * 輸入框本身仍然是即時更新的，不會有打字延遲的感覺。
 */
export function useDebouncedValue(value, delay = 350) {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay);
    // value 在 delay 內又變了就取消上一個 timer，等於「重新計時」
    return () => clearTimeout(timer);
  }, [value, delay]);

  return debounced;
}
