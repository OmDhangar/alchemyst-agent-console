/**
 * ReconnectBanner.tsx — Non-blocking reconnection indicator
 *
 * When the WebSocket drops, we show a compact banner at the top of the screen.
 * It's non-blocking: the chat stays fully interactive — the user can scroll,
 * copy text, and read while we reconnect in the background.
 *
 * REQUIREMENTS MET
 * ================
 * - Shows within 500ms of connection drop (wsManager transitions immediately)
 * - Displays the current attempt count and estimated wait time
 * - Dismisses automatically when reconnection succeeds
 * - Never covers the chat content (sticky top, not a modal overlay)
 */

'use client'

import { useConsoleStore } from '@/lib/streams/streamState'

const BACKOFF_DELAYS = [500, 1000, 2000, 4000, 10000]

export function ReconnectBanner() {
  const connectionState = useConsoleStore((s) => s.connectionState)
  const reconnectAttempt = useConsoleStore((s) => s.reconnectAttempt)

  // Only show during reconnection phases
  if (connectionState !== 'RECONNECTING' && connectionState !== 'RESUMING' && connectionState !== 'FAILED') {
    return null
  }

  if (connectionState === 'FAILED') {
    return (
      <div style={{ ...styles.banner, backgroundColor: 'rgba(239, 68, 68, 0.12)', borderColor: '#ef4444' }} role="alert">
        <div style={styles.content}>
          <span style={{ ...styles.text, color: '#f87171' }}>
            Connection failed after {reconnectAttempt} attempts. Please refresh the page.
          </span>
        </div>
      </div>
    )
  }

  const nextDelay = BACKOFF_DELAYS[
    Math.min(reconnectAttempt - 1, BACKOFF_DELAYS.length - 1)
  ]
  const nextDelayStr =
    nextDelay < 1000
      ? `${nextDelay}ms`
      : `${(nextDelay / 1000).toFixed(1)}s`

  return (
    <div style={styles.banner} role="status" aria-live="polite">
      <div style={styles.content}>
        <div style={styles.spinner} aria-hidden="true" />
        <span style={styles.text}>
          {connectionState === 'RESUMING'
            ? 'Reconnected — syncing state...'
            : `Reconnecting... (attempt ${reconnectAttempt}, next in ~${nextDelayStr})`}
        </span>
      </div>
    </div>
  )
}

// ─── Styles ─────────────────────────────────────────────────────────────────

const styles: Record<string, React.CSSProperties> = {
  banner: {
    position: 'sticky',
    top: 0,
    left: 0,
    right: 0,
    zIndex: 100,
    backgroundColor: 'rgba(251, 191, 36, 0.1)',
    borderBottom: '1px solid rgba(251, 191, 36, 0.3)',
    padding: '8px 16px',
    fontFamily: "'Inter', 'system-ui', sans-serif",
    fontSize: '13px',
  },
  content: {
    display: 'flex',
    alignItems: 'center',
    gap: '10px',
    maxWidth: '1200px',
    margin: '0 auto',
  },
  spinner: {
    width: '14px',
    height: '14px',
    borderRadius: '50%',
    border: '2px solid rgba(251, 191, 36, 0.4)',
    borderTopColor: '#fbbf24',
    animation: 'spin 0.8s linear infinite',
    flexShrink: 0,
  },
  text: {
    color: '#fbbf24',
    fontWeight: 500,
  },
}