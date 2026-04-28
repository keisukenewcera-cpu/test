import { Component, StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'

class RootErrorBoundary extends Component {
  constructor(props) {
    super(props)
    this.state = { hasError: false, message: '' }
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, message: String(error?.message ?? '不明なエラー') }
  }

  componentDidCatch(error) {
    console.error('[WorkVision] root render failed', error)
  }

  render() {
    if (!this.state.hasError) return this.props.children
    return (
      <div style={{ padding: '24px', fontFamily: 'system-ui, sans-serif' }}>
        <h1 style={{ margin: 0, fontSize: '20px' }}>画面の初期化に失敗しました</h1>
        <p style={{ marginTop: '8px' }}>
          ブラウザを再読み込みしてください。改善しない場合は、開発者コンソールのエラー情報を共有してください。
        </p>
        <pre style={{ whiteSpace: 'pre-wrap', background: '#f5f5f5', padding: '12px', borderRadius: '8px' }}>
          {this.state.message}
        </pre>
      </div>
    )
  }
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <RootErrorBoundary>
      <App />
    </RootErrorBoundary>
  </StrictMode>,
)
