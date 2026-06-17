/**
 * stateMachine.ts — WebSocket Connection State Machine
 *
 * This is the brain of the connection lifecycle. Every WebSocket event — open,
 * close, message arrival — passes through this function, which decides what
 * state we should be in next.
 *
 * WHY A STATE MACHINE AND NOT BOOLEANS?
 * ======================================
 * Without it, you end up with boolean flags like `isConnected`, `isReconnecting`,
 * `isWaitingForToolResult` — and the logic becomes a tangle of nested ifs that
 * nobody can reason about. A state machine makes every transition explicit.
 *
 * You can ask "what happens when TOOL_CALL arrives while RECONNECTING?" and
 * get a clear answer: look at the RECONNECTING case in the switch. Done.
 *
 * It's also trivially testable — drive the machine through any sequence of
 * events and assert the resulting state. No mocks, no side effects.
 *
 * THE STATES
 * ==========
 * DISCONNECTED     — No WebSocket. Never connected, or intentionally closed.
 * CONNECTING       — WebSocket constructor called, waiting for `open` event.
 * CONNECTED        — Socket is open but no user message sent yet. Ready to go.
 * STREAMING        — Tokens are flowing in. The happy path.
 * TOOL_CALL_PENDING — One or more tool calls are in progress, stream is paused.
 *                    Note: we can receive MULTIPLE tool calls in this state
 *                    (rapid tool calls in chaos mode). We stay here until ALL
 *                    tool results come back.
 * RECONNECTING     — The WebSocket closed unexpectedly. We're retrying with
 *                    exponential backoff. The UI stays fully interactive.
 * RESUMING         — We've reconnected and sent RESUME. Server is replaying
 *                    events we missed. We process them before going back to STREAMING.
 * FAILED           — Max retries exceeded. The user needs to refresh.
 *
 * STATE TRANSITIONS (ASCII diagram)
 * ==================================
 *
 *   DISCONNECTED
 *       │ connect()
 *       ▼
 *   CONNECTING ──(WS open)──► CONNECTED
 *                              │
 *                              │ send USER_MESSAGE
 *                              ▼
 *                         STREAMING ◄──────────────────────┐
 *                              │                           │
 *                              │ TOOL_CALL arrives         │ last TOOL_RESULT arrives
 *                              ▼                           │
 *                     TOOL_CALL_PENDING ──────────────────┘
 *                              │ (can receive more TOOL_CALLs here — stays put)
 *                              │
 *                 (WS close / 3 missed PONGs)
 *                              ▼
 *                       RECONNECTING
 *                              │
 *                              │ reconnect succeeds ──► RESUMING
 *                              │                           │
 *                              │                    (replay done) → STREAMING
 *                              │
 *                (max retries exceeded)
 *                              ▼
 *                         FAILED
 *
 * RECONNECTION: THE TRICKY PART
 * ==============================
 * When we reconnect after a drop, the WS_OPEN event needs to go to RESUMING
 * (not CONNECTED), because we need to send RESUME as the very first message.
 * But on the *initial* connection, WS_OPEN should go to CONNECTED (we haven't
 * started a stream yet, there's nothing to resume).
 *
 * We solve this by adding a `isReconnect` flag to the WS_OPEN event. The
 * wsManager knows whether this is a first connect or a reconnect, and passes
 * that information through.
 */

import type { ConnectionState } from '@/lib/streams/types'

// ─── Event Types ─────────────────────────────────────────────────────────────

/**
 * All the events that can drive a state transition.
 *
 * These map directly to things that happen in the real world:
 * - WS_OPEN: the browser's WebSocket fired its `open` event
 * - WS_CLOSE: the browser's WebSocket fired its `close` event
 * - TOOL_CALL_RECEIVED: the message processor found a TOOL_CALL in the buffer
 * - etc.
 *
 * The `isReconnect` flag on WS_OPEN is how we distinguish "first connection"
 * from "reconnecting after a drop". This drives the CONNECTED vs RESUMING
 * decision.
 */
export type StateMachineEvent =
  | { type: 'CONNECT' }
  | { type: 'WS_OPEN'; isReconnect: boolean }
  | { type: 'WS_CLOSE' }
  | { type: 'WS_ERROR' }
  | { type: 'USER_MESSAGE_SENT' }
  | { type: 'TOKEN_RECEIVED' }
  | { type: 'TOOL_CALL_RECEIVED' }
  | { type: 'TOOL_RESULT_RECEIVED' }
  | { type: 'STREAM_END_RECEIVED' }
  | { type: 'RESUME_SENT'; lastSeq: number }
  | { type: 'RESUME_COMPLETE' }
  | { type: 'MAX_RETRIES_EXCEEDED' }
  | { type: 'RESET' }

// ─── State Machine ───────────────────────────────────────────────────────────

/**
 * Pure function: given current state + event, returns the next state.
 *
 * No side effects, no async, no I/O. This makes it easy to test —
 * just call transition() with different inputs and assert the output.
 *
 * Every state handles every event it cares about. Events that don't apply
 * to a state return `current` (no change). This is intentional — it means
 * we don't crash on unexpected events, we just ignore them.
 */
export function transition(
  current: ConnectionState,
  event: StateMachineEvent,
): ConnectionState {
  switch (current) {
    // ── DISCONNECTED: nothing is happening yet ─────────────────────────────
    case 'DISCONNECTED':
      switch (event.type) {
        case 'CONNECT':
          return 'CONNECTING'
        default:
          return current
      }

    // ── CONNECTING: socket is being created, waiting for open ──────────────
    case 'CONNECTING':
      switch (event.type) {
        case 'WS_OPEN':
          // This is the key decision point.
          // First connection → CONNECTED (user hasn't sent anything yet).
          // Reconnection → RESUMING (we need to send RESUME first).
          return event.isReconnect ? 'RESUMING' : 'CONNECTED'
        case 'WS_CLOSE':
        case 'WS_ERROR':
          return 'RECONNECTING'
        default:
          return current
      }

    // ── CONNECTED: socket is open, waiting for user to send first message ──
    case 'CONNECTED':
      switch (event.type) {
        case 'USER_MESSAGE_SENT':
          return 'STREAMING'
        case 'TOKEN_RECEIVED':
          // Edge case: server sends tokens before we've explicitly tracked
          // a USER_MESSAGE_SENT (can happen if message send is async).
          // Transition to STREAMING so we process them correctly.
          return 'STREAMING'
        case 'WS_CLOSE':
        case 'WS_ERROR':
          return 'RECONNECTING'
        case 'TOOL_CALL_RECEIVED':
          // Shouldn't happen per protocol, but handle gracefully.
          return 'TOOL_CALL_PENDING'
        default:
          return current
      }

    // ── STREAMING: tokens are flowing, this is the happy path ──────────────
    case 'STREAMING':
      switch (event.type) {
        case 'TOOL_CALL_RECEIVED':
          return 'TOOL_CALL_PENDING'
        case 'WS_CLOSE':
        case 'WS_ERROR':
          return 'RECONNECTING'
        case 'STREAM_END_RECEIVED':
          // Stream ended — go back to CONNECTED (idle, ready for next turn)
          return 'CONNECTED'
        default:
          return current
      }

    // ── TOOL_CALL_PENDING: waiting for tool result(s) ─────────────────────
    //
    // IMPORTANT: In chaos mode, the server can fire TWO tool calls in quick
    // succession before sending any result. We need to handle TOOL_CALL_RECEIVED
    // here — we just stay in TOOL_CALL_PENDING. The message processor stacks
    // multiple tool calls in its toolCalls array.
    //
    // We return to STREAMING when TOOL_RESULT_RECEIVED arrives. If there are
    // still pending tool calls (from rapid fire), the message processor knows
    // about them and will handle the next TOOL_RESULT correctly.
    case 'TOOL_CALL_PENDING':
      switch (event.type) {
        case 'TOOL_RESULT_RECEIVED':
          return 'STREAMING'
        case 'TOOL_CALL_RECEIVED':
          // Another tool call while we're already waiting for one.
          // This is the "rapid tool calls" chaos mode scenario.
          // Stay in TOOL_CALL_PENDING — the processor stacks them.
          return 'TOOL_CALL_PENDING'
        case 'WS_CLOSE':
        case 'WS_ERROR':
          return 'RECONNECTING'
        default:
          return current
      }

    // ── RECONNECTING: socket dropped, we're backing off and retrying ──────
    case 'RECONNECTING':
      switch (event.type) {
        case 'CONNECT':
          return 'CONNECTING'
        case 'MAX_RETRIES_EXCEEDED':
          return 'FAILED'
        default:
          return current
      }

    // ── RESUMING: reconnected, sent RESUME, waiting for replayed events ───
    case 'RESUMING':
      switch (event.type) {
        case 'RESUME_COMPLETE':
          return 'STREAMING'
        case 'WS_CLOSE':
        case 'WS_ERROR':
          // Dropped again during resume — back to reconnecting.
          return 'RECONNECTING'
        // During resume, we might receive TOOL_CALL or TOOL_RESULT as part
        // of the replay. We stay in RESUMING until RESUME_COMPLETE.
        case 'TOOL_CALL_RECEIVED':
        case 'TOOL_RESULT_RECEIVED':
        case 'TOKEN_RECEIVED':
        case 'STREAM_END_RECEIVED':
          return 'RESUMING'
        default:
          return current
      }

    // ── FAILED: max retries exceeded, user needs to take action ───────────
    case 'FAILED':
      switch (event.type) {
        case 'RESET':
          return 'DISCONNECTED'
        case 'CONNECT':
          // Allow manual retry from failed state.
          return 'CONNECTING'
        default:
          return current
      }

    default:
      // Exhaustiveness check: TypeScript will error at compile time if we
      // add a new ConnectionState value and forget to handle it here.
      const _exhaustive: never = current
      return _exhaustive
  }
}

/**
 * Human-readable description of what the current state means for the user.
 * Shown in the chat header and reconnection banner.
 */
export function stateDescription(state: ConnectionState): string {
  switch (state) {
    case 'DISCONNECTED':
      return 'Not connected'
    case 'CONNECTING':
      return 'Connecting to agent server...'
    case 'CONNECTED':
      return 'Connected — ready to chat'
    case 'STREAMING':
      return 'Agent is responding...'
    case 'TOOL_CALL_PENDING':
      return 'Running tool...'
    case 'RECONNECTING':
      return 'Connection lost, reconnecting...'
    case 'RESUMING':
      return 'Reconnected — syncing state...'
    case 'FAILED':
      return 'Connection failed. Please refresh the page.'
  }
}

/**
 * Whether the UI should allow the user to type and send messages.
 *
 * We're generous here: even during reconnection, the chat panel stays
 * scrollable and readable. We only disable input when we truly can't
 * send (RECONNECTING, RESUMING, FAILED).
 */
export function canSendMessage(state: ConnectionState): boolean {
  return (
    state === 'CONNECTED' ||
    state === 'STREAMING' ||
    state === 'TOOL_CALL_PENDING' ||
    state === 'DISCONNECTED'
  )
}