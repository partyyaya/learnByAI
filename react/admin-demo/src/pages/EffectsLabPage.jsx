import { useEffect, useState } from 'react'
import PageHeader from '@/components/ui/PageHeader'
import Card from '@/components/ui/Card'
import Spinner from '@/components/ui/Spinner'
import { EmptyState } from '@/components/ui/StateBlock'

// Effects 實驗室（第 07 章）：手寫 useEffect + AbortController + loading/error/data。
// 這是「進 TanStack Query 之前」的原生寫法，放在這裡對照，能體會 Query 幫我們省了多少樣板。
//
// fakeFetch 模擬一支支援中止（abort）的 API，避免依賴外部網路。切換資料集時，
// cleanup 會 abort 前一個請求，示範如何避免「舊請求晚回來覆蓋新資料」的競態問題。

const DATASETS = {
  1: ['需求訪談整理', '架構草圖', '技術選型評估'],
  2: ['元件拆分', 'API 契約確認', '權限設計', 'Mock 資料建立'],
  3: ['效能量測', '無障礙檢查', '上線前檢查表', '監控告警', '回滾演練'],
}

function fakeFetch(datasetId, signal, slow) {
  const delay = slow ? 1500 : 500
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      resolve(DATASETS[datasetId] || [])
    }, delay)

    // 收到 abort 訊號時清掉 timer 並丟出 AbortError
    signal.addEventListener('abort', () => {
      clearTimeout(timer)
      const err = new Error('Aborted')
      err.name = 'AbortError'
      reject(err)
    })
  })
}

function EffectsLabPage() {
  const [datasetId, setDatasetId] = useState(1)
  const [slow, setSlow] = useState(false)
  const [items, setItems] = useState([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    const controller = new AbortController()

    async function load() {
      try {
        setLoading(true)
        setError('')
        const data = await fakeFetch(datasetId, controller.signal, slow)
        setItems(data)
      } catch (err) {
        // 被 abort 的請求不算錯誤（是我們主動取消的）
        if (err.name !== 'AbortError') setError(err.message || '載入失敗')
      } finally {
        // 注意：被 abort 時這裡仍會執行，但因為新 effect 已接手，畫面不受影響
        if (!controller.signal.aborted) setLoading(false)
      }
    }

    load()

    // cleanup：切換資料集或卸載時，中止尚未回來的請求
    return () => controller.abort()
  }, [datasetId, slow])

  // 另一個副作用：同步更新頁面標題（非 API 的 side effect 範例）
  useEffect(() => {
    document.title = `資料集 ${datasetId} · Effects 實驗室`
    return () => {
      document.title = 'React Admin Demo'
    }
  }, [datasetId])

  return (
    <div className="page">
      <PageHeader
        title="Effects 實驗室"
        chapter="第 07 章 · useEffect + AbortController"
        subtitle="手寫資料抓取的原生寫法：loading / error / data 三態 + 競態處理。"
      />

      <Card>
        <div className="toolbar">
          <div className="switches">
            {[1, 2, 3].map((id) => (
              <button
                key={id}
                className={`chip ${datasetId === id ? 'is-active' : ''}`}
                onClick={() => setDatasetId(id)}
              >
                資料集 {id}
              </button>
            ))}
          </div>
          <label className="checkbox">
            <input
              type="checkbox"
              checked={slow}
              onChange={(e) => setSlow(e.target.checked)}
            />
            模擬慢速回應（快速切換可觀察 abort 防競態）
          </label>
        </div>

        {loading && <Spinner />}
        {error && <p className="login-card__error">錯誤：{error}</p>}
        {!loading && !error && items.length === 0 && <EmptyState />}
        {!loading && !error && items.length > 0 && (
          <ul className="plain-list">
            {items.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        )}
      </Card>

      <Card title="對照：TanStack Query 版">
        <p className="muted">
          同樣的需求，用 <code>useQuery</code> 只需要 queryKey + queryFn，
          loading / error / 快取 / 重抓都內建（見「儀表板」「課程管理」頁）。
          這就是第 09 章開始改用 Query 的原因。
        </p>
      </Card>
    </div>
  )
}

export default EffectsLabPage
