/**
 * useWebSocket.ts — The hook that wires everything together
 *
 * This is the glue between the WebSocket manager, the message processor,
 * and the Zustand store. It's the only place where these three layers
 * interact, and it's intentionally kept as a thin wiring layer.
 *
 * WHAT THIS HOOK DOES
 * ====================
 * 1. Creates a MessageProcessor (once) with callbacks that update the store
 * 2. Subscribes to wsManager events and routes them to the processor
 * 3. Handles the RESUME flow: when state becomes RESUMING, sends RESUME
 * 4. Manages the token batch flusher (200ms interval for timeline perf)
 * 5. Provides `sendMessage` to components (via the store, not window globals)
 *
 * WHY A HOOK AND NOT JUST DIRECT WIRING?
 * =======================================
 * We need React lifecycle integration:
 *   - The subscriber needs to be cleaned up on unmount
 *   - The batch flush interval needs to be cleared on unmount
 *   - The sendMessage function needs to be stable (useCallback)
 *
 * The hook runs in the root component (page.tsx) and its effects persist
 * for the lifetime of the app. Components deeper in the tree never need
 * to call this hook — they just read from the Zustand store.
 *
 * TOKEN BATCH FLUSHING
 * ====================
 * The timeline would get overwhelmed if we logged every single TOKEN event
 * (30+ per second during streaming). Instead:
 *   - Each TOKEN event calls accumulateToken() in the store
 *   - Every 200ms, flushTokenBatch() runs and creates ONE timeline entry
 *     like "Streamed 47 tokens (1.2s)"
 *   - This keeps the timeline readable and performant
 */

import { useEffect, useRef, useCallback } from 'react'
import { wsManager } from '@/lib/protocol/wsManager'
import { MessageProcessor } from '@/lib/protocol/messageProcessor'
import { useConsoleStore } from '@/lib/streams/streamState'
import type { TOOL_CALL } from '@/lib/streams/types'

// ─── The Hook ────────────────────────────────────────────────────────────────

export function useWebSocket() {
  // The processor lives in a ref so it survives re-renders.
  // It's created once and never recreated.
  const processorRef = useRef<MessageProcessor | null>(null)

  // Token batch flush interval
  const flushIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // ── Initialize the processor (once) ──────────────────────────────────

  if (!processorRef.current) {
    processorRef.current = new MessageProcessor({
      /**
       * Called every time lastProcessedSeq advances.
       * We store this in Zustand so the RESUME logic can read it.
       */
      onSeqAdvance: (seq) => {
        useConsoleStore.getState().setLastProcessedSeq(seq)
      },

      /**
       * Called when the processor has a state update for the UI.
       *
       * This is where protocol events become UI changes. Each update
       * type maps to one or more Zustand actions. The mapping is
       * intentionally explicit — no magic, just a switch statement
       * that any developer can follow.
       */
      onStoreUpdate: (update) => {
        const store = useConsoleStore.getState()

        switch (update.type) {
          case 'TOKEN': {
            // Find the agent message for this stream
            const existingMsg = store.messages.find(
              (m) => m.streamId === update.streamId && m.role === 'agent',
            )

            if (existingMsg) {
              // Update the existing message's text
              store.updateAgentMessage(existingMsg.id, update.text)
            } else {
              // First token for this stream — create the agent message.
              // This is how agent "bubbles" appear in the chat: when the
              // first token of a new stream arrives.
              const newMsg = {
                id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                role: 'agent' as const,
                content: update.text,
                streamId: update.streamId,
                status: 'streaming' as const,
                toolCalls: [],
                createdAt: Date.now(),
              }
              store.addMessage(newMsg)
            }

            // Also update the per-stream state
            store.appendToken(update.streamId, update.text, update.seq)
            wsManager.transition({ type: 'TOKEN_RECEIVED' })
            break
          }

          case 'TOOL_CALL_START': {
            const tc = update.toolCall

            // Find the agent message for this stream
            const msg = store.messages.find(
              (m) => m.streamId === tc.stream_id && m.role === 'agent',
            )

            // Pause the stream
            store.pauseStream(tc.stream_id)

            // Add tool call to both stream state and chat message
            store.addToolCall(tc.stream_id, tc)
            if (msg) {
              store.addToolCallToMessage(msg.id, tc)
            }
            wsManager.transition({ type: 'TOOL_CALL_RECEIVED' })
            break
          }

          case 'TOOL_RESULT_ARRIVED': {
            // Update the tool call with its result
            store.resolveToolCall(update.callId, update.result, update.seq)

            // Also update the chat message's tool card
            const msg = store.messages.find((m) =>
              m.toolCalls.some((tc) => tc.call_id === update.callId),
            )
            if (msg) {
              store.resolveToolCallInMessage(msg.id, update.callId, update.result)
            }

            // Resume the stream
            store.resumeStream(update.streamId)
            wsManager.transition({ type: 'TOOL_RESULT_RECEIVED' })
            break
          }

          case 'CONTEXT_UPDATE': {
            store.addSnapshot(update.contextId, update.seq, update.data)
            break
          }

          case 'STREAM_END': {
            // Mark both the stream state and the chat message as complete
            store.markStreamEnd(update.streamId)
            const msg = store.messages.find(
              (m) => m.streamId === update.streamId && m.role === 'agent',
            )
            if (msg) {
              store.markMessageStreamEnd(msg.id)
            }
            wsManager.transition({ type: 'STREAM_END_RECEIVED' })
            break
          }

          case 'ERROR': {
            console.error(`[agent error] ${update.code}: ${update.message}`)
            break
          }
        }
      },

      /**
       * Called when a new timeline event should be logged.
       */
      onTimelineEvent: (event) => {
        useConsoleStore.getState().addEvent(event)
      },

      /**
       * Called when we need to send TOOL_ACK to the server.
       * The processor calls this immediately when TOOL_CALL is processed.
       */
      onSendToolAck: (callId) => {
        wsManager.send({ type: 'TOOL_ACK', call_id: callId })
      },
    })
  }

  // ── Token batch flush interval (200ms) ─────────────────────────────────

  useEffect(() => {
    flushIntervalRef.current = setInterval(() => {
      useConsoleStore.getState().flushTokenBatch()
    }, 200)

    return () => {
      if (flushIntervalRef.current !== null) {
        clearInterval(flushIntervalRef.current)
      }
    }
  }, [])

  // ── Subscribe to WebSocket manager events ──────────────────────────────

  useEffect(() => {
    const unsubscribe = wsManager.on((event) => {
      switch (event.type) {
        case 'STATE_CHANGE': {
          const store = useConsoleStore.getState()
          store.setConnectionState(event.state)

          // When we reach STREAMING (from RESUMING or first message),
          // reset the reconnection counter — we're back to normal.
          if (event.state === 'STREAMING') {
            wsManager.resetReconnectAttempt()
            store.setReconnectAttempt(0)
          }

          // When we enter RESUMING, send RESUME as the first message.
          // This tells the server: "Replay everything after seq X."
          if (event.state === 'RESUMING') {
            const lastSeq = processorRef.current?.getLastProcessedSeq() ?? 0
            console.log(`[useWebSocket] Sending RESUME with last_seq=${lastSeq}`)

            // Send RESUME immediately — it MUST be the first message on
            // the new connection.
            wsManager.send({ type: 'RESUME', last_seq: lastSeq })

            // Log to timeline
            store.addEvent({
              seq: lastSeq,
              type: 'RESUME',
              summary: `Resume from seq ${lastSeq}`,
              detail: `Requested replay of all events after seq ${lastSeq}`,
              streamId: null,
              linkId: null,
              receivedAt: Date.now(),
            })
          }
          break
        }

        case 'MESSAGE': {
          // Accumulate TOKEN events for timeline batching
          if (event.message.type === 'TOKEN') {
            useConsoleStore.getState().accumulateToken(
              event.message.seq,
              event.message.stream_id,
            )
          }

          // Send every message to the processor for seq-ordered processing
          processorRef.current?.process(event.message)

          // If we are in RESUMING state, check if we've processed all replayed events
          if (wsManager.getState() === 'RESUMING' && processorRef.current?.isBufferEmpty()) {
            wsManager.transition({ type: 'RESUME_COMPLETE' })
          }
          break
        }

        case 'RECONNECT_ATTEMPT': {
          useConsoleStore.getState().setReconnectAttempt(event.attempt)
          break
        }

        case 'ERROR': {
          console.error('[wsManager error]', event.error)
          break
        }
      }
    })

    return unsubscribe
  }, [])

  // ── Send message function ──────────────────────────────────────────────

  const sendMessage = useCallback((content: string) => {
    const store = useConsoleStore.getState()

    // Create the user message in the UI immediately (optimistic update)
    const userMsg = {
      id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      role: 'user' as const,
      content,
      streamId: null,
      status: 'idle' as const,
      toolCalls: [],
      createdAt: Date.now(),
    }
    store.addMessage(userMsg)

    // Reset sequence tracking for the new conversation turn (since the server starts seq from 0)
    processorRef.current?.reset()
    store.setLastProcessedSeq(0)

    // Connect if not already connected
    const state = wsManager.getState()
    if (state === 'DISCONNECTED' || state === 'FAILED') {
      wsManager.connect()
    }

    // Send the message. If we're still connecting, wait for the socket
    // to open before sending.
    const doSend = () => {
      wsManager.send({ type: 'USER_MESSAGE', content })
    }

    const currentState = wsManager.getState()
    if (currentState === 'CONNECTING') {
      // Socket isn't open yet — wait for the state to change to CONNECTED
      const unsub = wsManager.on((evt) => {
        if (evt.type === 'STATE_CHANGE' && evt.state === 'CONNECTED') {
          doSend()
          unsub()
        }
      })
    } else {
      doSend()
    }
  }, [])

  // Register sendMessage in the store so components can access it
  // without prop drilling or window globals.
  useEffect(() => {
    useConsoleStore.getState().setSendMessageFn(sendMessage)
  }, [sendMessage])

  return { sendMessage }
}