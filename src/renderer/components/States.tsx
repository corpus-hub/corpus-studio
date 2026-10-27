import { Component, type ErrorInfo, type ReactNode } from 'react'

// Skeleton shimmer line/block (uses .sk in styles.css).
export function Skeleton({ h = 16, w = '100%', style }: { h?: number; w?: number | string; style?: React.CSSProperties }): JSX.Element {
  return <div className="sk" style={{ height: h, width: w, ...style }} />
}

export function SkeletonRows({ rows = 4 }: { rows?: number }): JSX.Element {
  return (
    <div className="sk-stack" data-testid="loading">
      {Array.from({ length: rows }).map((_, i) => (
        <Skeleton key={i} h={18} w={`${90 - i * 6}%`} />
      ))}
    </div>
  )
}

export function ErrorState({ error, onRetry }: { error: string; onRetry?: () => void }): JSX.Element {
  return (
    <div className="card state-error" data-testid="error-state" style={{ borderColor: 'var(--danger)' }}>
      <div className="card-title" style={{ color: 'var(--danger)' }}>
        Something went wrong
      </div>
      <div className="mono state-error-msg">{error}</div>
      {onRetry && (
        <button className="btn btn-secondary" onClick={onRetry} style={{ marginTop: 10 }}>
          Retry
        </button>
      )}
    </div>
  )
}

export function EmptyState({
  title,
  hint,
  children,
  testid
}: {
  title: string
  hint?: string
  children?: ReactNode
  testid?: string
}): JSX.Element {
  return (
    <div className="card empty-state" data-testid={testid ?? 'empty-state'}>
      <div className="empty-state-title">{title}</div>
      {hint && <div className="empty-state-hint">{hint}</div>}
      {children}
    </div>
  )
}

/**
 * Top-level render error boundary. The per-screen async error path already
 * surfaces failures via `ErrorState` (testid `error-state`); this catches any
 * *render* exception so a screen can never blank the whole app. It exposes a
 * stable `data-testid="app-error-boundary"` so tests can assert its ABSENCE
 * (a green cold-nav run must show neither this nor `error-state`).
 */
export class ErrorBoundary extends Component<
  { children: ReactNode },
  { error: Error | null }
> {
  constructor(props: { children: ReactNode }) {
    super(props)
    this.state = { error: null }
  }

  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Keep a console trace for the e2e console-error assertions / debugging.
    // eslint-disable-next-line no-console
    console.error('Unhandled render error:', error, info.componentStack)
  }

  render(): ReactNode {
    if (this.state.error) {
      return (
        <div className="app-error-boundary" data-testid="app-error-boundary">
          <ErrorState
            error={this.state.error.message}
            onRetry={() => this.setState({ error: null })}
          />
        </div>
      )
    }
    return this.props.children
  }
}

/**
 * Wraps a data view: shows skeleton while loading, error card on failure,
 * empty state when data is present-but-empty, otherwise the children render fn.
 */
export function DataView<T>({
  state,
  isEmpty,
  empty,
  skeleton,
  children
}: {
  state: { data: T | null; loading: boolean; error: string | null; reload: () => void }
  isEmpty?: (d: T) => boolean
  empty?: ReactNode
  skeleton?: ReactNode
  children: (d: T) => ReactNode
}): JSX.Element {
  if (state.loading && state.data === null) return <>{skeleton ?? <SkeletonRows />}</>
  if (state.error) return <ErrorState error={state.error} onRetry={state.reload} />
  if (state.data === null) return <>{skeleton ?? <SkeletonRows />}</>
  // "Nothing found" is a CONCLUSION, and it cannot be drawn while the answer is
  // still being fetched. On a re-fetch `data` still holds the PREVIOUS result,
  // so an empty one (the initial state of any search box) rendered the empty
  // state for the whole duration of the next search — the user was told their
  // query had failed before it had been asked.
  //
  // Stale NON-empty data keeps rendering while the new load runs, which avoids
  // flicker on reload; only the empty conclusion waits for the truth.
  if (isEmpty && isEmpty(state.data)) {
    if (state.loading) return <>{skeleton ?? <SkeletonRows />}</>
    return <>{empty ?? <EmptyState title="Nothing here yet." />}</>
  }
  return <>{children(state.data)}</>
}
