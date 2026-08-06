import { useCallback, useEffect, useRef, useState } from "react";

/**
 * 把「呼叫 API」的三個狀態（loading / data / error）包成一個 hook。
 *
 *   const { data, error, loading, reload } = useApi(
 *     () => api.get("/users", { page, keyword }),
 *     [page, keyword]
 *   );
 *
 * 兩個容易寫錯、這裡有處理的地方：
 *
 * 1. **競態**：連續打字時 keyword 會變好幾次，先送出的請求不一定先回來。
 *    用一個遞增的 requestId 當「只有最後一次算數」的門檻，回來時發現自己不是
 *    最新的就整包丟掉——否則使用者會看到上一個關鍵字的結果。
 * 2. **卸載後 setState**：元件已經不在畫面上（例如切頁），回應才回來。
 *    同一個 requestId 檢查順便解決這件事（effect 清理時把它作廢）。
 *
 * 重新整理時刻意保留舊的 data（只把 loading 打開），所以換頁 / 換篩選條件時
 * 表格不會先變空白再冒出來。
 */
export function useApi(fetcher, deps = []) {
  const [state, setState] = useState({ data: null, error: null, loading: true });
  const [reloadNonce, setReloadNonce] = useState(0);

  const requestId = useRef(0);
  // fetcher 每次 render 都是新的匿名函式，不能進 deps，否則會無限迴圈。
  // 用 ref 拿到「最新那一個」，真正決定何時重跑的是呼叫端給的 deps。
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  useEffect(() => {
    const id = requestId.current + 1;
    requestId.current = id;

    setState((prev) => ({ ...prev, loading: true, error: null }));

    fetcherRef
      .current()
      .then((data) => {
        if (requestId.current === id) setState({ data, error: null, loading: false });
      })
      .catch((error) => {
        if (requestId.current === id) setState({ data: null, error, loading: false });
      });

    // 清理：讓這次請求作廢，回應回來時就不會再寫 state
    return () => {
      if (requestId.current === id) requestId.current += 1;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, reloadNonce]);

  const reload = useCallback(() => setReloadNonce((value) => value + 1), []);

  return { ...state, reload };
}

/**
 * 「按下去會改資料」的那種呼叫（新增／修改／刪除）用這個。
 * 跟 useApi 的差別是它不會自己跑，而且會擋掉重複點擊。
 */
export function useMutation(mutate) {
  const [pending, setPending] = useState(false);
  const mutateRef = useRef(mutate);
  mutateRef.current = mutate;

  const run = useCallback(async (...args) => {
    setPending(true);
    try {
      return await mutateRef.current(...args);
    } finally {
      setPending(false);
    }
  }, []);

  return { run, pending };
}
