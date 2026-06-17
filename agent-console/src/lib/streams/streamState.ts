/**
 * streamState.ts — Zustand store for the entire agent console state
 *
 * This store is the single source of truth for everything the UI renders:
 *   - Chat messages (user + agent, with live streaming tokens)
 *   - Tool call cards and their results
 *   - Context snapshots and their history (for diffing)
 *   - Connection state and reconnection status
 *   - Timeline events (the trace sidebar)
 *   - The highest processed seq (for RESUME on reconnect)
 *
 * WHY ZUSTAND?
 * =============
 * We need to share state across three panels (Chat, Timeline, Context).
 *
 * Redux would work but has too much boilerplate for a 5-day build — you'd
 * need action creators, reducers, selectors, and a provider. For a WebSocket
 * app where state changes 30+ times per second, that overhead matters.
 *
 * useState + useContext would also work but requires prop drilling or
 * wrapping the entire app in context providers. It also re-renders every
 * consumer on every state change (no fine-grained subscriptions).
 *
 * Zustand gives us:
 *   - Zero boilerplate — just define state and mutators
 *   - Fine-grained subscriptions — components subscribe to specific slices
 *   - subscribeWithSelector for watching specific state changes
 *   - No provider wrapping
 *   - Trivially testable — it's just a function
 *
 * SUBSCRIPTION PATTERNS
 * =====================
 * Components subscribe to only what they need:
 *
 *   // Only re-renders when chat messages change
 *   const messages = useConsoleStore(s => s.messages)
 *
 *   // Only re-renders when connection state changes
 *   const connState = useConsoleStore(s => s.connectionState)
 *
 * This is key to handling 30+ token events per second without jank.
 * The timeline might be updating, but the context panel won't re-render
 * unless a context snapshot actually changed.
 */

// ─── Imports ─────────────────────────────────────────────────────────────────

import { create } from 'zustand'
import { subscribeWithSelector } from 'zustand/middleware'
import type {
  ConnectionState,
  StreamState,
  ToolCallEntry,
  TimelineEvent,
  SnapshotEntry,
  TOOL_CALL,
} from './types'

// ─── Chat Message Type ──────────────────────────────────────────────────────

/**
 * A chat message shown in the UI.
 *
 * There are two kinds:
 *   - 'user' (right-aligned blue bubble) — what the human typed
 *   - 'agent' (left-aligned, white background) — the AI's response
 *
 * Agent messages have a `streamId` that links them to a server stream.
 * As tokens arrive, we update the message's `content` field in-place.
 */
export type Message = {
  id: string
  role: 'user' | 'agent'
  content: string
  streamId: string | null   // null for user messages
  status: 'idle' | 'streaming' | 'tool_call_pending' | 'complete'
  toolCalls: ToolCallEntry[]
  createdAt: number
}

// ─── Store Shape ────────────────────────────────────────────────────────────

type ConsoleStore = {
  // ── Connection ──────────────────────────────────────────────────────────
  connectionState: ConnectionState
  reconnectAttempt: number
  setConnectionState: (state: ConnectionState) => void
  setReconnectAttempt: (n: number) => void

  // ── Chat Messages ──────────────────────────────────────────────────────
  messages: Message[]
  addMessage: (message: Message) => void
  updateAgentMessage: (id: string, text: string) => void
  addToolCallToMessage: (messageId: string, toolCall: TOOL_CALL) => void
  resolveToolCallInMessage: (messageId: string, callId: string, result: Record<string, unknown>) => void
  markMessageStreamEnd: (messageId: string) => void

  // ── Stream State ───────────────────────────────────────────────────────
  streams: Record<string, StreamState>
  appendToken: (streamId: string, text: string, seq: number) => void
  pauseStream: (streamId: string) => void
  resumeStream: (streamId: string) => void
  addToolCall: (streamId: string, toolCall: TOOL_CALL) => void
  resolveToolCall: (callId: string, result: Record<string, unknown>, seq: number) => void
  markStreamEnd: (streamId: string) => void

  // ── Seq Tracking ───────────────────────────────────────────────────────
  lastProcessedSeq: number
  setLastProcessedSeq: (seq: number) => void

  // ── Timeline ───────────────────────────────────────────────────────────
  events: TimelineEvent[]
  addEvent: (event: TimelineEvent) => void
  highlightedEventId: string | null
  setHighlightedEventId: (id: string | null) => void

  /**
   * Token batch accumulator for the timeline.
   *
   * Instead of logging one timeline row per TOKEN (which would create 30+
   * rows per second), we accumulate tokens and flush every 200ms into a
   * single row like "Streamed 47 tokens (1.2s)".
   */
  tokenBatch: { seq: number; streamId: string; tokenCount: number; startTime: number } | null
  accumulateToken: (seq: number, streamId: string) => void
  flushTokenBatch: () => void

  // ── Context Snapshots ──────────────────────────────────────────────────
  snapshots: Record<string, SnapshotEntry[]>
  currentContextId: string | null
  addSnapshot: (contextId: string, seq: number, data: Record<string, unknown>) => void
  setCurrentContext: (contextId: string | null) => void
  scrubberPosition: Record<string, number>
  setScrubberPosition: (contextId: string, pos: number) => void

  // ── Send Message (replaces window.__sendMessage hack) ──────────────────
  /**
   * The sendMessage function is set by the useWebSocket hook after it
   * initializes the WebSocket connection. Components call this to send
   * messages without needing a window global or prop drilling.
   */
  sendMessageFn: ((content: string) => void) | null
  setSendMessageFn: (fn: (content: string) => void) => void
}

// ─── Store Implementation ───────────────────────────────────────────────────

export const useConsoleStore = create<ConsoleStore>()(
  subscribeWithSelector((set) => ({
    // ── Connection ──────────────────────────────────────────────────────────

    connectionState: 'DISCONNECTED',
    reconnectAttempt: 0,

    setConnectionState: (connectionState) => set({ connectionState }),
    setReconnectAttempt: (n) => set({ reconnectAttempt: n }),

    // ── Chat Messages ──────────────────────────────────────────────────────

    messages: [],

    addMessage: (message) =>
      set((s) => ({ messages: [...s.messages, message] })),

    updateAgentMessage: (id, content) =>
      set((s) => ({
        messages: s.messages.map((m) =>
          m.id === id ? { ...m, content } : m,
        ),
      })),

    addToolCallToMessage: (messageId, toolCall) =>
      set((s) => ({
        messages: s.messages.map((m) => {
          if (m.id !== messageId) return m
          // Check for duplicate (can happen during replay)
          if (m.toolCalls.some((tc) => tc.call_id === toolCall.call_id)) return m
          return {
            ...m,
            status: 'tool_call_pending' as const,
            toolCalls: [
              ...m.toolCalls,
              {
                call_id: toolCall.call_id,
                tool_name: toolCall.tool_name,
                args: toolCall.args,
                result: null,
                resultSeq: null,
              },
            ],
          }
        }),
      })),

    resolveToolCallInMessage: (messageId, callId, result) =>
      set((s) => ({
        messages: s.messages.map((m) => {
          if (m.id !== messageId) return m
          return {
            ...m,
            status: 'streaming' as const,
            toolCalls: m.toolCalls.map((tc) =>
              tc.call_id === callId ? { ...tc, result } : tc,
            ),
          }
        }),
      })),

    markMessageStreamEnd: (messageId) =>
      set((s) => ({
        messages: s.messages.map((m) =>
          m.id === messageId ? { ...m, status: 'complete' as const } : m,
        ),
      })),

    // ── Stream State ─────────────────────────────────────────────────────────

    streams: {},

    appendToken: (streamId, text, seq) =>
      set((s) => {
        const existing = s.streams[streamId]
        if (!existing) {
          // First token for this stream — create stream state
          const newStream: StreamState = {
            streamId,
            text,
            status: 'streaming',
            toolCalls: [],
            contextId: null,
            lastProcessedSeq: seq,
            startedAt: Date.now(),
          }
          return { streams: { ...s.streams, [streamId]: newStream } }
        }
        return {
          streams: {
            ...s.streams,
            [streamId]: { ...existing, text, lastProcessedSeq: seq },
          },
        }
      }),

    pauseStream: (streamId) =>
      set((s) => {
        const stream = s.streams[streamId]
        if (!stream) return s
        return {
          streams: {
            ...s.streams,
            [streamId]: { ...stream, status: 'tool_call_pending' },
          },
        }
      }),

    resumeStream: (streamId) =>
      set((s) => {
        const stream = s.streams[streamId]
        if (!stream) return s
        return {
          streams: {
            ...s.streams,
            [streamId]: { ...stream, status: 'streaming' },
          },
        }
      }),

    addToolCall: (streamId, toolCall) =>
      set((s) => {
        const stream = s.streams[streamId]
        if (!stream) return s
        // Prevent duplicate tool calls (can happen during replay)
        if (stream.toolCalls.some((tc) => tc.call_id === toolCall.call_id)) return s
        return {
          streams: {
            ...s.streams,
            [streamId]: {
              ...stream,
              status: 'tool_call_pending',
              toolCalls: [
                ...stream.toolCalls,
                {
                  call_id: toolCall.call_id,
                  tool_name: toolCall.tool_name,
                  args: toolCall.args,
                  result: null,
                  resultSeq: null,
                },
              ],
            },
          },
        }
      }),

    resolveToolCall: (callId, result, seq) =>
      set((s) => {
        const streams = { ...s.streams }
        for (const [id, stream] of Object.entries(streams)) {
          const idx = stream.toolCalls.findIndex((tc) => tc.call_id === callId)
          if (idx !== -1) {
            const updatedToolCalls = [...stream.toolCalls]
            updatedToolCalls[idx] = { ...updatedToolCalls[idx], result, resultSeq: seq }
            streams[id] = {
              ...stream,
              status: 'streaming',
              toolCalls: updatedToolCalls,
            }
            break
          }
        }
        return { streams }
      }),

    markStreamEnd: (streamId) =>
      set((s) => {
        const stream = s.streams[streamId]
        if (!stream) return s
        return {
          streams: {
            ...s.streams,
            [streamId]: { ...stream, status: 'complete' },
          },
        }
      }),

    // ── Seq Tracking ─────────────────────────────────────────────────────────

    lastProcessedSeq: 0,
    setLastProcessedSeq: (lastProcessedSeq) => set({ lastProcessedSeq }),

    // ── Timeline ─────────────────────────────────────────────────────────────

    events: [],

    addEvent: (event) =>
      set((s) => ({ events: [...s.events, event] })),

    highlightedEventId: null,
    setHighlightedEventId: (highlightedEventId) => set({ highlightedEventId }),

    tokenBatch: null,

    accumulateToken: (seq, streamId) =>
      set((s) => {
        const now = Date.now()
        if (s.tokenBatch === null) {
          return {
            tokenBatch: { seq, streamId, tokenCount: 1, startTime: now },
          }
        }
        return {
          tokenBatch: {
            ...s.tokenBatch,
            seq,
            streamId,
            tokenCount: s.tokenBatch.tokenCount + 1,
          },
        }
      }),

    flushTokenBatch: () =>
      set((s) => {
        if (s.tokenBatch === null) return s
        const { seq, streamId, tokenCount, startTime } = s.tokenBatch
        const duration = Date.now() - startTime
        const durationStr = duration < 1000
          ? `${duration}ms`
          : `${(duration / 1000).toFixed(1)}s`

        const event: TimelineEvent = {
          seq,
          type: 'TOKEN_BATCH',
          summary: `Streamed ${tokenCount} token${tokenCount !== 1 ? 's' : ''} (${durationStr})`,
          detail: `Batch of ${tokenCount} consecutive TOKEN events`,
          streamId,
          linkId: null,
          receivedAt: startTime,
        }
        return {
          events: [...s.events, event],
          tokenBatch: null,
        }
      }),

    // ── Context Snapshots ────────────────────────────────────────────────────

    snapshots: {},
    currentContextId: null,

    addSnapshot: (contextId, seq, data) =>
      set((s) => {
        const entry: SnapshotEntry = {
          contextId,
          seq,
          data,
          receivedAt: Date.now(),
        }
        const existing = s.snapshots[contextId] ?? []
        const newSnapshots = [...existing, entry]
        return {
          snapshots: {
            ...s.snapshots,
            [contextId]: newSnapshots,
          },
          currentContextId: contextId,
          // Auto-advance scrubber to the latest snapshot
          scrubberPosition: {
            ...s.scrubberPosition,
            [contextId]: newSnapshots.length - 1,
          },
        }
      }),

    setCurrentContext: (currentContextId) => set({ currentContextId }),

    scrubberPosition: {},

    setScrubberPosition: (contextId, pos) =>
      set((s) => ({
        scrubberPosition: { ...s.scrubberPosition, [contextId]: pos },
      })),

    // ── Send Message ─────────────────────────────────────────────────────────

    sendMessageFn: null,
    setSendMessageFn: (fn) => set({ sendMessageFn: fn }),
  })),
)

// ─── Derived Selectors ──────────────────────────────────────────────────────

/**
 * Select a specific stream by its stream_id.
 * Only re-renders when THAT stream's state changes.
 */
export function useStream(streamId: string) {
  return useConsoleStore((s) => s.streams[streamId])
}

/**
 * Select the latest agent message (for checking if we need to create one).
 */
export function useLatestAgentMessage() {
  return useConsoleStore((s) => {
    const agentMessages = s.messages.filter((m) => m.role === 'agent')
    return agentMessages[agentMessages.length - 1] ?? null
  })
}

/**
 * Select context snapshots for a given context_id.
 *
 * IMPORTANT: We use a stable empty array constant to avoid infinite re-render
 * loops. If we returned `[]` inline, every call would create a new array
 * reference, Zustand would see it as "changed", trigger a re-render, which
 * calls the selector again → new `[]` → "changed" → re-render → infinite loop.
 */
const EMPTY_SNAPSHOTS: never[] = []

export function useContextSnapshots(contextId: string | null) {
  return useConsoleStore((s) => {
    if (!contextId) return EMPTY_SNAPSHOTS
    return s.snapshots[contextId] ?? EMPTY_SNAPSHOTS
  })
}