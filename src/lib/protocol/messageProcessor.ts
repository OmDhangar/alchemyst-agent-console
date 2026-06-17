/**
 * messageProcessor.ts — Core event processing loop
 *
 * This is where raw WebSocket messages become meaningful state changes.
 * The wsManager receives bytes; this module turns them into stream updates,
 * tool call cards, context snapshots, and timeline entries.
 *
 * THE PROCESSING PIPELINE
 * =======================
 *   1. Message arrives from WebSocket (via wsManager event)
 *   2. Push it into the SeqBuffer (sorted by seq number)
 *   3. Try to drain: pop messages from the buffer in strict seq order
 *   4. For each drained message, dispatch to the right handler
 *   5. Handler updates the store (via callbacks) and logs to timeline
 *   6. Advance lastProcessedSeq after each successful processing
 *
 * WHY NOT PROCESS IMMEDIATELY?
 * ============================
 * In normal mode, messages arrive in order and we COULD process immediately.
 * But in chaos mode, they arrive out of order. If we process seq 7 before
 * seq 6, we render the text in the wrong order — "revenue grew" becomes
 * "grew revenue". Bad.
 *
 * The buffer guarantees correct ordering at all times, normal or chaos.
 * The trade-off is a small latency spike when messages arrive out of order —
 * we wait for the missing seq before processing. This is imperceptible
 * (typically <1 second) and far better than rendering garbage.
 *
 * TOOL_CALL INTERRUPTION
 * =======================
 * When TOOL_CALL arrives:
 *   1. Mark the stream as 'tool_call_pending'
 *   2. Add the tool call to the stream's toolCalls array
 *   3. Send TOOL_ACK immediately (the spec says within 2 seconds)
 *   4. Any TOKEN messages for this stream are still accumulated (text grows)
 *      but they're not emitted to the UI until TOOL_RESULT arrives
 *
 * RAPID TOOL CALLS (chaos mode)
 * =============================
 * The server can fire two TOOL_CALLs before any TOOL_RESULT. We handle this
 * by tracking pending tool calls per stream (a count, not a boolean). Each
 * TOOL_RESULT decrements the count. Only when all results are in do we
 * resume the stream.
 *
 * DEDUPLICATION
 * ==============
 * The SeqBuffer handles dedup at the buffer level — if add() returns null,
 * the message is a duplicate and we skip it entirely. This prevents double
 * tokens (rendering "grew grew" instead of "grew") in chaos mode.
 */

// ─── Imports ─────────────────────────────────────────────────────────────────

import type {
  ServerMessage,
  StreamState,
  TimelineEvent,
  CONTEXT_SNAPSHOT,
  TOOL_CALL,
  TOOL_RESULT,
  TOKEN,
  ERROR,
} from '@/lib/streams/types'
import { SeqBuffer } from '@/lib/streams/messageBuffer'

// ─── Types ───────────────────────────────────────────────────────────────────

/**
 * Callbacks that the message processor uses to communicate with the rest
 * of the app. This dependency injection pattern keeps the processor
 * testable — in tests, you can pass mock callbacks.
 */
export type MessageProcessorOptions = {
  /** Called when lastProcessedSeq advances (for RESUME tracking) */
  onSeqAdvance: (seq: number) => void
  /** Called when the Zustand store needs updating */
  onStoreUpdate: (update: StoreUpdate) => void
  /** Called when a new timeline event should be logged */
  onTimelineEvent: (event: TimelineEvent) => void
  /** Called when we need to send TOOL_ACK to the server */
  onSendToolAck: (callId: string) => void
}

/**
 * All the ways the store can be updated from a processed message.
 *
 * These are intentionally granular — each update type maps to a specific
 * change in the UI. The useWebSocket hook maps these to Zustand actions.
 */
export type StoreUpdate =
  | { type: 'TOKEN'; streamId: string; text: string; seq: number }
  | { type: 'TOOL_CALL_START'; streamId: string; toolCall: TOOL_CALL }
  | { type: 'TOOL_RESULT_ARRIVED'; streamId: string; callId: string; result: Record<string, unknown>; seq: number }
  | { type: 'CONTEXT_UPDATE'; contextId: string; data: Record<string, unknown>; seq: number }
  | { type: 'STREAM_END'; streamId: string; seq: number }
  | { type: 'ERROR'; code: string; message: string; seq: number }

// ─── Message Processor ──────────────────────────────────────────────────────

export class MessageProcessor {
  /** Buffer that keeps messages sorted by seq and deduplicates */
  private buffer = new SeqBuffer<ServerMessage>()

  /** Highest seq that we've fully processed (rendered to DOM) */
  private lastProcessedSeq = 0

  /** Per-stream state: tracks text, tool calls, and status for each stream */
  private streamStates = new Map<string, StreamState>()

  /** Maps call_id → stream_id so we can route TOOL_RESULT to the right stream */
  private callIdToStream = new Map<string, string>()

  /**
   * Maps stream_id → number of pending tool calls.
   *
   * Why a counter and not a boolean?
   * Because in chaos mode, two TOOL_CALLs can arrive before any TOOL_RESULT.
   * We need to know how many results we're still waiting for.
   * Only when this count hits 0 do we resume the stream.
   */
  private pendingToolCalls = new Map<string, number>()

  /** Track which context_ids we've seen (for "initial" vs "update" in timeline) */
  private knownContextIds = new Set<string>()

  private readonly opts: MessageProcessorOptions

  constructor(options: MessageProcessorOptions) {
    this.opts = options
  }

  // ── Public API ─────────────────────────────────────────────────────────

  /**
   * Process an incoming server message.
   * This is the main entry point — called once per WebSocket message.
   */
  process(message: ServerMessage): void {
    // Add to the seq-ordered buffer. Returns null if it's a duplicate.
    const added = this.buffer.add(message)
    if (added === null) {
      // Duplicate seq — chaos mode sent this message twice.
      // Skip it entirely. The SeqBuffer already has the first copy.
      return
    }

    // Try to drain consecutive messages from the buffer.
    this.drainBuffer()
  }

  /**
   * Get the highest fully-processed seq.
   * Used when sending RESUME after reconnection.
   */
  getLastProcessedSeq(): number {
    return this.lastProcessedSeq
  }

  /**
   * Set lastProcessedSeq (used when initializing after reconnection).
   */
  setLastProcessedSeq(seq: number): void {
    this.lastProcessedSeq = seq
  }

  /**
   * Reset the sequence buffer, sequence tracking, and stream states for a new turn.
   */
  reset(): void {
    this.buffer = new SeqBuffer<ServerMessage>()
    this.lastProcessedSeq = 0
    this.streamStates.clear()
    this.callIdToStream.clear()
    this.pendingToolCalls.clear()
    this.knownContextIds.clear()
  }

  /**
   * Check if the sequence buffer is empty.
   * Used during reconnection state sync to know when replayed history has been fully processed.
   */
  isBufferEmpty(): boolean {
    return this.buffer.size() === 0
  }

  /**
   * Get all current stream states.
   * Available for debugging and future state persistence.
   */
  getStreamStates(): Map<string, StreamState> {
    return this.streamStates
  }

  // ── Buffer Drain Loop ─────────────────────────────────────────────────

  /**
   * Drain messages from the buffer in strict seq order.
   *
   * Invariant: we only process message with seq N if we've already processed
   * all messages with seq < N. This guarantees tokens render in the right order.
   *
   * When there's a gap (e.g., we have seq 5 and 7 but not 6), we stop and
   * wait. The missing seq will arrive eventually (in chaos mode, it might
   * take a second due to out-of-order delivery), and when it does, we'll
   * drain the entire backlog in one go.
   */
  private drainBuffer(): void {
    let next = this.buffer.peek()

    while (next !== null) {
      if (next.seq <= this.lastProcessedSeq) {
        // This message has already been processed (duplicate from chaos mode)
        // Drain it and discard it so it doesn't block the sequence buffer
        this.buffer.drain(next.seq)
        next = this.buffer.peek()
      } else if (next.seq === this.lastProcessedSeq + 1) {
        // This is the next message in sequence — process it
        this.buffer.drain(next.seq)
        this.processMessage(next)

        // Advance the counter and notify subscribers
        this.lastProcessedSeq = next.seq
        this.opts.onSeqAdvance(this.lastProcessedSeq)

        // Check if there's another message ready
        next = this.buffer.peek()
      } else {
        // Gap detected — seq is too high, we're missing one in between.
        // Stop draining and wait for the missing seq to arrive.
        break
      }
    }
  }

  /**
   * Process a single message that has been drained from the buffer.
   * At this point, we know it's in the correct seq order.
   */
  private processMessage(message: ServerMessage): void {
    switch (message.type) {
      case 'TOKEN':
        this.handleToken(message)
        break
      case 'TOOL_CALL':
        this.handleToolCall(message)
        break
      case 'TOOL_RESULT':
        this.handleToolResult(message)
        break
      case 'CONTEXT_SNAPSHOT':
        this.handleContextSnapshot(message)
        break
      case 'PING':
        // PINGs are handled by HeartbeatManager in wsManager.
        // We just log them to the timeline so they're visible in the trace.
        this.logToTimeline(message, 'PING', `challenge="${message.challenge}"`, null, null)
        break
      case 'STREAM_END':
        this.handleStreamEnd(message)
        break
      case 'ERROR':
        this.handleError(message)
        break
    }
  }

  // ── Message Handlers ──────────────────────────────────────────────────

  /**
   * Handle a TOKEN message — append text to the stream.
   *
   * If the stream is actively streaming, we append and emit immediately.
   * If the stream is paused (waiting for tool result), we still accumulate
   * the text — it'll be there when the stream resumes. We just don't emit
   * to the UI yet so the frozen text stays frozen.
   */
  private handleToken(token: TOKEN): void {
    const stream = this.getOrCreateStream(token.stream_id)

    // Always accumulate the text, regardless of stream status
    stream.text += token.text
    stream.lastProcessedSeq = token.seq

    if (stream.status === 'streaming') {
      // Stream is live — tell the UI to update
      this.opts.onStoreUpdate({
        type: 'TOKEN',
        streamId: token.stream_id,
        text: stream.text,
        seq: token.seq,
      })
    }
    // If stream is 'tool_call_pending', we've accumulated the text silently.
    // When TOOL_RESULT arrives and we resume, the accumulated text will be
    // sent in one shot — so the user sees the text appear right after the
    // tool result card, exactly as expected.
  }

  /**
   * Handle a TOOL_CALL message — pause the stream and show the tool card.
   *
   * This is the most protocol-sensitive handler. We need to:
   *   1. Pause the stream (no more token rendering)
   *   2. Record the tool call
   *   3. Send TOOL_ACK immediately (spec says within 2 seconds)
   *   4. Handle rapid tool calls (second call before first result)
   */
  private handleToolCall(tc: TOOL_CALL): void {
    const stream = this.getOrCreateStream(tc.stream_id)

    // Pause the stream — tokens accumulate but don't render
    stream.status = 'tool_call_pending'

    // Track call_id → stream_id mapping for routing TOOL_RESULT later
    this.callIdToStream.set(tc.call_id, tc.stream_id)

    // Increment the pending tool call counter for this stream.
    // In normal mode this goes 0 → 1. In chaos mode with rapid tool calls,
    // it could go 0 → 1 → 2 (two calls before any result).
    const currentPending = this.pendingToolCalls.get(tc.stream_id) ?? 0
    this.pendingToolCalls.set(tc.stream_id, currentPending + 1)

    // Add the tool call to the stream's list
    stream.toolCalls.push({
      call_id: tc.call_id,
      tool_name: tc.tool_name,
      args: tc.args,
      result: null,       // null = we haven't received the result yet
      resultSeq: null,
    })

    // Send TOOL_ACK immediately — don't wait, don't batch.
    // The server gives us 5 seconds, but there's no reason to wait.
    this.opts.onSendToolAck(tc.call_id)

    // Update the store — the UI will render the tool call card
    this.opts.onStoreUpdate({
      type: 'TOOL_CALL_START',
      streamId: tc.stream_id,
      toolCall: tc,
    })

    // Log to timeline with linkId so bidirectional linking works
    const argsPreview = JSON.stringify(tc.args).slice(0, 80)
    this.logToTimeline(
      tc,
      'TOOL_CALL',
      `${tc.tool_name}(${argsPreview}${argsPreview.length >= 80 ? '…' : ''})`,
      tc.stream_id,
      tc.call_id, // linkId — this connects the timeline row to the chat card
    )
  }

  /**
   * Handle a TOOL_RESULT message — update the tool card and maybe resume.
   *
   * When we get a result:
   *   1. Find the tool call entry and fill in the result
   *   2. Decrement the pending tool call counter
   *   3. If no more pending calls, resume the stream
   *   4. On resume, emit accumulated text so the UI catches up
   */
  private handleToolResult(tr: TOOL_RESULT): void {
    const streamId = this.callIdToStream.get(tr.call_id)
    if (!streamId) {
      console.warn('[processor] TOOL_RESULT for unknown call_id:', tr.call_id)
      return
    }

    const stream = this.streamStates.get(streamId)
    if (!stream) return

    // Find the matching tool call entry and fill in its result
    const entry = stream.toolCalls.find((tc) => tc.call_id === tr.call_id)
    if (entry) {
      entry.result = tr.result
      entry.resultSeq = tr.seq
    }

    // Decrement the pending counter
    const pending = (this.pendingToolCalls.get(streamId) ?? 1) - 1
    this.pendingToolCalls.set(streamId, Math.max(0, pending))

    // Update the store — the UI updates the tool card to show the result
    this.opts.onStoreUpdate({
      type: 'TOOL_RESULT_ARRIVED',
      streamId,
      callId: tr.call_id,
      result: tr.result,
      seq: tr.seq,
    })

    // Only resume the stream if ALL pending tool calls have results.
    // In the common case (one tool call), pending goes from 1 to 0.
    // In the rapid tool call case, we wait for both results.
    if (pending <= 0) {
      stream.status = 'streaming'

      // Emit the accumulated text so the UI catches up.
      // Any tokens that arrived while we were waiting are now rendered.
      this.opts.onStoreUpdate({
        type: 'TOKEN',
        streamId,
        text: stream.text,
        seq: tr.seq,
      })
    }

    // Log to timeline with same linkId as the TOOL_CALL (for visual linking)
    const resultPreview = JSON.stringify(tr.result).slice(0, 80)
    this.logToTimeline(
      tr,
      'TOOL_RESULT',
      resultPreview + (resultPreview.length >= 80 ? '…' : ''),
      streamId,
      tr.call_id, // Same linkId as the matching TOOL_CALL
    )
  }

  /**
   * Handle a CONTEXT_SNAPSHOT — store it for the Context Inspector.
   */
  private handleContextSnapshot(snapshot: CONTEXT_SNAPSHOT): void {
    const isUpdate = this.knownContextIds.has(snapshot.context_id)
    this.knownContextIds.add(snapshot.context_id)

    this.opts.onStoreUpdate({
      type: 'CONTEXT_UPDATE',
      contextId: snapshot.context_id,
      data: snapshot.data,
      seq: snapshot.seq,
    })

    // Log with size info — helpful for debugging 500KB+ chaos mode payloads
    const sizeKB = Math.round(JSON.stringify(snapshot.data).length / 1024)
    const label = isUpdate ? '(update)' : '(initial)'
    this.logToTimeline(
      snapshot,
      'CONTEXT_SNAPSHOT',
      `${snapshot.context_id} ${label} — ${sizeKB}KB`,
      null,
      snapshot.context_id,
    )
  }

  /**
   * Handle STREAM_END — mark the stream as complete.
   */
  private handleStreamEnd(end: { type: 'STREAM_END'; seq: number; stream_id: string }): void {
    const stream = this.streamStates.get(end.stream_id)
    if (stream) {
      stream.status = 'complete'
    }

    // Clean up pending tracking for this stream
    this.pendingToolCalls.delete(end.stream_id)

    this.opts.onStoreUpdate({
      type: 'STREAM_END',
      streamId: end.stream_id,
      seq: end.seq,
    })

    this.logToTimeline(end, 'STREAM_END', `Stream finished`, end.stream_id, null)
  }

  /**
   * Handle ERROR — log it and notify the UI.
   */
  private handleError(error: ERROR): void {
    this.opts.onStoreUpdate({
      type: 'ERROR',
      code: error.code,
      message: error.message,
      seq: error.seq,
    })

    this.logToTimeline(error, 'ERROR', `[${error.code}] ${error.message}`, null, null)
  }

  // ── Helpers ───────────────────────────────────────────────────────────

  /**
   * Get or create a stream state for the given stream_id.
   *
   * A new stream is created when the first TOKEN or TOOL_CALL for that
   * stream_id arrives. This is lazy initialization — we don't need to
   * know about streams ahead of time.
   */
  private getOrCreateStream(streamId: string): StreamState {
    let stream = this.streamStates.get(streamId)
    if (!stream) {
      stream = {
        streamId,
        text: '',
        status: 'streaming',
        toolCalls: [],
        contextId: null,
        lastProcessedSeq: 0,
        startedAt: Date.now(),
      }
      this.streamStates.set(streamId, stream)
    }
    return stream
  }

  /**
   * Log a protocol event to the timeline.
   *
   * The key params are streamId and linkId:
   *   - streamId: which stream this event belongs to (null for connection-level events)
   *   - linkId: a shared ID for linking related events (e.g., call_id links
   *             TOOL_CALL and TOOL_RESULT rows in the timeline)
   *
   * The previous version always passed null for both, which broke
   * bidirectional linking. Now we pass real values.
   */
  private logToTimeline(
    msg: { seq: number },
    type: TimelineEvent['type'],
    summary: string,
    streamId: string | null,
    linkId: string | null,
  ): void {
    this.opts.onTimelineEvent({
      seq: msg.seq,
      type,
      summary,
      detail: JSON.stringify(msg, null, 2),
      streamId,
      linkId,
      receivedAt: Date.now(),
    })
  }
}