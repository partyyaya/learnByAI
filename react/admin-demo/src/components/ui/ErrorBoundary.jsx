import { Component } from 'react'
import Button from './Button'

// Error Boundary（第 13 章）：子元件在渲染、生命週期或 Effect 裡丟出錯誤時，
// 改顯示備用畫面，而不是整個後台變成空白。
// 這是本專案唯一的 class 元件——React 目前沒有對應的 Hook。
// 事件處理器、setTimeout、Promise 裡的錯誤不會被攔；API 錯誤交給 Query 的 isError。
class ErrorBoundary extends Component {
  state = { error: null }

  static getDerivedStateFromError(error) {
    return { error }
  }

  componentDidCatch(error, info) {
    // 實務上會在這裡把錯誤送到錯誤追蹤服務（例如 Sentry）。
    console.error('ErrorBoundary 捕捉到錯誤：', error, info.componentStack)
  }

  // 清掉錯誤、重新渲染子元件。子元件會重新掛載，state 也回到初始值。
  handleRetry = () => {
    this.setState({ error: null })
  }

  render() {
    if (this.state.error) {
      return (
        <div className="fallback-page" role="alert">
          <p className="fallback-page__code">⚠️</p>
          <h1 className="fallback-page__title">這個頁面發生錯誤</h1>
          <p className="muted">可以再試一次，或從側欄切到其他頁面。</p>
          {/* 錯誤細節只在開發模式顯示，正式環境不把內部訊息給使用者看 */}
          {import.meta.env.DEV && (
            <p className="muted">{this.state.error.message}</p>
          )}
          <Button onClick={this.handleRetry}>再試一次</Button>
        </div>
      )
    }
    return this.props.children
  }
}

export default ErrorBoundary
