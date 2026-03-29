import { Component, type ReactNode } from 'react'
import { AlertTriangle, RefreshCw } from 'lucide-react'

interface Props  { children: ReactNode }
interface State  { error: Error | null }

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  render() {
    if (!this.state.error) return this.props.children

    return (
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        height: '100vh', background: 'var(--bg-base)',
      }}>
        <div className="card slide-in-up" style={{
          maxWidth: 420, width: '90%', padding: '32px 28px', textAlign: 'center',
        }}>
          <div style={{ color: 'var(--red)', marginBottom: 16, display: 'flex', justifyContent: 'center' }}>
            <AlertTriangle size={40} />
          </div>
          <div style={{ fontSize: 16, fontWeight: 600, color: 'var(--text-head)', marginBottom: 8 }}>
            Something went wrong
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-dim)', marginBottom: 24, fontFamily: 'monospace' }}>
            {this.state.error.message}
          </div>
          <button
            className="btn btn-primary"
            onClick={() => window.location.reload()}
            style={{ gap: 6, margin: '0 auto' }}
          >
            <RefreshCw size={13} />
            Reload Dashboard
          </button>
        </div>
      </div>
    )
  }
}
