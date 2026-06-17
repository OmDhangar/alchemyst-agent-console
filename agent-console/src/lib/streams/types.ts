/**
 * types.ts — All TypeScript types for the WebSocket protocol
 *
 * This file defines every message type that travels over the wire between
 * the client and the agent-server. Keeping them in one place helps to build a
 * clear mental model of the protocol, and serves as a single source of truth
 * for both client and server implementations.
 *
 * There are two sides to every message:
 *   - Client → Server: USER_MESSAGE, PONG, RESUME, TOOL_ACK
 *   - Server → Client: TOKEN, TOOL_CALL, TOOL_RESULT, CONTEXT_SNAPSHOT,
 *                      PING, STREAM_END, ERROR
 *
 * Every server message carries a monotonically increasing `seq` (sequence number).
 * The seq is how we track what we've received, what we've processed, and what
 * we need to recover after a reconnection.
 */

// ─── Connection State ────────────────────────────────────────────────────────

/**
 * The phases of the WebSocket connection lifecycle.
 *
 * We use a state machine rather than a boolean `isConnected` because the
 * client needs to behave differently depending on where it is in the cycle.
 * For example, a TOOL_CALL arriving while RECONNECTING is handled differently
 * than one arriving while STREAMING.
 *
 * State transitions:
 *   DISCONNECTED → CONNECTING        (user sends first message or auto-reconnect)
 *   CONNECTING   → CONNECTED        (WebSocket 'open' event)
 *   CONNECTED    → STREAMING         (first message sent after connect)
 *   STREAMING    → TOOL_CALL_PENDING (server sends TOOL_CALL mid-stream)
 *   TOOL_CALL_PENDING → STREAMING   (TOOL_RESULT arrives, stream resumes)
 *   * → RECONNECTING               (WS close event or 3 missed PONGs)
 *   RECONNECTING → RESUMING         (WS reconnects, RESUME message sent)
 *   RESUMING     → STREAMING        (all replayed events processed)
 *   RECONNECTING → FAILED            (max retries exceeded)
 */
export type ConnectionState =
  | 'DISCONNECTED'
  | 'CONNECTING'
  | 'CONNECTED'
  | 'STREAMING'
  | 'TOOL_CALL_PENDING'
  | 'RECONNECTING'
  | 'RESUMING'
  | 'FAILED'

// ─── Client → Server Messages ─────────────────────────────────────────────────

/** The client sends this to the server when the user types a message. */
export type USER_MESSAGE = {
  type: 'USER_MESSAGE'
  content: string
}

/**
 * The client must respond to every server PING within 3 seconds.
 * The `echo` field must be an exact copy of the `challenge` from the PING.
 * If the challenge is empty (corrupt heartbeat in chaos mode), we still send
 * a PONG — we just echo an empty string.
 */
export type PONG = {
  type: 'PONG'
  echo: string
}

/**
 * Sent immediately on reconnection as the FIRST message on the new socket.
 *
 * `last_seq` tells the server: "I have successfully processed everything up to
 * this seq. Please replay everything after it." This is the key to making
 * reconnection invisible to the user.
 *
 * Important: we send the highest *processed* seq (confirmed rendered to DOM),
 * not the highest *received* seq. This prevents a subtle bug where the DOM
 * hasn't caught up with the socket and we ask for a replay of something we
 * already have but haven't rendered yet.
 */
export type RESUME = {
  type: 'RESUME'
  last_seq: number
}

/**
 * Sent when the client has rendered a tool call card to the UI.
 * This tells the server "I'm ready for the result" — it waits up to 5 seconds
 * before sending TOOL_RESULT regardless.
 *
 * ⚠️ Race condition: the server gives up after 5 seconds. If our TOOL_ACK
 * arrives late (network hiccup), the result may already be on its way. The
 * client must handle TOOL_RESULT arriving even without a prior TOOL_ACK.
 * See DECISIONS.md for full analysis.
 */
export type TOOL_ACK = {
  type: 'TOOL_ACK'
  call_id: string
}

export type ClientMessage = USER_MESSAGE | PONG | RESUME | TOOL_ACK

// ─── Server → Client Messages ─────────────────────────────────────────────────

/**
 * A chunk of the agent's streaming text response.
 * Tokens arrive every 30–80ms in normal mode. The same `stream_id` groups
 * all tokens belonging to one logical response.
 *
 * The client accumulates tokens into a single string and renders them
 * incrementally — no batching, no waiting for the stream to end.
 */
export type TOKEN = {
  type: 'TOKEN'
  seq: number
  text: string
  stream_id: string
}

/**
 * The agent is invoking a tool mid-stream. This PAUSES the token stream —
 * no more TOKEN events will arrive for this `stream_id` until TOOL_RESULT.
 *
 * The client must:
 *   1. Stop appending tokens (freeze the display)
 *   2. Render a tool call card showing tool_name and args
 *   3. Send a TOOL_ACK within 2 seconds
 *
 * `call_id` is the unique identifier used to match this call with its result.
 */
export type TOOL_CALL = {
  type: 'TOOL_CALL'
  seq: number
  call_id: string
  tool_name: string
  args: Record<string, unknown>
  stream_id: string
}

/**
 * The result of a tool invocation. When this arrives, the client:
 *   1. Updates the tool call card to show the result
 *   2. Resumes token streaming from exactly where it paused
 *
 * The same `call_id` links this to its corresponding TOOL_CALL.
 */
export type TOOL_RESULT = {
  type: 'TOOL_RESULT'
  seq: number
  call_id: string
  result: Record<string, unknown>
  stream_id: string
}

/**
 * A snapshot of the data the agent is currently working with.
 * Sent at the start of every response and whenever the context changes.
 *
 * The client shows this in the Context Inspector with a diff from the
 * previous snapshot (same `context_id`). Large payloads (500KB+ in chaos
 * mode) are rendered lazily to avoid freezing the UI.
 */
export type CONTEXT_SNAPSHOT = {
  type: 'CONTEXT_SNAPSHOT'
  seq: number
  context_id: string
  data: Record<string, unknown>
}

/**
 * A heartbeat from the server. The client must respond with a PONG
 * echoing the `challenge` string within 3 seconds.
 *
 * Three missed PONGs → server terminates the connection.
 * In chaos mode, the challenge may be empty (corrupt heartbeat). The client
 * must handle this gracefully: echo an empty string, don't crash.
 */
export type PING = {
  type: 'PING'
  seq: number
  challenge: string
}

/** The server has finished streaming a response for this stream_id. */
export type STREAM_END = {
  type: 'STREAM_END'
  seq: number
  stream_id: string
}

/** A server-side error. May arrive at any point. */
export type ERROR = {
  type: 'ERROR'
  seq: number
  code: string
  message: string
}

export type ServerMessage =
  | TOKEN
  | TOOL_CALL
  | TOOL_RESULT
  | CONTEXT_SNAPSHOT
  | PING
  | STREAM_END
  | ERROR

// ─── Stream State ─────────────────────────────────────────────────────────────

/**
 * The status of a single stream (one agent response).
 *
 * Why this matters: a stream can be in several states, not just "streaming" or "done".
 * When a TOOL_CALL arrives, the stream pauses — tokens are still accumulating
 * in the buffer but we don't render them yet. We need to track this explicitly
 * so we know whether to append new tokens or hold them.
 */
export type StreamStatus = 'streaming' | 'paused' | 'tool_call_pending' | 'complete'

/**
 * One tool call that was made during a stream.
 * We track both the call (TOOL_CALL) and the result (TOOL_RESULT) separately,
 * then stitch them together here. This allows the UI to show "pending" while
 * waiting for the result, then transition smoothly when it arrives.
 */
export type ToolCallEntry = {
  call_id: string
  tool_name: string
  args: Record<string, unknown>
  result: Record<string, unknown> | null  // null = result not yet received
  resultSeq: number | null               // seq of TOOL_RESULT; null if pending
}

/**
 * The full state of one stream (one agent response).
 * There can be multiple streams active simultaneously if the user sends
 * messages before previous streams have ended.
 */
export type StreamState = {
  /** Unique identifier for this stream, from the server's stream_id */
  streamId: string
  /** The accumulated text so far (concatenation of all TOKEN.text values) */
  text: string
  /** Current status of this stream */
  status: StreamStatus
  /** All tool calls made during this stream, in order */
  toolCalls: ToolCallEntry[]
  /** The context_id from the most recent CONTEXT_SNAPSHOT for this stream */
  contextId: string | null
  /** The highest seq that has been fully processed in this stream */
  lastProcessedSeq: number
  /** Timestamp when the stream started (for timeline duration display) */
  startedAt: number
}

// ─── Message History (for Timeline Panel) ───────────────────────────────────

/**
 * A denormalized view of a protocol event, suitable for display in the
 * Timeline Panel. This is not 1:1 with WebSocket messages — TOKEN events
 * are batched into a single TimelineEvent for display purposes.
 */
export type TimelineEventType =
  | 'TOKEN_BATCH'   // Batched group of consecutive TOKEN events
  | 'TOOL_CALL'
  | 'TOOL_RESULT'
  | 'CONTEXT_SNAPSHOT'
  | 'PING'
  | 'PONG'
  | 'STREAM_END'
  | 'ERROR'
  | 'RECONNECT'
  | 'RESUME'

export type TimelineEvent = {
  /** Monotonically increasing sequence number */
  seq: number
  type: TimelineEventType
  /** Human-readable summary for the timeline row */
  summary: string
  /** Full details shown when the row is expanded */
  detail: string
  /** Which stream this event belongs to (null for connection-level events) */
  streamId: string | null
  /** ID for linking related events (e.g., same call_id for TOOL_CALL/RESULT) */
  linkId: string | null
  /** When this event was received (for duration calculations) */
  receivedAt: number
}

// ─── Context Snapshot History (for Context Inspector) ─────────────────────────

/**
 * One entry in the snapshot history for a given context_id.
 * Used by the Context Inspector's scrubber to step through snapshots.
 */
export type SnapshotEntry = {
  contextId: string
  seq: number
  data: Record<string, unknown>
  receivedAt: number
}

// ─── JSON Diff (for Context Inspector) ───────────────────────────────────────

/**
 * The result of diffing two context snapshots.
 * `added` and `removed` are JSON Pointer paths (RFC 6901) to the changed keys.
 * `changed` contains the old and new values for replaced values.
 */
export type ContextDiff = {
  added: string[]     // paths of keys that were added
  removed: string[]   // paths of keys that were removed
  changed: Array<{
    path: string
    oldValue: unknown
    newValue: unknown
  }>
}