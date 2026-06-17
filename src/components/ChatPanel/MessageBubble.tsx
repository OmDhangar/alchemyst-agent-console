/**
 * MessageBubble.tsx — Renders a single chat message (user or agent)
 *
 * This component handles two very different cases:
 *
 * USER MESSAGES
 * ==============
 * Simple: right-aligned indigo bubble with the user's text. Static, never changes.
 *
 * AGENT MESSAGES
 * ==============
 * Complex. An agent message is a live, streaming entity:
 *   - Text arrives token by token (30+ times per second)
 *   - Tool calls can interrupt the stream mid-sentence
 *   - Tool results appear later, and streaming resumes
 *   - Multiple tool calls can stack sequentially
 *
 * LAYOUT SHIFT PREVENTION
 * =======================
 * The hardest part of this component. When a tool call card appears mid-stream:
 *
 *   [some streaming text here...]
 *   [TOOL CALL CARD APPEARS HERE]    ← this pushes everything down
 *   [more text continues after...]
 *
 * If we're not careful, the entire chat scrolls/jumps when the card appears.
 * We prevent this with:
 *
 *   1. Tool call cards are siblings, not children, of the text span.
 *      The text doesn't reflow when the card appears — it just sits below.
 *
 *   2. Each card has a min-height so the browser reserves space for it
 *      even while loading (before the result arrives).
 *
 *   3. We use a flexbox column layout for the agent content, with gap: 0.
 *      Items stack vertically without layout recalculation.
 *
 * AUTO-SCROLL
 * ===========
 * We auto-scroll to the bottom when new content arrives, but ONLY if the
 * user is already near the bottom (within 100px). If they've scrolled up
 * to read earlier content, we don't pull them back down.
 */

'use client'

import { useRef, useEffect } from 'react'
import { ToolCallCard } from './ToolCallCard'
import type { Message } from '@/lib/streams/streamState'

type Props = {
  message: Message
  isReconnecting?: boolean
  onToolCallClick?: (callId: string) => void
}

export function MessageBubble({ message, isReconnecting, onToolCallClick }: Props) {
  const endRef = useRef<HTMLDivElement>(null)

  // Auto-scroll to bottom when content changes (but only if user is near bottom)
  useEffect(() => {
    if (!endRef.current) return
    const parent = endRef.current.closest('#chat-messages')
    if (!parent) return

    const distanceFromBottom = parent.scrollHeight - parent.scrollTop - parent.clientHeight
    if (distanceFromBottom < 100) {
      endRef.current.scrollIntoView({ behavior: 'smooth', block: 'end' })
    }
  }, [message.content, message.toolCalls])

  // ── User message ──────────────────────────────────────────────────────
  if (message.role === 'user') {
    return (
      <div style={styles.userRow}>
        <div style={styles.userBubble}>
          <p style={styles.userText}>{message.content}</p>
        </div>
      </div>
    )
  }

  // ── Agent message ─────────────────────────────────────────────────────
  return (
    <div style={styles.agentRow}>
      <div style={styles.agentBubble}>
        {/* Agent avatar */}
        <div style={styles.avatar}>A</div>

        {/* Content column: text + tool cards stack vertically */}
        <div style={styles.agentContent}>
          {/* Streaming text */}
          <span
            key={message.streamId ?? 'no-stream'}
            style={styles.agentText}
          >
            {message.content}
            {/* Blinking cursor while streaming */}
            {message.status === 'streaming' && (
              <span style={styles.cursor} aria-hidden="true">▍</span>
            )}
          </span>

          {/* Tool call cards — rendered as siblings BELOW the text.
              Each card is a self-contained unit. Multiple cards stack. */}
          {message.toolCalls.map((tc) => (
            <ToolCallCard
              key={tc.call_id}
              callId={tc.call_id}
              toolCall={tc}
              isReconnecting={isReconnecting && tc.result === null}
              onClick={() => onToolCallClick?.(tc.call_id)}
            />
          ))}
        </div>

        <div ref={endRef} />
      </div>
    </div>
  )
}

// ─── Styles ─────────────────────────────────────────────────────────────────

const styles: Record<string, React.CSSProperties> = {
  userRow: {
    display: 'flex',
    justifyContent: 'flex-end',
    padding: '4px 20px',
  },
  userBubble: {
    backgroundColor: '#4f46e5',
    color: '#fff',
    borderRadius: '18px 18px 4px 18px',
    padding: '10px 16px',
    maxWidth: '70%',
    fontFamily: "'Inter', 'system-ui', sans-serif",
    fontSize: '14px',
    lineHeight: 1.5,
  },
  userText: {
    margin: 0,
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
  },
  agentRow: {
    display: 'flex',
    justifyContent: 'flex-start',
    padding: '4px 20px',
  },
  agentBubble: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: '12px',
    maxWidth: '85%',
    fontFamily: "'Inter', 'system-ui', sans-serif",
    fontSize: '14px',
    lineHeight: 1.65,
  },
  avatar: {
    width: '30px',
    height: '30px',
    borderRadius: '50%',
    backgroundColor: '#6366f1',
    color: '#fff',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontWeight: 700,
    fontSize: '13px',
    flexShrink: 0,
    marginTop: '2px',
  },
  agentContent: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0',
    // min-height prevents layout shift when tool cards appear
    minHeight: '20px',
  },
  agentText: {
    color: '#e2e8f0',
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
  },
  cursor: {
    display: 'inline-block',
    color: '#818cf8',
    marginLeft: '1px',
    animation: 'blink 0.8s step-end infinite',
  },
}