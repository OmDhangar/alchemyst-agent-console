/**
 * TimelinePanel.tsx — Real-time agent trace timeline
 *
 * Shows every protocol event in a scrollable, auto-updating timeline.
 * The user can see exactly what the agent is doing at a granular level:
 * token batches, tool calls, context snapshots, heartbeats, errors.
 *
 * PERFORMANCE: VIRTUALIZED LIST
 * ==============================
 * During active token streaming, we get 30+ events per second.
 * Rendering all of them as DOM nodes would tank the browser.
 *
 * Solution: @tanstack/react-virtual (formerly react-virtual).
 * It only renders rows visible in the viewport (~20-30 DOM nodes),
 * regardless of how many events are in the list. With 1000+ events,
 * performance stays smooth.
 *
 * TOKEN BATCHING
 * ===============
 * Individual TOKEN events are batched by the store — every 200ms,
 * accumulated tokens are flushed into a single "Streamed N tokens (duration)"
 * entry. Without this, a 10-second response would create 150+ timeline rows.
 *
 * BIDIRECTIONAL LINKING
 * =====================
 * - Click a timeline row → scrolls to the corresponding element in chat
 * - Click a tool card in chat → scrolls timeline to the TOOL_CALL entry
 *
 * This is done via data attributes:
 *   - Timeline rows: data-event-id="${linkId}"
 *   - Tool cards: data-call-id="${callId}"
 *   - Click handlers use querySelector to find and scrollIntoView
 */

'use client'

import { useRef, useEffect, useMemo, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { useConsoleStore } from '@/lib/streams/streamState'
import type { TimelineEvent, TimelineEventType } from '@/lib/streams/types'

// ─── Visual Config ───────────────────────────────────────────────────────────

const EVENT_TYPE_CONFIG: Record<TimelineEventType, { color: string; label: string }> = {
  TOKEN_BATCH:      { color: '#94a3b8', label: 'TOKEN' },
  TOOL_CALL:        { color: '#818cf8', label: 'TOOL' },
  TOOL_RESULT:      { color: '#4ade80', label: 'RESULT' },
  CONTEXT_SNAPSHOT:  { color: '#22d3ee', label: 'CTX' },
  PING:             { color: '#fbbf24', label: 'PING' },
  PONG:             { color: '#fbbf24', label: 'PONG' },
  STREAM_END:       { color: '#94a3b8', label: 'END' },
  ERROR:            { color: '#f87171', label: 'ERR' },
  RECONNECT:        { color: '#fb923c', label: 'RECONN' },
  RESUME:           { color: '#34d399', label: 'RESUME' },
}

type Props = {
  highlightedCallId: string | null
  onRowClick?: (callId: string) => void
}

export function TimelinePanel({ highlightedCallId, onRowClick }: Props) {
  const events = useConsoleStore((s) => s.events)
  const parentRef = useRef<HTMLDivElement>(null)
  const [filter, setFilter] = useState<TimelineEventType | 'ALL'>('ALL')
  const [search, setSearch] = useState('')

  // Filter events
  const filteredEvents = useMemo(() => {
    return events.filter((e) => {
      if (filter !== 'ALL' && e.type !== filter) return false
      if (search && !e.summary.toLowerCase().includes(search.toLowerCase())) return false
      return true
    })
  }, [events, filter, search])

  // Virtualized list — only renders visible rows
  const virtualizer = useVirtualizer({
    count: filteredEvents.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 44,
    overscan: 5,
  })

  // Auto-scroll to bottom when new events arrive
  const isScrolledUp = useRef(false)
  useEffect(() => {
    if (!isScrolledUp.current && filteredEvents.length > 0) {
      virtualizer.scrollToIndex(filteredEvents.length - 1, { align: 'end' })
    }
  }, [filteredEvents.length, virtualizer])

  const handleScroll = () => {
    if (!parentRef.current) return
    const el = parentRef.current
    isScrolledUp.current = el.scrollHeight - el.scrollTop - el.clientHeight > 100
  }

  return (
    <div style={styles.container}>
      {/* Header */}
      <div style={styles.header}>
        <span style={styles.title}>Trace Timeline</span>
        <span style={styles.count}>{events.length} events</span>
      </div>

      {/* Filter bar */}
      <div style={styles.filterBar}>
        <select
          value={filter}
          onChange={(e) => setFilter(e.target.value as TimelineEventType | 'ALL')}
          style={styles.select}
          aria-label="Filter by event type"
          id="timeline-filter"
        >
          <option value="ALL">All events</option>
          <option value="TOKEN_BATCH">Tokens</option>
          <option value="TOOL_CALL">Tool calls</option>
          <option value="TOOL_RESULT">Tool results</option>
          <option value="CONTEXT_SNAPSHOT">Context</option>
          <option value="PING">Heartbeats</option>
          <option value="ERROR">Errors</option>
          <option value="RESUME">Resume</option>
        </select>
        <input
          type="text"
          placeholder="Search..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={styles.searchInput}
          aria-label="Search events"
          id="timeline-search"
        />
      </div>

      {/* Virtualized event list */}
      <div ref={parentRef} style={styles.list} onScroll={handleScroll}>
        <div
          style={{
            height: `${virtualizer.getTotalSize()}px`,
            width: '100%',
            position: 'relative',
          }}
        >
          {virtualizer.getVirtualItems().map((vRow) => {
            const event = filteredEvents[vRow.index]
            const config = EVENT_TYPE_CONFIG[event.type]
            const isHighlighted = event.linkId !== null && event.linkId === highlightedCallId

            return (
              <div
                key={`${event.seq}-${vRow.index}`}
                data-event-id={event.linkId}
                data-seq={event.seq}
                style={{
                  ...styles.row,
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  width: '100%',
                  height: `${vRow.size}px`,
                  transform: `translateY(${vRow.start}px)`,
                  backgroundColor: isHighlighted ? 'rgba(99, 102, 241, 0.15)' : 'transparent',
                  borderLeft: isHighlighted ? '3px solid #6366f1' : '3px solid transparent',
                }}
                onClick={() => {
                  if (event.linkId) {
                    // Click tool timeline entry → scroll to card in chat
                    const card = document.querySelector(`[data-call-id="${event.linkId}"]`)
                    card?.scrollIntoView({ behavior: 'smooth', block: 'center' })
                    onRowClick?.(event.linkId)
                  }
                }}
              >
                {/* Seq number */}
                <span style={styles.seq}>#{event.seq}</span>

                {/* Event type badge */}
                <span
                  style={{
                    ...styles.badge,
                    backgroundColor: config.color + '18',
                    color: config.color,
                    borderColor: config.color + '30',
                  }}
                >
                  {config.label}
                </span>

                {/* Summary */}
                <span style={styles.summary}>{event.summary}</span>
              </div>
            )
          })}
        </div>
      </div>
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
  count: {
    fontSize: '12px',
    color: '#64748b',
  },
  filterBar: {
    display: 'flex',
    gap: '6px',
    padding: '8px 12px',
    borderBottom: '1px solid #1e293b',
    flexShrink: 0,
  },
  select: {
    padding: '5px 8px',
    border: '1px solid #334155',
    borderRadius: '6px',
    fontSize: '11px',
    fontFamily: "'Inter', 'system-ui', sans-serif",
    backgroundColor: '#1e293b',
    color: '#e2e8f0',
    cursor: 'pointer',
  },
  searchInput: {
    flex: 1,
    padding: '5px 8px',
    border: '1px solid #334155',
    borderRadius: '6px',
    fontSize: '11px',
    fontFamily: "'Inter', 'system-ui', sans-serif",
    backgroundColor: '#1e293b',
    color: '#e2e8f0',
    outline: 'none',
  },
  list: {
    flex: 1,
    overflowY: 'auto',
  },
  row: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    padding: '0 12px',
    borderBottom: '1px solid #1e293b08',
    cursor: 'default',
    transition: 'background-color 0.15s',
    boxSizing: 'border-box',
  },
  seq: {
    fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
    fontSize: '10px',
    color: '#475569',
    minWidth: '36px',
    textAlign: 'right',
    flexShrink: 0,
  },
  badge: {
    fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
    fontSize: '9px',
    fontWeight: 600,
    padding: '2px 6px',
    borderRadius: '4px',
    flexShrink: 0,
    letterSpacing: '0.04em',
    border: '1px solid',
  },
  summary: {
    flex: 1,
    color: '#cbd5e1',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontSize: '12px',
  },
}