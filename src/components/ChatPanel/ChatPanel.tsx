/**
 * ChatPanel.tsx — The main chat interface
 *
 * This is where the user types messages and sees the agent's streaming
 * responses. It's the primary interaction surface of the entire app.
 *
 * DESIGN DECISIONS
 * ================
 * - Messages auto-scroll to the bottom as new tokens arrive
 * - The input is disabled while connecting (prevents double-sends)
 * - The entire panel stays scrollable during reconnection
 * - Keyboard: Enter sends, Shift+Enter for newline
 *
 * HOW MESSAGES ARE SENT
 * =====================
 * Previously, we used a window.__sendMessage hack to pass the send function
 * from page.tsx to this component. That was fragile and looked bad in a
 * systems engineering assignment.
 *
 * Now: the useWebSocket hook registers sendMessage in the Zustand store.
 * We just read it here: `store.sendMessageFn("hello")`. Clean and testable.
 */

'use client'

import { useRef, useState, useCallback, type KeyboardEvent } from 'react'
import { useConsoleStore } from '@/lib/streams/streamState'
import { stateDescription, canSendMessage } from '@/lib/protocol/stateMachine'
import { MessageBubble } from './MessageBubble'

type Props = {
  onToolCallClick?: (callId: string) => void
}

export function ChatPanel({ onToolCallClick }: Props) {
  const messages = useConsoleStore((s) => s.messages)
  const connectionState = useConsoleStore((s) => s.connectionState)
  const sendMessageFn = useConsoleStore((s) => s.sendMessageFn)
  const [inputValue, setInputValue] = useState('')
  const messagesEndRef = useRef<HTMLDivElement>(null)

  const handleSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault()
      const content = inputValue.trim()
      if (!content || !sendMessageFn) return

      setInputValue('')
      sendMessageFn(content)
    },
    [inputValue, sendMessageFn],
  )

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        handleSubmit(e as unknown as React.FormEvent)
      }
    },
    [handleSubmit],
  )

  const isInputDisabled = !canSendMessage(connectionState)
  const isActive =
    connectionState === 'STREAMING' || connectionState === 'TOOL_CALL_PENDING'

  return (
    <div style={styles.container}>
      {/* Header bar with connection status */}
      <div style={styles.header}>
        <div style={styles.headerLeft}>
          <span
            style={{
              width: '8px',
              height: '8px',
              borderRadius: '50%',
              backgroundColor: isActive
                ? '#22c55e'
                : connectionState === 'RECONNECTING' || connectionState === 'RESUMING'
                  ? '#f59e0b'
                  : connectionState === 'FAILED'
                    ? '#ef4444'
                    : '#94a3b8',
              flexShrink: 0,
              display: 'inline-block',
            }}
          />
          <span style={styles.headerTitle}>Agent Console</span>
        </div>
        <span style={styles.headerState}>{stateDescription(connectionState)}</span>
      </div>

      {/* Message list */}
      <div style={styles.messageList} id="chat-messages">
        {messages.length === 0 && (
          <div style={styles.emptyState}>
            <div style={styles.emptyIcon}>🤖</div>
            <p style={styles.emptyTitle}>Ready to chat</p>
            <p style={styles.emptySubtitle}>
              Send a message to start. Try:{' '}
              <strong>&ldquo;hello&rdquo;</strong>,{' '}
              <strong>&ldquo;report&rdquo;</strong>,{' '}
              <strong>&ldquo;analyze&rdquo;</strong>, or{' '}
              <strong>&ldquo;schema&rdquo;</strong> (for large context).
            </p>
          </div>
        )}

        {messages.map((msg) => (
          <MessageBubble
            key={msg.id}
            message={msg}
            isReconnecting={
              connectionState === 'RECONNECTING' || connectionState === 'RESUMING'
            }
            onToolCallClick={onToolCallClick}
          />
        ))}

        <div ref={messagesEndRef} />
      </div>

      {/* Input area */}
      <div style={styles.inputArea}>
        <form onSubmit={handleSubmit} style={styles.inputForm}>
          <textarea
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={
              isInputDisabled
                ? 'Waiting for connection...'
                : 'Type a message to the agent...'
            }
            disabled={isInputDisabled}
            style={{
              ...styles.textarea,
              opacity: isInputDisabled ? 0.5 : 1,
            }}
            rows={1}
            aria-label="Message input"
            id="chat-input"
          />
          <button
            type="submit"
            disabled={isInputDisabled || !inputValue.trim()}
            style={{
              ...styles.sendButton,
              opacity: isInputDisabled || !inputValue.trim() ? 0.4 : 1,
            }}
            aria-label="Send message"
            id="send-button"
          >
            Send
          </button>
        </form>
        <div style={styles.hint}>Enter to send · Shift+Enter for newline</div>
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
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '14px 20px',
    borderBottom: '1px solid #1e293b',
    backgroundColor: '#0f172a',
    flexShrink: 0,
  },
  headerLeft: {
    display: 'flex',
    alignItems: 'center',
    gap: '10px',
  },
  headerTitle: {
    fontWeight: 600,
    fontSize: '15px',
    color: '#f1f5f9',
    letterSpacing: '-0.01em',
  },
  headerState: {
    fontSize: '12px',
    color: '#64748b',
  },
  messageList: {
    flex: 1,
    overflowY: 'auto',
    padding: '20px 0',
    display: 'flex',
    flexDirection: 'column',
    gap: '4px',
  },
  emptyState: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    height: '100%',
    padding: '32px',
    textAlign: 'center',
  },
  emptyIcon: {
    fontSize: '52px',
    marginBottom: '16px',
  },
  emptyTitle: {
    fontSize: '20px',
    fontWeight: 600,
    color: '#e2e8f0',
    margin: '0 0 10px 0',
  },
  emptySubtitle: {
    fontSize: '14px',
    color: '#64748b',
    margin: 0,
    maxWidth: '380px',
    lineHeight: 1.6,
  },
  inputArea: {
    padding: '14px 20px',
    borderTop: '1px solid #1e293b',
    backgroundColor: '#0f172a',
    flexShrink: 0,
  },
  inputForm: {
    display: 'flex',
    gap: '10px',
    alignItems: 'flex-end',
  },
  textarea: {
    flex: 1,
    padding: '12px 14px',
    border: '1px solid #334155',
    borderRadius: '10px',
    fontFamily: "'Inter', 'system-ui', sans-serif",
    fontSize: '14px',
    resize: 'none',
    outline: 'none',
    lineHeight: 1.5,
    maxHeight: '120px',
    overflowY: 'auto',
    transition: 'border-color 0.2s',
    backgroundColor: '#1e293b',
    color: '#f1f5f9',
  },
  sendButton: {
    padding: '12px 24px',
    backgroundColor: '#6366f1',
    color: '#fff',
    border: 'none',
    borderRadius: '10px',
    fontFamily: "'Inter', 'system-ui', sans-serif",
    fontSize: '14px',
    fontWeight: 600,
    cursor: 'pointer',
    transition: 'background-color 0.2s, transform 0.1s',
    flexShrink: 0,
  },
  hint: {
    fontSize: '11px',
    color: '#475569',
    marginTop: '6px',
    textAlign: 'center',
  },
}