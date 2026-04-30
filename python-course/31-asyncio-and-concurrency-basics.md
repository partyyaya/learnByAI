# 31｜非同步與併發基礎（asyncio）

> 這章會幫你理解「怎麼讓程式在等待 I/O 時不浪費時間」。你會學會 `async/await`、`gather`、任務管理，以及何時使用執行緒或多進程。

## 學習目標

- 理解同步、併發、平行的差異。
- 熟悉 `async def`、`await`、event loop 基本概念。
- 能用 `asyncio.gather` 併發執行多個 I/O 任務。
- 知道 asyncio 的適用邊界與常見錯誤。

## 前置條件

- 已完成函式、例外處理與 HTTP API 基礎。

## 先建立觀念

- **同步（synchronous）**：一件做完才做下一件。
- **併發（concurrency）**：同時間管理多件事的進度。
- **平行（parallelism）**：真正同時在多核心執行。

asyncio 主要解決 I/O 密集任務的併發效率。

## 第一個 asyncio 範例

```python
import asyncio


async def hello():
    print("start")
    await asyncio.sleep(1)
    print("end")


asyncio.run(hello())
```

`await` 表示「這裡可暫停，讓事件迴圈去跑其他任務」。

## 併發執行：`gather`

```python
import asyncio


async def task(name: str, delay: float):
    print(f"{name} start")
    await asyncio.sleep(delay)
    print(f"{name} done")
    return name


async def main():
    results = await asyncio.gather(
        task("A", 2),
        task("B", 1),
        task("C", 3),
    )
    print(results)


asyncio.run(main())
```

總耗時接近最長任務時間，而非三者相加。

## 建立任務：`create_task`

```python
import asyncio


async def worker():
    await asyncio.sleep(1)
    return "ok"


async def main():
    t = asyncio.create_task(worker())
    print("do something else")
    result = await t
    print(result)


asyncio.run(main())
```

## 逾時控制：`asyncio.wait_for`

```python
import asyncio


async def slow_job():
    await asyncio.sleep(5)
    return "done"


async def main():
    try:
        result = await asyncio.wait_for(slow_job(), timeout=2)
        print(result)
    except TimeoutError:
        print("任務逾時")


asyncio.run(main())
```

## 例外處理與 `gather`

```python
results = await asyncio.gather(
    task1(),
    task2(),
    return_exceptions=True,
)
```

`return_exceptions=True` 可收集錯誤而不是整體中斷。

## 非同步 HTTP 概念（簡述）

若要大量並發 HTTP 請求，通常搭配 `aiohttp` 等 async client。  
同時仍要注意：

- 連線數限制
- API 限流
- 逾時與重試策略

## 什麼情況適合 asyncio

- 大量網路請求
- 高頻檔案或 I/O 等待
- 需要同時管理多個 I/O 工作

## 什麼情況不適合 asyncio

- 純 CPU 密集計算（影像處理、重演算法）
- 這類任務更適合 `multiprocessing` 或外部計算服務。

## 執行緒與多進程快速比較

- `threading`：適合 I/O 併發；共享記憶體但需小心競態。
- `multiprocessing`：適合 CPU 密集；啟動成本較高。

## `concurrent.futures` 入門

```python
from concurrent.futures import ThreadPoolExecutor
import time


def io_job(x):
    time.sleep(1)
    return x * 2


with ThreadPoolExecutor(max_workers=4) as ex:
    results = list(ex.map(io_job, [1, 2, 3, 4]))

print(results)
```

這是不用改成 async 也能做併發的方案。

## 常見錯誤與排查

### 錯誤 1：忘記 `await`

會得到 coroutine 物件而不是結果。  
修正：在 async context 對 coroutine 使用 `await`。

### 錯誤 2：在 async 函式中呼叫阻塞程式

例如直接 `time.sleep()` 會卡住 event loop。  
修正：改 `await asyncio.sleep()` 或放到 thread pool。

### 錯誤 3：無限制建立大量任務

可能壓垮 API 或本機資源。  
修正：用 semaphore 控制併發量。

### 錯誤 4：例外未集中處理

修正：對 `gather` 結果做錯誤分流與日誌記錄。

## 實務建議

- 先確定瓶頸是 I/O 再導入 asyncio。
- 併發數要可配置，不要硬編碼。
- 先做小型壓測，確認服務端可承受。

## 章末練習

- 必做：寫 5 個模擬 API 任務，用 `gather` 併發執行並比較耗時。
- 必做：加上 timeout 與錯誤處理。
- 選做：用 semaphore 限制同時最多 3 個任務。

## 本章重點回顧

- asyncio 核心價值是提升 I/O 密集任務吞吐量。
- `async/await` + `gather` 是最常用的非同步組合。
- 正確的併發設計必須搭配逾時、限流、錯誤處理。
