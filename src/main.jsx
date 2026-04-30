import { Component, StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'

/** 本番ビルドで vite.config の define により埋め込まれる */
// eslint-disable-next-line no-undef
const APP_BUILD_ID = typeof __APP_BUILD_ID__ !== 'undefined' ? __APP_BUILD_ID__ : 'dev'

let versionWatchStarted = false
/** 配信済みの version.json とバンドルIDがずれたら更新案内（手動フルリロード不要に近づける） */
function startClientVersionWatcher() {
  if (versionWatchStarted || typeof window === 'undefined') return
  versionWatchStarted = true
  if (APP_BUILD_ID === 'dev') return

  const versionUrl = () => {
    const base = import.meta.env.BASE_URL || '/'
    const prefix = base.endsWith('/') ? base.slice(0, -1) : base
    return `${prefix || ''}/version.json`
  }

  const check = async () => {
    try {
      const r = await fetch(`${versionUrl()}?t=${Date.now()}`, { cache: 'no-store' })
      if (!r.ok) return
      const data = await r.json()
      const remoteId = String(data?.id ?? '').trim()
      if (!remoteId || remoteId === APP_BUILD_ID) return
      if (window.confirm('アプリが更新されています。再読み込みして最新版を表示しますか？')) {
        window.location.reload()
      }
    } catch {
      /* オフライン等は無視 */
    }
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void check()
  })
  window.setInterval(() => void check(), 60_000)
  void check()
}

startClientVersionWatcher()

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
