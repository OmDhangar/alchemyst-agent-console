/**
 * ConsoleShell.tsx — Three-panel layout shell
 *
 * Assembles the Chat, Timeline, and Context panels into a responsive layout.
 *
 * LAYOUT
 * ======
 *   ┌──────────────────────────┬─────────────┬────────────────────┐
 *   │                          │             │                    │
 *   │      Chat Panel          │  Timeline   │   Context Panel    │
 *   │      (flex: 1)           │  (300px)    │   (340px)          │
 *   │                          │             │                    │
 *   └──────────────────────────┴─────────────┴────────────────────┘
 *   [📋 Timeline ✓] [🗂️ Context ✓]            (toggle buttons)
 *
 * Both Timeline and Context panels can be collapsed. When collapsed,
 * the Chat panel expands to fill the available space.
 *
 * BIDIRECTIONAL LINKING
 * =====================
 * When the user clicks a tool call card in the chat:
 *   1. ChatPanel fires onToolCallClick(callId)
 *   2. ConsoleShell sets highlightedCallId state
 *   3. TimelinePanel highlights the matching row
 *   4. We also querySelector for the timeline row and scrollIntoView
 *
 * When the user clicks a timeline row:
 *   1. TimelinePanel fires onRowClick(callId)
 *   2. The timeline's onClick querySelector finds the chat card and scrolls to it
 */

'use client'

import { useState } from 'react'
import { ChatPanel } from './ChatPanel/ChatPanel'
import { TimelinePanel } from './TimelinePanel/TimelinePanel'
import { ContextPanel } from './ContextPanel/ContextPanel'
import { ReconnectBanner } from './ui/ReconnectBanner'

export function ConsoleShell() {
  const [showTimeline, setShowTimeline] = useState(true)
  const [showContext, setShowContext] = useState(true)
  const [highlightedCallId, setHighlightedCallId] = useState<string | null>(null)

  const handleToolCallClick = (callId: string) => {
    setHighlightedCallId(callId)
    if (!showTimeline) setShowTimeline(true)

    // Scroll the timeline to the matching row
    setTimeout(() => {
      const row = document.querySelector(`[data-event-id="${callId}"]`)
      row?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    }, 50)
  }

  return (
    <div style={styles.root}>
      {/* Reconnection banner — non-blocking, sticks to top */}
      <ReconnectBanner />

      {/* Main 3-panel layout */}
      <div style={styles.layout}>
        {/* Chat panel — takes remaining space */}
        <div
          style={{
            ...styles.chatPanel,
            flex: showTimeline || showContext ? '1 1 auto' : '1',
            minWidth: 0,
          }}
        >
          <ChatPanel onToolCallClick={handleToolCallClick} />
        </div>

        {/* Timeline panel */}
        {showTimeline && (
          <div style={styles.timelinePanel}>
            <TimelinePanel
              highlightedCallId={highlightedCallId}
              onRowClick={(callId) => setHighlightedCallId(callId)}
            />
          </div>
        )}

        {/* Context panel */}
        {showContext && (
          <div style={styles.contextPanel}>
            <ContextPanel />
          </div>
        )}
      </div>

      {/* Bottom toolbar — toggle panels */}
      <div style={styles.toolbar}>
        <button
          onClick={() => setShowTimeline(!showTimeline)}
          style={{
            ...styles.toolbarBtn,
            backgroundColor: showTimeline ? 'rgba(99, 102, 241, 0.15)' : 'transparent',
            color: showTimeline ? '#818cf8' : '#64748b',
            borderColor: showTimeline ? 'rgba(99, 102, 241, 0.3)' : '#334155',
          }}
          title="Toggle trace timeline"
          id="toggle-timeline"
        >
          📋 Timeline {showTimeline ? '✓' : ''}
        </button>
        <button
          onClick={() => setShowContext(!showContext)}
          style={{
            ...styles.toolbarBtn,
            backgroundColor: showContext ? 'rgba(99, 102, 241, 0.15)' : 'transparent',
            color: showContext ? '#818cf8' : '#64748b',
            borderColor: showContext ? 'rgba(99, 102, 241, 0.3)' : '#334155',
          }}
          title="Toggle context inspector"
          id="toggle-context"
        >
          🗂️ Context {showContext ? '✓' : ''}
        </button>
        <span style={styles.toolbarHint}>
          Click a tool call card ↔ timeline entry for cross-reference
        </span>
      </div>
    </div>
  )
}

// ─── Styles ─────────────────────────────────────────────────────────────────

const styles: Record<string, React.CSSProperties> = {
  root: {
    display: 'flex',
    flexDirection: 'column',
    height: '100vh',
    width: '100vw',
    overflow: 'hidden',
    fontFamily: "'Inter', 'system-ui', sans-serif",
    backgroundColor: '#0f172a',
  },
  layout: {
    display: 'flex',
    flex: 1,
    overflow: 'hidden',
    minHeight: 0,
  },
  chatPanel: {
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
    minWidth: '300px',
  },
  timelinePanel: {
    width: '300px',
    flexShrink: 0,
    borderLeft: '1px solid #1e293b',
    overflow: 'hidden',
    display: 'flex',
    flexDirection: 'column',
  },
  contextPanel: {
    width: '340px',
    flexShrink: 0,
    borderLeft: '1px solid #1e293b',
    overflow: 'hidden',
    display: 'flex',
    flexDirection: 'column',
  },
  toolbar: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    padding: '8px 16px',
    borderTop: '1px solid #1e293b',
    backgroundColor: '#0f172a',
    flexShrink: 0,
  },
  toolbarBtn: {
    padding: '6px 14px',
    border: '1px solid #334155',
    borderRadius: '8px',
    fontSize: '12px',
    cursor: 'pointer',
    fontFamily: "'Inter', 'system-ui', sans-serif",
    fontWeight: 500,
    transition: 'all 0.2s',
    background: 'transparent',
  },
  toolbarHint: {
    marginLeft: 'auto',
    fontSize: '11px',
    color: '#475569',
    fontStyle: 'italic',
  },
}