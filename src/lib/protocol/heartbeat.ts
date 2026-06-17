/**
 * heartbeat.ts — PING/PONG heartbeat management
 *
 * The server sends PING messages every few seconds. Our job is simple:
 * respond with a PONG that echoes the challenge string. Do it within
 * 3 seconds or the server counts it as a miss. Three misses in a row
 * and the server kills the connection.
 *
 * WHAT WE DO
 * ==========
 * 1. PING arrives → we immediately send PONG with the echoed challenge
 * 2. That's it. The server tracks the 3-strike rule, not us.
 *
 * WHAT WE DON'T DO
 * =================
 * We don't start a timer after sending PONG. The previous version of this
 * code started a 3-second timer that would fire even though we'd already
 * responded — which caused spurious reconnections. The client's only
 * responsibility is to respond quickly. The server decides when to drop us.
 *
 * CHAOS MODE: CORRUPT HEARTBEATS
 * ===============================
 * In chaos mode, the server may send:
 *   - PING with an empty `challenge` string
 *   - PING with an undefined challenge
 *
 * We handle this by using `ping.challenge ?? ''` — we echo whatever we get,
 * even if it's empty. The server just checks that we responded, not what we
 * echoed. We log a warning so it shows up in the trace timeline, but we
 * never throw or crash.
 */

import type { PING, PONG } from '@/lib/streams/types'

// ─── Types ───────────────────────────────────────────────────────────────────

interface HeartbeatOptions {
  /** Called when we need to send a PONG message back to the server */
  onSendPong: (pong: PONG) => void
  /**
   * Called when we haven't received a PING in a suspiciously long time.
   * This suggests the server may be gone. The wsManager uses this to
   * trigger a proactive reconnection rather than waiting for WS close.
   */
  onTimeout: () => void
}

// ─── Constants ───────────────────────────────────────────────────────────────

/**
 * If we don't receive a PING for this many milliseconds, we assume the
 * server is unreachable and proactively reconnect. This is a safety net —
 * normally the server sends PINGs every 5-10 seconds.
 *
 * Set to 15 seconds to give the server plenty of room (3× the typical
 * ping interval). We don't want false positives.
 */
const STALE_CONNECTION_TIMEOUT_MS = 15_000

// ─── Heartbeat Manager ──────────────────────────────────────────────────────

export class HeartbeatManager {
  /**
   * Timer that fires when we haven't received any PING for too long.
   * This is NOT a "did we respond in time" timer — it's a "is the server
   * still alive" timer. Big difference.
   */
  private staleTimer: ReturnType<typeof setTimeout> | null = null

  /** How many PINGs we've successfully responded to (for logging) */
  private pongsSent = 0

  /** Whether the manager is active (set to true when socket connects) */
  private running = false

  private readonly onSendPong: (pong: PONG) => void
  private readonly onTimeout: () => void

  constructor(options: HeartbeatOptions) {
    this.onSendPong = options.onSendPong
    this.onTimeout = options.onTimeout
  }

  /**
   * Start listening for heartbeats.
   * Call this when the WebSocket connects.
   */
  start(): void {
    this.running = true
    this.pongsSent = 0
    this.resetStaleTimer()
  }

  /**
   * Stop the heartbeat manager and clear any timers.
   * Call this when the WebSocket closes or on cleanup.
   */
  stop(): void {
    this.running = false
    this.clearStaleTimer()
  }

  /**
   * Handle an incoming PING from the server.
   *
   * Steps:
   *   1. Reset the stale connection timer (the server is clearly alive)
   *   2. Send a PONG with the challenge echoed back
   *
   * That's it. No countdown timer, no strike tracking. Just respond.
   */
  handlePing(ping: PING): void {
    if (!this.running) return

    // The server is alive — reset the stale connection timer.
    this.resetStaleTimer()

    // Echo the challenge back, even if it's empty (chaos mode).
    // We use ?? instead of || to handle the case where challenge is
    // explicitly set to an empty string (falsy but valid).
    const challenge = ping.challenge ?? ''

    if (challenge === '') {
      console.warn('[heartbeat] Received PING with empty challenge (chaos mode?) — echoing empty string')
    }

    const pong: PONG = {
      type: 'PONG',
      echo: challenge,
    }

    this.onSendPong(pong)
    this.pongsSent++
  }

  /**
   * Reset the "is the server still alive?" timer.
   *
   * Each PING resets this timer. If no PING arrives for 15 seconds,
   * we assume the connection is stale and trigger a reconnection
   * proactively rather than waiting for the browser's WS close event
   * (which can take up to 60 seconds in some environments).
   */
  private resetStaleTimer(): void {
    this.clearStaleTimer()
    this.staleTimer = setTimeout(() => {
      if (this.running) {
        console.warn('[heartbeat] No PING received for 15s — connection may be stale')
        this.onTimeout()
      }
    }, STALE_CONNECTION_TIMEOUT_MS)
  }

  /** Clear the stale connection timer */
  private clearStaleTimer(): void {
    if (this.staleTimer !== null) {
      clearTimeout(this.staleTimer)
      this.staleTimer = null
    }
  }

  /** How many PONGs we've sent this session (useful for debugging) */
  getPongsSent(): number {
    return this.pongsSent
  }
}