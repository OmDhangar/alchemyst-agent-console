# DECISIONS.md — Design Rationale for Agent Console

> This document explains the "why" behind every significant design decision. Each section addresses a specific technical challenge and explains the trade-offs I evaluated before choosing an approach.

---

## 1. Sequence Ordering: Sorted Array with Binary Search

### The Problem
In chaos mode, the server sends messages out of order. Seq 7 might arrive before seq 6. If we render them as-is, token text appears in the wrong order — "revenue grew" becomes "grew revenue".

### Options I Considered

| Approach | Insert | Drain | Memory | Complexity |
|----------|--------|-------|--------|------------|
| **Map<seq, msg>** | O(1) | O(n log n) sort on drain | O(n) | Simple but sorts on every drain |
| **Min-heap (priority queue)** | O(log n) | O(log n) per item | O(n) | Best theoretical, more complex |
| **Sorted array + binary search** | O(log n) find + O(n) splice | O(k) for k items | O(n) | Good enough, simplest to debug |

### What I Chose: Sorted Array

The sorted array wins because:
1. **Simplicity**: It's a single array with a binary search helper. Any developer can understand it in 30 seconds.
2. **Good enough performance**: At our scale (hundreds of messages per stream, not millions), the O(n) splice cost is negligible. Each splice moves at most ~100 elements (< 1µs).
3. **In-order iteration is free**: We just traverse the array. A Map would need sorting; a heap needs repeated extraction.
4. **Debugging is easy**: `buffer.snapshot()` returns a readable array. A heap's internal structure is opaque.

### When This Wouldn't Work
If we had 50+ concurrent streams each producing 1000+ messages per second, the O(n) splice would become a bottleneck. At that scale, I'd switch to a min-heap with O(log n) insertion and extraction. But for this assignment's workload, the sorted array is plenty fast and dramatically simpler.

### Evidence
See `src/lib/streams/__tests__/seqBuffer.test.ts` — the 1000-item random-order test completes in <5ms.

---

## 2. Layout Shift Prevention: Sibling-Based Card Rendering

### The Problem
When a TOOL_CALL arrives mid-stream, we need to show a tool call card inline with the streaming text. If done naively, the card's appearance pushes all text below it downward, causing a visible "jump" that disrupts reading.

### Why This Is Hard
The tool call card appears BETWEEN two chunks of text:

```
The quarterly revenue grew by 15%...
┌──────────────────────────────────┐
│  🔧 calculate_growth({q: "Q3"}) │  ← card appears here
│  ⟳ running                      │
└──────────────────────────────────┘
...and the market cap increased to...    ← this text shifts down
```

### Options I Considered

1. **Absolute positioning**: Card overlays the text. No shift, but covers content.
2. **CSS contain: size**: Reserves exact space. But we don't know the card's height ahead of time.
3. **display:contents on text spans**: The text has no layout box; the card sits between inline elements. Accessible but buggy in some browsers.
4. **Sibling layout with min-height**: Card and text are siblings in a flex column. Card has a `min-height` that reserves space.

### What I Chose: Sibling Layout + min-height

The MessageBubble renders text and tool cards as siblings in a flex column:

```tsx
<div style={{ display: 'flex', flexDirection: 'column' }}>
  <span>{streamingText}</span>           {/* text flows normally */}
  <ToolCallCard minHeight="80px" />     {/* reserves vertical space */}
  {/* more text appears below after TOOL_RESULT */}
</div>
```

Why this works:
- The card always appears BELOW the current text, never in the middle
- `min-height: 80px` ensures the card doesn't "pop in" with zero height
- When the result loads and the card grows, the growth happens downward (the user is looking at the bottom of the chat anyway)
- The streaming text above the card is frozen — it doesn't move at all

### Trade-off
The card is always below the text, not truly inline. If the spec required cards to appear between specific paragraphs, we'd need a more complex approach (splitting the text span into segments). For this assignment, below-text positioning is cleaner and achieves "no flicker, no reflow."

---

## 3. Reconnection: lastProcessedSeq vs lastReceivedSeq

### The Problem
When the WebSocket drops and reconnects, we send `RESUME { last_seq: N }` to tell the server "replay everything after seq N." But which N do we send?

### The Subtle Bug
There are two candidates:
- **lastReceivedSeq**: The highest seq we've received from the WebSocket
- **lastProcessedSeq**: The highest seq we've fully processed (rendered to DOM)

These are NOT the same. Due to the SeqBuffer, we might receive seq 10 but still be waiting to process seq 8 (because seq 7 hasn't arrived yet). If we send `RESUME { last_seq: 10 }`, the server skips seq 7-10. But we never processed 7-10! Gap in the stream. Lost messages.

### What I Chose: lastProcessedSeq

We always send `lastProcessedSeq` — the highest seq that has been fully drained from the buffer and applied to the store. This guarantees:

1. **No lost messages**: Everything between lastProcessedSeq and the drop point gets replayed
2. **Some duplicates are possible**: The server might replay seq values we've already buffered. That's fine — the SeqBuffer's dedup catches them (returns `null` on duplicate `add()`)
3. **Idempotent processing**: Even if a message gets processed twice (due to replay overlap), the result is the same — tokens concatenate identically, tool calls are deduped by `call_id`

### The Alternative's Problem
If we sent `lastReceivedSeq`, and the buffer had unprocessed messages when the connection dropped, those messages would be silently lost. The user would see a gap in the agent's response — missing words, missing tool call cards. Unacceptable.

---

## 4. Scaling to 50 Concurrent Streams

### The Challenge
The current design assumes a handful of concurrent streams. What if there were 50?

### Current Architecture
Each stream has:
- A `StreamState` entry in a Map (in-memory)
- Timeline events logged per-event
- A chat message in the store's `messages` array

### What Would Need to Change

**Per-stream message buffers**: Right now we have ONE global SeqBuffer. With 50 streams interleaving, a single buffer works (seq is global, not per-stream) but the buffer would hold 50× more messages. We'd need to increase the buffer capacity or use per-stream sub-buffers for faster drain operations.

**Web Worker for processing**: The message processor currently runs on the main thread. With 50 streams × 30 tokens/second = 1500 messages/second, the main thread would get congested. Moving the processor to a Web Worker (communicating via `postMessage`) would free the main thread for rendering.

**Virtual message list**: Currently we render all messages. With 50 streams, the chat panel would have 50+ agent bubbles. We'd need to virtualize the message list (same @tanstack/react-virtual we already use for the timeline).

**Subscription throttling**: Zustand's subscriptions fire on every state change. At 1500 changes/second, React would spend all its time reconciling. We'd add `requestAnimationFrame`-based throttling to batch state changes to 60fps.

### What I'd Keep
The state machine, SeqBuffer, and heartbeat manager are all stream-count-agnostic. They scale linearly without architectural changes.

---

## 5. Scaling to 100× Longer Agent Responses

### The Challenge
A 100× longer response means ~3000 tokens per stream (vs ~30 currently). The DOM would have a single text node with ~15KB of text, and the timeline would have ~3000 TOKEN events.

### Token Batching (Already Implemented)
We already batch TOKEN events: every 200ms, accumulated tokens become one timeline entry like "Streamed 47 tokens (1.2s)". For 100× longer responses, this batching becomes essential — instead of 3000 timeline rows, we'd get ~150 (one per 200ms interval). Manageable.

### Chunked Text Rendering
For very long text, React's diffing would become slow (comparing 15KB strings on every token). We'd switch from a single `<span>{text}</span>` to chunked rendering:

```tsx
// Instead of:
<span>{fullText}</span>

// Chunk into segments:
{chunks.map((chunk, i) => (
  <span key={i}>{chunk}</span>
))}
```

Each chunk is a fixed-size segment (~500 chars). When new tokens arrive, only the last chunk gets a new key — React diffs just that one, not the entire text.

### Memory Management
With very long responses, the `text` field in StreamState grows unbounded. For production, we'd implement a sliding window that keeps only the last N characters in memory and offloads earlier text to IndexedDB. The user can scroll up to load historical text on demand.

---

## 6. TOOL_ACK Race Condition Analysis

### The Protocol
When TOOL_CALL arrives:
1. Client renders the tool card
2. Client sends TOOL_ACK to confirm rendering
3. Server waits up to 5 seconds for TOOL_ACK
4. Server sends TOOL_RESULT (either after TOOL_ACK or after 5-second timeout)

### The Race Condition
If TOOL_ACK is delayed (network hiccup, browser tab throttled), the server's 5-second timer fires and it sends TOOL_RESULT anyway. The client might then receive:
- TOOL_RESULT before TOOL_ACK was even sent
- TOOL_RESULT while TOOL_ACK is still in the TCP buffer

### How We Handle This
We send TOOL_ACK **immediately** — right inside the `handleToolCall` method, with zero delay. No batching, no waiting for React to render. This minimizes the window for the race condition.

But even if the race occurs:
- **TOOL_RESULT arriving without TOOL_ACK**: The processor handles TOOL_RESULT regardless of ACK status. It looks up the call_id, finds the tool entry, fills in the result. The ACK is a courtesy, not a gate.
- **TOOL_ACK arriving late**: The server logs it and ignores it. No harm done.
- **Network partition during tool call**: The connection drops, TOOL_ACK is lost, and we reconnect. On RESUME, the server replays the TOOL_RESULT. The processor's dedup (by call_id) prevents double-rendering.

### Decision
We prioritize TOOL_ACK speed over render confirmation. The spec says "send TOOL_ACK within 2 seconds" — we send it within 1ms of receiving the TOOL_CALL. This makes the race condition window nearly zero in practice.

---

## 7. Handling Processed Duplicates: Avoiding the Sequence Buffer Lockup

### The Problem
Under Chaos Mode, the server can send duplicate messages. While our `SeqBuffer` has duplicate check logic, it only checks if a sequence number is already inside the *currently buffered* items.
If a duplicate message arrives *after* the original has already been processed and cleared from the buffer, the buffer has no memory of it. It accepts the message and sorts it. Since its sequence number is old, it sits right at the front of the sorted buffer.
When `drainBuffer()` runs, it checks if `next.seq === lastProcessedSeq + 1`. Because this duplicate message has a sequence number lower than (or equal to) `lastProcessedSeq`, this check fails. The processor naively treated any mismatch as a sequence gap and broke out of the drain loop.
This caused a complete lockup: the old duplicate message got stuck at the head of the buffer forever, freezing all subsequent message processing.

### What I Chose: Processed Duplicates Discarding
To solve this, I added an explicit check in the `drainBuffer()` loop:
```typescript
if (next.seq <= this.lastProcessedSeq) {
  // This message has already been processed. Drain it and throw it away.
  this.buffer.drain(next.seq)
  next = this.buffer.peek()
}
```
If the message's sequence number is less than or equal to `lastProcessedSeq`, we know it's a stale duplicate from Chaos Mode. We pull it out of the buffer, discard it, and peek at the next item. This lets the processor handle incoming messages smoothly without freezing the chat rendering.

