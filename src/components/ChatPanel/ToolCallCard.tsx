/**
 * ToolCallCard.tsx — Displays a single tool call with args and result
 *
 * STATES
 * ======
 * pending:     Tool is running — shows a spinner, result is null
 * resolved:    Tool finished — shows the result, no spinner
 * waiting:     During reconnection — card stays visible, shows "waiting..."
 *
 * LAYOUT SHIFT PREVENTION
 * =======================
 * The card has a min-height (80px) so it reserves vertical space in the DOM
 * before the result loads. This prevents the text below from jumping when
 * the result arrives and the card grows taller.
 *
 * BIDIRECTIONAL LINKING
 * =====================
 * Each card has a data-call-id attribute. When the user clicks the card,
 * we tell the parent (via onClick), which scrolls the timeline to the
 * matching TOOL_CALL entry. The timeline can also find this card by
 * call_id and scroll the chat to it.
 *
 * IMMUTABILITY
 * =============
 * The card is NEVER unmounted between pending and resolved states.
 * React updates the content in place — no animation flash, no re-mount.
 * This is important for the "seamless" feeling the assignment requires.
 */

'use client'

import type { ToolCallEntry } from '@/lib/streams/types'

type Props = {
  toolCall: ToolCallEntry
  isReconnecting?: boolean
  onClick?: () => void
  callId: string
}

export function ToolCallCard({ toolCall, isReconnecting, onClick, callId }: Props) {
  const hasResult = toolCall.result !== null

  return (
    <div
      data-call-id={callId}
      style={styles.card}
      onClick={onClick}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => e.key === 'Enter' && onClick?.()}
      aria-label={`Tool call: ${toolCall.tool_name}`}
    >
      {/* Header: tool name + status badge */}
      <div style={styles.header}>
        <span style={styles.toolName}>{toolCall.tool_name}</span>
        <span style={hasResult ? styles.badgeResolved : styles.badgePending}>
          {isReconnecting
            ? '⏳ waiting...'
            : hasResult
              ? '✓ done'
              : '⟳ running'}
        </span>
      </div>

      {/* Arguments */}
      <div style={styles.section}>
        <div style={styles.sectionLabel}>Arguments</div>
        <pre style={styles.codeBlock}>
          {formatJson(toolCall.args)}
        </pre>
      </div>

      {/* Result — only shown when available */}
      {hasResult && (
        <div style={styles.section}>
          <div style={styles.sectionLabel}>Result</div>
          <pre style={styles.codeBlock}>
            {formatJson(toolCall.result as Record<string, unknown>)}
          </pre>
        </div>
      )}
    </div>
  )
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

// ─── Styles ─────────────────────────────────────────────────────────────────

const styles: Record<string, React.CSSProperties> = {
  card: {
    backgroundColor: '#1e293b',
    border: '1px solid #334155',
    borderLeft: '3px solid #818cf8',
    borderRadius: '8px',
    padding: '12px 14px',
    marginTop: '10px',
    marginBottom: '6px',
    fontFamily: "'Inter', 'system-ui', sans-serif",
    fontSize: '13px',
    cursor: 'pointer',
    transition: 'border-color 0.2s, background-color 0.2s',
    minWidth: '240px',
    maxWidth: '500px',
    minHeight: '80px',   // Prevents layout shift — reserves space before result loads
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: '8px',
  },
  toolName: {
    fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
    fontWeight: 600,
    color: '#a5b4fc',
    fontSize: '13px',
  },
  badgePending: {
    fontSize: '11px',
    color: '#94a3b8',
    backgroundColor: '#1e293b',
    border: '1px solid #334155',
    padding: '2px 8px',
    borderRadius: '12px',
  },
  badgeResolved: {
    fontSize: '11px',
    color: '#4ade80',
    backgroundColor: 'rgba(74, 222, 128, 0.1)',
    border: '1px solid rgba(74, 222, 128, 0.2)',
    padding: '2px 8px',
    borderRadius: '12px',
  },
  section: {
    marginTop: '8px',
  },
  sectionLabel: {
    fontSize: '10px',
    fontWeight: 600,
    color: '#64748b',
    textTransform: 'uppercase',
    letterSpacing: '0.08em',
    marginBottom: '4px',
  },
  codeBlock: {
    margin: 0,
    padding: '8px 10px',
    backgroundColor: '#0f172a',
    border: '1px solid #1e293b',
    borderRadius: '6px',
    fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
    fontSize: '12px',
    color: '#e2e8f0',
    overflow: 'auto',
    maxHeight: '120px',
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-all',
  },
}