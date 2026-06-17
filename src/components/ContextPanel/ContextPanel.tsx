/**
 * ContextPanel.tsx — Context Inspector with diff display and history scrubber
 *
 * Shows the agent's current working context as a readable, collapsible JSON tree.
 * When a new CONTEXT_SNAPSHOT arrives for the same context_id, computes and
 * highlights the diff: what keys were added, removed, or changed.
 *
 * HISTORY SCRUBBER
 * ================
 * Users can step backward and forward through all snapshots for a given
 * context_id using prev/next buttons. Each step shows:
 *   - The snapshot data at that position
 *   - The diff from the PREVIOUS snapshot
 *
 * BUG FIX: The previous version always showed the latest snapshot regardless
 * of scrubber position. Now scrubberPos correctly indexes into the array,
 * and the diff is computed between snapshots[pos] and snapshots[pos - 1].
 *
 * PERFORMANCE ON 500KB+ PAYLOADS
 * ==============================
 * For large context objects (chaos mode), we use lazy expansion:
 *   - Only the first 2 levels are expanded by default
 *   - Users click to expand deeper nodes they care about
 *   - This keeps the DOM node count manageable without virtual scrolling
 *
 * The diff computation (via fast-json-patch) is O(n) and runs in <50ms
 * for 500KB payloads on modern hardware. The bottleneck is rendering, not diffing.
 */

'use client'

import { useState, useMemo, useCallback } from 'react'
import { useConsoleStore, useContextSnapshots } from '@/lib/streams/streamState'
import { computeContextDiff } from '@/lib/utils/jsonDiff'
import type { ContextDiff } from '@/lib/streams/types'

export function ContextPanel() {
  const currentContextId = useConsoleStore((s) => s.currentContextId)
  const setCurrentContext = useConsoleStore((s) => s.setCurrentContext)
  const allSnapshots = useConsoleStore((s) => s.snapshots)
  const contextIds = Object.keys(allSnapshots)

  // Scrubber position — which snapshot are we viewing?
  const scrubberPos = useConsoleStore((s) =>
    currentContextId ? (s.scrubberPosition[currentContextId] ?? 0) : 0,
  )
  const setScrubberPos = useConsoleStore((s) => s.setScrubberPosition)

  const snapshots = useContextSnapshots(currentContextId)

  // BUG FIX: Use scrubberPos to index into snapshots, not always the latest.
  // This is what makes the scrubber actually work — clicking prev/next
  // changes which snapshot you're viewing.
  const currentSnapshot = snapshots[scrubberPos] ?? null
  const prevSnapshot = scrubberPos > 0 ? snapshots[scrubberPos - 1] : null

  // Compute diff between current and previous snapshot at scrubber position
  const diff = useMemo(() => {
    if (!currentSnapshot || !prevSnapshot) return null
    return computeContextDiff(prevSnapshot.data, currentSnapshot.data)
  }, [currentSnapshot, prevSnapshot])

  const handlePrev = useCallback(() => {
    if (!currentContextId || scrubberPos <= 0) return
    setScrubberPos(currentContextId, scrubberPos - 1)
  }, [currentContextId, scrubberPos, setScrubberPos])

  const handleNext = useCallback(() => {
    if (!currentContextId || scrubberPos >= snapshots.length - 1) return
    setScrubberPos(currentContextId, scrubberPos + 1)
  }, [currentContextId, scrubberPos, snapshots.length, setScrubberPos])

  return (
    <div style={styles.container}>
      {/* Header */}
      <div style={styles.header}>
        <span style={styles.title}>Context Inspector</span>
        {currentSnapshot && (
          <span style={styles.seqLabel}>seq #{currentSnapshot.seq}</span>
        )}
      </div>

      {/* Context ID selector (when multiple contexts exist) */}
      {contextIds.length > 0 && (
        <div style={styles.selectorRow}>
          <label style={styles.label}>Context:</label>
          <select
            value={currentContextId ?? ''}
            onChange={(e) => setCurrentContext(e.target.value || null)}
            style={styles.select}
            id="context-selector"
          >
            {contextIds.map((id) => (
              <option key={id} value={id}>
                {id} ({allSnapshots[id]?.length ?? 0} snapshots)
              </option>
            ))}
          </select>
        </div>
      )}

      {/* History scrubber */}
      {snapshots.length > 0 && (
        <div style={styles.scrubberRow}>
          <button
            onClick={handlePrev}
            disabled={scrubberPos <= 0}
            style={{
              ...styles.navBtn,
              opacity: scrubberPos <= 0 ? 0.4 : 1,
            }}
            id="scrubber-prev"
          >
            ‹ Prev
          </button>
          <span style={styles.scrubberLabel}>
            Snapshot {scrubberPos + 1} / {snapshots.length}
          </span>
          <button
            onClick={handleNext}
            disabled={scrubberPos >= snapshots.length - 1}
            style={{
              ...styles.navBtn,
              opacity: scrubberPos >= snapshots.length - 1 ? 0.4 : 1,
            }}
            id="scrubber-next"
          >
            Next ›
          </button>
        </div>
      )}

      {/* Diff summary bar */}
      {diff && (
        <div style={styles.diffSummary}>
          {diff.added.length > 0 && (
            <span style={styles.diffAdded}>+{diff.added.length} added</span>
          )}
          {diff.removed.length > 0 && (
            <span style={styles.diffRemoved}>-{diff.removed.length} removed</span>
          )}
          {diff.changed.length > 0 && (
            <span style={styles.diffChanged}>~{diff.changed.length} changed</span>
          )}
        </div>
      )}

      {/* JSON Tree view */}
      <div style={styles.treeContainer}>
        {!currentSnapshot && (
          <div style={styles.empty}>
            <div style={{ fontSize: '36px', marginBottom: '12px' }}>📋</div>
            <p style={{ color: '#94a3b8', margin: '0 0 8px 0' }}>No context snapshots yet</p>
            <p style={styles.emptyHint}>
              Send &ldquo;report&rdquo;, &ldquo;analyze&rdquo;, or &ldquo;schema&rdquo;
              to trigger a context snapshot.
            </p>
          </div>
        )}

        {currentSnapshot && (
          <JsonTree
            data={currentSnapshot.data}
            diff={diff}
            depth={0}
          />
        )}
      </div>
    </div>
  )
}

// ─── JSON Tree Node ─────────────────────────────────────────────────────────

type JsonTreeProps = {
  data: unknown
  diff: ContextDiff | null
  path?: string
  depth: number
}

function JsonTree({ data, diff, path = '', depth }: JsonTreeProps) {
  // Auto-expand first 2 levels so the user sees something useful immediately.
  // Deeper levels are collapsed by default (lazy expansion for 500KB+ payloads).
  const [expanded, setExpanded] = useState(depth < 2)

  // Determine if this path has a diff annotation
  const isAdded = diff?.added.some((p) => p === path) ?? false
  const isRemoved = diff?.removed.some((p) => p === path) ?? false
  const changedEntry = diff?.changed.find((c) => c.path === path)

  // Primitives
  if (data === null || data === undefined) {
    return <span style={jsonStyles.null}>{String(data)}</span>
  }
  if (typeof data === 'boolean') {
    return <span style={jsonStyles.boolean}>{String(data)}</span>
  }
  if (typeof data === 'number') {
    return <span style={jsonStyles.number}>{data}</span>
  }
  if (typeof data === 'string') {
    return <span style={jsonStyles.string}>&quot;{data}&quot;</span>
  }

  // Arrays and Objects
  const isArray = Array.isArray(data)
  const entries = Object.entries(data as Record<string, unknown>)
  const bracket = isArray ? ['[', ']'] : ['{', '}']

  return (
    <div style={{ marginLeft: depth > 0 ? 14 : 0 }}>
      <span
        style={{
          ...jsonStyles.bracket,
          ...(isAdded ? jsonStyles.diffAdded : {}),
          ...(isRemoved ? jsonStyles.diffRemoved : {}),
          ...(changedEntry ? jsonStyles.diffChanged : {}),
        }}
        onClick={() => setExpanded(!expanded)}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => e.key === 'Enter' && setExpanded(!expanded)}
      >
        {expanded ? '▼' : '▶'} {bracket[0]}
        {!expanded && ` ${entries.length} ${isArray ? 'items' : 'keys'} `}
        {!expanded && bracket[1]}
      </span>

      {expanded && (
        <>
          {entries.map(([key, value]) => {
            const childPath = `${path}/${key}`
            const childAdded = diff?.added.some((p) => p === childPath) ?? false
            const childRemoved = diff?.removed.some((p) => p === childPath) ?? false
            const childChanged = diff?.changed.find((c) => c.path === childPath)

            return (
              <div
                key={key}
                style={{
                  paddingLeft: '4px',
                  ...(childAdded ? { backgroundColor: 'rgba(74, 222, 128, 0.08)' } : {}),
                  ...(childRemoved ? { backgroundColor: 'rgba(248, 113, 113, 0.08)' } : {}),
                  ...(childChanged ? { backgroundColor: 'rgba(251, 191, 36, 0.08)' } : {}),
                }}
              >
                <span style={jsonStyles.key}>
                  {isArray ? `[${key}]` : key}
                </span>
                <span style={{ color: '#475569' }}>: </span>
                {typeof value === 'object' && value !== null ? (
                  <JsonTree
                    data={value}
                    diff={diff}
                    path={childPath}
                    depth={depth + 1}
                  />
                ) : (
                  <JsonTree
                    data={value}
                    diff={diff}
                    path={childPath}
                    depth={depth + 1}
                  />
                )}
                {childChanged && (
                  <span style={jsonStyles.changeIndicator}>
                    {' '}← was {JSON.stringify(childChanged.oldValue)}
                  </span>
                )}
              </div>
            )
          })}
          <div style={{ marginLeft: depth > 0 ? 0 : 0 }}>
            <span style={jsonStyles.bracket}>{bracket[1]}</span>
          </div>
        </>
      )}
    </div>
  )
}

// ─── Styles ─────────────────────────────────────────────────────────────────

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: 'flex',
    flexDirection: 'column',
    height: '100%',
    backgroundColor: '#0f172a',
    fontFamily: "'Inter', 'system-ui', sans-serif",
    fontSize: '13px',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '14px 16px',
    borderBottom: '1px solid #1e293b',
    flexShrink: 0,
  },
  title: {
    fontWeight: 600,
    fontSize: '14px',
    color: '#f1f5f9',
  },
  seqLabel: {
    fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
    fontSize: '11px',
    color: '#64748b',
  },
  selectorRow: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    padding: '8px 12px',
    borderBottom: '1px solid #1e293b',
    flexShrink: 0,
  },
  label: {
    fontSize: '12px',
    color: '#64748b',
    flexShrink: 0,
  },
  select: {
    flex: 1,
    padding: '5px 8px',
    border: '1px solid #334155',
    borderRadius: '6px',
    fontSize: '12px',
    fontFamily: "'Inter', 'system-ui', sans-serif",
    backgroundColor: '#1e293b',
    color: '#e2e8f0',
  },
  scrubberRow: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '8px 12px',
    borderBottom: '1px solid #1e293b',
    flexShrink: 0,
  },
  scrubberLabel: {
    fontSize: '12px',
    color: '#94a3b8',
  },
  navBtn: {
    padding: '4px 12px',
    backgroundColor: '#1e293b',
    border: '1px solid #334155',
    borderRadius: '6px',
    fontSize: '12px',
    cursor: 'pointer',
    fontFamily: "'Inter', 'system-ui', sans-serif",
    color: '#e2e8f0',
    transition: 'all 0.15s',
  },
  diffSummary: {
    display: 'flex',
    gap: '12px',
    padding: '6px 12px',
    borderBottom: '1px solid #1e293b',
    flexShrink: 0,
  },
  diffAdded: {
    fontSize: '11px',
    color: '#4ade80',
    fontWeight: 600,
  },
  diffRemoved: {
    fontSize: '11px',
    color: '#f87171',
    fontWeight: 600,
  },
  diffChanged: {
    fontSize: '11px',
    color: '#fbbf24',
    fontWeight: 600,
  },
  treeContainer: {
    flex: 1,
    overflowY: 'auto',
    padding: '12px',
  },
  empty: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    height: '100%',
    textAlign: 'center',
  },
  emptyHint: {
    fontSize: '12px',
    color: '#475569',
    maxWidth: '240px',
    margin: 0,
  },
}

const jsonStyles: Record<string, React.CSSProperties> = {
  string: { color: '#4ade80' },
  number: { color: '#fb923c' },
  boolean: { color: '#c084fc' },
  null: { color: '#64748b', fontStyle: 'italic' },
  key: {
    color: '#60a5fa',
    fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
    fontSize: '12px',
  },
  bracket: {
    cursor: 'pointer',
    color: '#64748b',
    userSelect: 'none',
    fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
    fontSize: '12px',
  },
  diffAdded: {
    backgroundColor: 'rgba(74, 222, 128, 0.15)',
    color: '#4ade80',
    padding: '0 3px',
    borderRadius: '2px',
  },
  diffRemoved: {
    backgroundColor: 'rgba(248, 113, 113, 0.15)',
    color: '#f87171',
    padding: '0 3px',
    borderRadius: '2px',
    textDecoration: 'line-through',
  },
  diffChanged: {
    backgroundColor: 'rgba(251, 191, 36, 0.15)',
    color: '#fbbf24',
    padding: '0 3px',
    borderRadius: '2px',
  },
  changeIndicator: {
    fontSize: '10px',
    color: '#fbbf24',
    fontStyle: 'italic',
  },
}