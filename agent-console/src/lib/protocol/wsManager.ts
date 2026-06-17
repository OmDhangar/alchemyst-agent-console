/**
 * wsManager.ts — WebSocket connection manager
 *
 * This is the lowest layer of the protocol stack. It manages:
 *   - Opening and closing the raw WebSocket connection
 *   - Sending JSON messages to the server
 *   - Receiving messages and dispatching them to subscribers
 *   - Automatic reconnection with exponential backoff
 *   - Coordinating with the heartbeat manager
 *
 * WHAT IT DOES NOT DO
 * ====================
 * It does NOT interpret messages. A TOKEN message and a TOOL_CALL message
 * are both just JSON objects as far as this module is concerned. The
 * message processor (messageProcessor.ts) handles interpretation.
 *
 * RECONNECTION STRATEGY
 * =====================
 * When the connection drops unexpectedly:
 *
 *   1. Transition to RECONNECTING state immediately
 *   2. Show the reconnect banner (within 500ms — the state change triggers it)
 *   3. Attempt to reconnect with exponential backoff:
 *        Attempt 1: wait 500ms, then try
 *        Attempt 2: wait 1s
 *        Attempt 3: wait 2s
 *        Attempt 4: wait 4s
 *        Attempt 5+: wait 10s (capped)
 *   4. After successful reconnect, the state machine goes to RESUMING
 *   5. The useWebSocket hook detects RESUMING and sends RESUME { last_seq }
 *   6. If max attempts (10) exceeded, transition to FAILED state
 *
 * WHY EXPONENTIAL BACKOFF?
 * ========================
 * If the server is temporarily down, hammering it with rapid reconnect
 * attempts makes things worse — it can overwhelm the server or trigger
 * rate limiting. Exponential backoff gives the server time to recover
 * while still retrying quickly enough that brief network hiccups are
 * invisible to the user.
 *
 * THE isReconnecting FLAG
 * =======================
 * This is how we tell the state machine "this WS_OPEN is a reconnection,
 * not a first connection." The state machine uses this to decide whether
 * to go to CONNECTED (first time) or RESUMING (reconnection).
 *
 * Without this flag, after a connection drop the client would go to
 * CONNECTED and never send RESUME — silently losing any messages that
 * arrived during the disconnect. This was the critical bug in the
 * previous version.
 */

// ─── Imports ─────────────────────────────────────────────────────────────────

import type {
  ClientMessage,
  ConnectionState,
  ServerMessage,
} from '@/lib/streams/types'
import { transition, type StateMachineEvent } from './stateMachine'
import { HeartbeatManager } from './heartbeat'

// ─── Constants ───────────────────────────────────────────────────────────────

/** WebSocket endpoint URL */
const WS_URL = 'ws://localhost:4747/ws'

/** Maximum reconnection attempts before giving up */
const MAX_RETRIES = 10

/**
 * Backoff delays in milliseconds, indexed by attempt number.
 * Attempt 1 → 500ms, Attempt 2 → 1s, ..., Attempt 5+ → 10s (capped).
 *
 * The assignment spec says: "500ms, 1s, 2s, 4s, capped at 10s"
 * So our array is exactly that.
 */
const BACKOFF_DELAYS = [500, 1000, 2000, 4000, 10000]

// ─── Event Types ─────────────────────────────────────────────────────────────

/**
 * Events emitted by the WebSocket manager.
 *
 * Subscribers (like useWebSocket hook) listen for these to update the UI
 * and drive the message processor.
 */
export type WsEvent =
  | { type: 'STATE_CHANGE'; state: ConnectionState }
  | { type: 'MESSAGE'; message: ServerMessage }
  | { type: 'RECONNECT_ATTEMPT'; attempt: number }
  | { type: 'ERROR'; error: Error }

export type WsEventHandler = (event: WsEvent) => void

// ─── WebSocket Manager ──────────────────────────────────────────────────────

export class WebSocketManager {
  // ── State ────────────────────────────────────────────────────────────────

  /** The raw WebSocket instance, or null if not connected */
  private ws: WebSocket | null = null

  /** Current connection state (mirrors the state machine) */
  private state: ConnectionState = 'DISCONNECTED'

  /** Current reconnection attempt number (0 = not reconnecting) */
  private reconnectAttempt = 0

  /** Timer ID for the next reconnect attempt */
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null

  /** Heartbeat manager — responds to PINGs */
  private heartbeat: HeartbeatManager

  /** Registered event handlers (subscribers) */
  private handlers: Set<WsEventHandler> = new Set()

  /**
   * Whether the current connection attempt is a reconnection.
   *
   * This is the key piece of state that tells the state machine to go
   * to RESUMING instead of CONNECTED when the socket opens. It's set
   * to true when scheduleReconnect fires, and reset to false after
   * successful resume.
   */
  private isReconnecting = false

  // ── Constructor ───────────────────────────────────────────────────────────

  constructor() {
    this.heartbeat = new HeartbeatManager({
      onSendPong: (pong) => this.sendDirect(pong),
      onTimeout: () => this.handleHeartbeatTimeout(),
    })
  }

  // ── Public API ───────────────────────────────────────────────────────────

  /**
   * Connect to the WebSocket server for the first time.
   * If already connected or connecting, this is a no-op.
   */
  connect(): void {
    // Don't reconnect if we're already connected or in the process
    if (this.state !== 'DISCONNECTED' && this.state !== 'FAILED') {
      return
    }

    this.isReconnecting = false // First connection, not a reconnection
    const event: StateMachineEvent = { type: 'CONNECT' }
    const next = transition(this.state, event)
    this.setState(next)

    this.heartbeat.start()
    this.openSocket()
  }

  /**
   * Disconnect from the WebSocket server intentionally.
   * No reconnection will be attempted.
   */
  disconnect(): void {
    this.clearReconnectTimer()
    this.heartbeat.stop()
    this.isReconnecting = false

    if (this.ws !== null) {
      this.ws.close(1000, 'Client initiated close')
      this.ws = null
    }

    this.setState('DISCONNECTED')
  }

  /**
   * Send a message to the server.
   *
   * If the socket isn't open yet, we log a warning and return silently.
   * This can happen if the user sends a message right as the connection
   * drops — the UI might not have caught up to the state change yet.
   */
  send(message: ClientMessage): void {
    if (this.ws === null || this.ws.readyState !== WebSocket.OPEN) {
      console.warn('[wsManager] Cannot send — socket not open:', message.type)
      return
    }

    this.ws.send(JSON.stringify(message))

    // If we just sent a USER_MESSAGE, tell the state machine
    if (message.type === 'USER_MESSAGE') {
      const event: StateMachineEvent = { type: 'USER_MESSAGE_SENT' }
      const next = transition(this.state, event)
      this.setState(next)
    }
  }

  /**
   * Transition the connection state machine manually.
   * Enables the message processor layer to drive UI states in strict sequence.
   */
  transition(event: StateMachineEvent): void {
    const next = transition(this.state, event)
    this.setState(next)
  }

  /**
   * Register an event handler. Returns an unsubscribe function.
   *
   * Usage:
   *   const unsub = wsManager.on((event) => { ... })
   *   // later: unsub()
   */
  on(handler: WsEventHandler): () => void {
    this.handlers.add(handler)
    return () => this.handlers.delete(handler)
  }

  /** Get the current connection state */
  getState(): ConnectionState {
    return this.state
  }

  /** Get the current reconnection attempt number */
  getReconnectAttempt(): number {
    return this.reconnectAttempt
  }

  /**
   * Reset the reconnection attempt counter.
   * Called after a successful RESUME — the connection is stable again.
   */
  resetReconnectAttempt(): void {
    this.reconnectAttempt = 0
    this.isReconnecting = false
  }

  // ── Internal Methods ───────────────────────────────────────────────────────

  /**
   * Dispatch an event to all registered handlers.
   * Every handler runs in a try/catch so one bad handler can't crash the rest.
   */
  private emit(event: WsEvent): void {
    for (const handler of this.handlers) {
      try {
        handler(event)
      } catch (err) {
        console.error('[wsManager] Handler threw:', err)
      }
    }
  }

  /**
   * Update the state and emit a STATE_CHANGE event.
   * This is the ONLY place where state transitions happen.
   * Everything flows through here, making it easy to debug.
   */
  private setState(newState: ConnectionState): void {
    if (this.state === newState) return
    const oldState = this.state
    this.state = newState
    console.log(`[wsManager] ${oldState} → ${newState}`)
    this.emit({ type: 'STATE_CHANGE', state: newState })
  }

  /**
   * Open a new WebSocket connection.
   *
   * Called both on initial connect and on reconnect. The difference is
   * tracked by `this.isReconnecting`, which the state machine reads via
   * the WS_OPEN event to decide between CONNECTED and RESUMING.
   */
  private openSocket(): void {
    // Clean up any existing socket before creating a new one
    if (this.ws !== null) {
      this.ws.onopen = null
      this.ws.onmessage = null
      this.ws.onclose = null
      this.ws.onerror = null
      if (
        this.ws.readyState === WebSocket.OPEN ||
        this.ws.readyState === WebSocket.CONNECTING
      ) {
        this.ws.close()
      }
    }

    try {
      this.ws = new WebSocket(WS_URL)
    } catch (err) {
      console.error('[wsManager] Failed to create WebSocket:', err)
      this.scheduleReconnect()
      return
    }

    // ── Socket opened successfully ──────────────────────────────────────
    this.ws.onopen = () => {
      // Pass isReconnect flag to the state machine so it knows whether
      // to go to CONNECTED or RESUMING.
      const event: StateMachineEvent = {
        type: 'WS_OPEN',
        isReconnect: this.isReconnecting,
      }
      const next = transition(this.state, event)
      this.setState(next)

      // Restart heartbeat on new connection
      this.heartbeat.start()
    }

    // ── Message received ────────────────────────────────────────────────
    this.ws.onmessage = (ev: MessageEvent) => {
      this.handleMessage(ev)
    }

    // ── Socket closed ───────────────────────────────────────────────────
    this.ws.onclose = (ev: CloseEvent) => {
      // code 1000 = intentional close (user navigated away, or we called disconnect())
      if (ev.code === 1000) {
        this.heartbeat.stop()
        this.setState('DISCONNECTED')
        return
      }

      // Anything else is an unexpected drop — trigger reconnection.
      // In chaos mode, the server kills the socket with no close frame,
      // which shows up as code 1006 (abnormal closure).
      console.warn(`[wsManager] Socket closed unexpectedly (code: ${ev.code})`)
      this.heartbeat.stop()
      const event: StateMachineEvent = { type: 'WS_CLOSE' }
      const next = transition(this.state, event)
      this.setState(next)
      this.scheduleReconnect()
    }

    // ── Socket error ────────────────────────────────────────────────────
    this.ws.onerror = () => {
      // onerror is always followed by onclose in browsers, so we just log.
      // The actual state transition happens in onclose.
      console.warn('[wsManager] WebSocket error event')
    }
  }

  /**
   * Parse an incoming WebSocket message and dispatch it.
   *
   * We do minimal work here — just parse JSON and emit. The message
   * processor (which subscribes via wsManager.on()) does all the
   * interpretation.
   *
   * PING messages are special: they go to the heartbeat manager immediately
   * so we respond within the 3-second window. They're ALSO emitted as
   * regular messages so the timeline can log them.
   */
  private handleMessage(ev: MessageEvent): void {
    let message: ServerMessage

    try {
      const parsed = JSON.parse(ev.data as string)
      message = parsed as ServerMessage
    } catch {
      console.warn('[wsManager] Received non-JSON message:', ev.data)
      return
    }

    // PING gets special treatment — respond immediately via heartbeat manager
    if (message.type === 'PING') {
      this.heartbeat.handlePing(message)
    }

    // Emit to all subscribers (message processor, timeline, etc.)
    this.emit({ type: 'MESSAGE', message })
  }

  /**
   * Send a message directly, bypassing the public send() method.
   *
   * Used by the heartbeat manager to send PONG without triggering
   * state machine events (PONG is not a user action).
   */
  private sendDirect(message: ClientMessage): void {
    if (this.ws === null || this.ws.readyState !== WebSocket.OPEN) {
      return
    }
    this.ws.send(JSON.stringify(message))
  }

  /**
   * Schedule a reconnection attempt with exponential backoff.
   *
   * This sets isReconnecting = true so the next WS_OPEN event will
   * trigger RESUMING instead of CONNECTED. This is the key to making
   * reconnection work — without it, the client would reconnect but
   * never send RESUME, silently losing messages.
   */
  private scheduleReconnect(): void {
    this.clearReconnectTimer()

    if (this.reconnectAttempt >= MAX_RETRIES) {
      this.setState('FAILED')
      return
    }

    this.reconnectAttempt++
    this.isReconnecting = true // The next connection is a reconnection

    // Pick the delay from the backoff array (cap at the last entry)
    const delay = BACKOFF_DELAYS[
      Math.min(this.reconnectAttempt - 1, BACKOFF_DELAYS.length - 1)
    ]

    console.log(`[wsManager] Reconnect attempt ${this.reconnectAttempt} in ${delay}ms`)
    this.emit({ type: 'RECONNECT_ATTEMPT', attempt: this.reconnectAttempt })

    this.reconnectTimer = setTimeout(() => {
      const event: StateMachineEvent = { type: 'CONNECT' }
      const next = transition(this.state, event)
      this.setState(next)
      this.openSocket()
    }, delay)
  }

  /** Clear any pending reconnect timer */
  private clearReconnectTimer(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
  }

  /**
   * Called when the heartbeat manager detects a stale connection.
   *
   * This means we haven't received any PING from the server in a long
   * time. Rather than waiting for the browser's WS close event (which
   * can take up to 60 seconds), we proactively close and reconnect.
   */
  private handleHeartbeatTimeout(): void {
    console.warn('[wsManager] Heartbeat timeout — forcing reconnection')
    if (this.ws !== null) {
      // Use code 4000 (custom) to indicate this was a client-initiated
      // close due to timeout, not a normal close.
      this.ws.close(4000, 'Heartbeat timeout')
    }
  }
}

// ─── Singleton ───────────────────────────────────────────────────────────────

/**
 * Single WebSocket manager instance.
 *
 * Only one connection to the agent server is needed. Components access
 * it via the useWebSocket hook, which subscribes to its events.
 */
export const wsManager = new WebSocketManager()