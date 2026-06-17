# Implementation Plan — Agent Console

## Context

Build a Next.js 14 frontend that connects to a provided mock WebSocket backend (`ws://localhost:4747/ws`), handles real-time token streaming with mid-stream tool call interruptions, a live trace timeline, a context diff inspector, bulletproof reconnection, and chaos mode survival.

---

## Architecture Overview

### Layered Architecture

```
┌─────────────────────────────────────────────┐
│  UI Layer (React Components)                │
│  - ChatPanel, TimelinePanel, ContextPanel   │
│  - Virtualized lists, syntax-highlighted    │
│    trees, tool call cards                   │
├─────────────────────────────────────────────┤
│  Stream State Layer (Zustand store)         │
│  - Per-stream state (tokens, tool calls,    │
│    results, context snapshots)              │
│  - Rendered seq tracker                     │
│  - Chat history (rendered messages)         │
├─────────────────────────────────────────────┤
│  Protocol Layer (WebSocket manager)         │
│  - Connection state machine                 │
│  - Seq-ordered message buffer               │
│  - Reconnection + exponential backoff       │
│  - Heartbeat (PING/PONG) management         │
│  - RESUME/TOOL_ACK dispatch                 │
├─────────────────────────────────────────────┤
│  Backend: ws://localhost:4747/ws            │
└─────────────────────────────────────────────┘
```

### Why Zustand (not Redux, not useState)

- WebSocket state needs to be shared across multiple components (chat + timeline + context panel)
- Middleware support for logging/inspection
- No boilerplate — critical for a fast implementation cycle
- `subscribeWithSelector` enables fine-grained subscriptions (only re-render when specific stream_id changes)

---

## Project Structure

```
agent-console/
├── src/
│   ├── app/
│   │   ├── layout.tsx          # Root layout
│   │   ├── page.tsx           # Main console page
│   │   └── globals.css
│   ├── components/
│   │   ├── ConsoleShell.tsx   # 3-panel layout shell
│   │   ├── ChatPanel/
│   │   │   ├── ChatPanel.tsx
│   │   │   ├── MessageBubble.tsx
│   │   │   ├── StreamingText.tsx    # Incremental token renderer
│   │   │   └── ToolCallCard.tsx
│   │   ├── TimelinePanel/
│   │   │   ├── TimelinePanel.tsx
│   │   │   ├── TimelineRow.tsx
│   │   │   └── TokenBatch.tsx       # Batched token display
│   │   ├── ContextPanel/
│   │   │   ├── ContextPanel.tsx
│   │   │   ├── JsonTree.tsx         # Virtualized tree view
│   │   │   └── DiffHighlighter.tsx
│   │   └── ui/
│   │       ├── ReconnectBanner.tsx
│   │       └── FilterBar.tsx
│   ├── lib/
│   │   ├── protocol/
│   │   │   ├── wsManager.ts         # WebSocket connection manager
│   │   │   ├── messageBuffer.ts    # Seq-ordered buffer + dedup
│   │   │   ├── heartbeat.ts       # PING/PONG logic
│   │   │   └── stateMachine.ts     # Connection state machine
│   │   ├── streams/
│   │   │   ├── streamState.ts      # Zustand store: per-stream state
│   │   │   ├── seqTracker.ts       # Tracks highest fully-processed seq
│   │   │   └── types.ts            # All TypeScript message types
│   │   └── utils/
│   │       ├── jsonDiff.ts         # Nested JSON diff engine
│   │       └── formatBytes.ts
│   └── hooks/
│       ├── useWebSocket.ts         # Main WS hook
│       ├── useStreamState.ts       # Zustand store access
│       └── useTimeline.ts
├── package.json
├── tsconfig.json (strict: true)
└── next.config.js
```

---

## State Machine Design

### Connection State Machine

```
DISCONNECTED
    │ connect()
    ▼
CONNECTING ────(open)───► CONNECTED
    │                        │
    │                        │ first USER_MESSAGE → STREAMING
    │                        ▼
    │                   STREAMING
    │                        │
    │                        │ TOOL_CALL arrives → TOOL_CALL_PENDING
    │                        ▼
    │              TOOL_CALL_PENDING ──(TOOL_RESULT)──► STREAMING
    │                        │
    │ (3 missed PONGs or     │
    │  hard close)           │ WS error/close
    │                        ▼
    │                   RECONNECTING
    │                        │
    │ (exponential backoff   │
    │  attempts)              │
    │                        │ open → RESUME → RESUMING
    │                        ▼
    │                   RESUMING ────(all replayed)───► STREAMING
    │                        │
    │ (max retries exceeded) │
    ▼                        ▼
  FAILED             MAX_RETRIES_EXCEEDED
```

### Per-Stream State

```typescript
type StreamState = {
  stream_id: string
  tokens: string              // Accumulated text so far
  status: 'streaming' | 'paused' | 'tool_call_pending' | 'complete'
  toolCalls: ToolCallEntry[]  // Ordered list of tool calls in this stream
  contextId: string | null
  lastSeq: number             // Highest seq processed in this stream
}

type ToolCallEntry = {
  call_id: string
  tool_name: string
  args: object
  result: object | null       // null = pending
  seq: number                 // seq of TOOL_CALL
  resultSeq: number | null    // seq of TOOL_RESULT (null if pending)
}
```

---

## Data Structures

### Message Buffer (Seq-Ordered, Deduplicating)

```typescript
// Sorted buffer: maintains messages in seq order
// On insert: binary search for position, O(log n) insert
// On drain: pop from front in seq order
class SeqBuffer<T extends { seq: number }> {
  private buf: T[] = []

  add(item: T): T | null  // null if duplicate
  drain(untilSeq: number): T[]  // returns items up to and including untilSeq
  peek(): T | null        // next item without removing
  size(): number
}
```

**Why a sorted array (not a Map):**
- In-order traversal for draining is O(1) on a sorted array (just shift)
- Map iteration order in JS is insertion order — but we need seq-order, not arrival-order
- Binary search for insertion is O(log n), acceptable for low-to-moderate message rates
- For 50 concurrent streams (future scale), consider a priority queue — but not needed for this assignment

### Seq Tracker

Tracks the highest **fully processed** (rendered to DOM) seq per stream. Used for:
- Sending `RESUME` on reconnection
- Draining the message buffer in order

```typescript
type SeqTracker = {
  global: number          // highest seq fully processed across all streams
  perStream: Map<string, number>  // highest seq per stream_id
}
```

**Critical distinction:** `socket received seq` ≠ `fully processed seq`. The DOM must confirm render before advancing `lastProcessedSeq`. For reconnection, we use `lastProcessedSeq`, not just "last received."

---

## Task-by-Task Implementation Plan

### Phase 0: Scaffold + Foundation (Day 1)

**0.1** Initialize Next.js 14 App Router project:
```bash
npx create-next-app@latest agent-console --typescript --app --no-tailwind --no-src-dir --eslint --no-turbopack
```
Actually — use `--tailwind` since it speeds up layout work and the assignment allows it. Use `src/` dir for cleaner organization.

**0.2** Install dependencies:
- `zustand` — state management
- `@tanstack/react-virtual` — timeline virtualization (30+ events/sec)
- `fast-json-patch` — JSON diffing (RFC 6902)
- `prism-react-renderer` — syntax highlighting for JSON tree
- `react-resizable-panels` — draggable 3-panel layout

**0.3** Define all TypeScript message types in `lib/streams/types.ts`:
```typescript
// Client → Server
type ClientMessage =
  | { type: 'USER_MESSAGE'; content: string }
  | { type: 'PONG'; echo: string }
  | { type: 'RESUME'; last_seq: number }
  | { type: 'TOOL_ACK'; call_id: string }

// Server → Client
type ServerMessage =
  | { type: 'TOKEN'; seq: number; text: string; stream_id: string }
  | { type: 'TOOL_CALL'; seq: number; call_id: string; tool_name: string; args: object; stream_id: string }
  | { type: 'TOOL_RESULT'; seq: number; call_id: string; result: object; stream_id: string }
  | { type: 'CONTEXT_SNAPSHOT'; seq: number; context_id: string; data: object }
  | { type: 'PING'; seq: number; challenge: string }
  | { type: 'STREAM_END'; seq: number; stream_id: string }
  | { type: 'ERROR'; seq: number; code: string; message: string }
```

**0.4** Build `wsManager.ts` — raw WebSocket lifecycle:
- Connect, disconnect, send
- `onmessage` → parse JSON, dispatch to message buffer
- `onclose` / `onerror` → trigger reconnection state machine
- Export: `connect()`, `disconnect()`, `send(msg)`, `on(event, handler)`, `off(event, handler)`

**0.5** Build `messageBuffer.ts` — SeqBuffer class:
- Add with dedup check
- Drain up to a given seq
- Unit tests: empty buffer, single item, duplicates, fully reversed sequence

---

### Phase 1: Protocol Layer + State Machine (Day 1-2)

**1.1** Build connection state machine (`stateMachine.ts`):
- States: `DISCONNECTED | CONNECTING | CONNECTED | STREAMING | TOOL_CALL_PENDING | RECONNECTING | RESUMING | FAILED`
- Transitions driven by WS events + message arrivals
- Emit state change events for UI

**1.2** Heartbeat manager (`heartbeat.ts`):
- On `PING`: start 3-second timer
- Send `PONG` with echoed challenge
- On timeout: trigger reconnection
- Handle empty/corrupt challenge: log warning, send `PONG` with empty echo, don't crash

**1.3** `messageProcessor.ts` — the core event loop:
```
on raw WS message:
  1. Push to SeqBuffer
  2. Drain buffer from current seq+1 up to consecutive seqs
  3. For each drained message:
     - Dispatch by type:
       - TOKEN → update stream state, advance seq
       - TOOL_CALL → pause stream, add tool call entry, send TOOL_ACK
       - TOOL_RESULT → update tool call entry result, resume stream
       - CONTEXT_SNAPSHOT → update context state
       - PING → heartbeat manager
       - STREAM_END → mark stream complete
       - ERROR → log + display
  4. After each message, update lastProcessedSeq
```

**1.4** Reconnection logic in `wsManager`:
- Exponential backoff: 500ms, 1s, 2s, 4s, capped at 10s
- On reconnect: send `RESUME` as first message before processing any replayed events
- Stitch replayed events into existing state (no jump)

---

### Phase 2: Task 1 — Streaming Chat UI (Day 2)

**2.1** Zustand store (`streamState.ts`):
```typescript
type StreamStore = {
  // Connection
  connectionState: ConnectionState
  reconnectAttempt: number

  // Per-stream state
  streams: Map<string, StreamState>

  // Chat history (for rendering)
  messages: Message[]   // User message + all agent message segments

  // Protocol tracking
  lastProcessedSeq: number

  // Actions
  applyToken: (seq, streamId, text) => void
  pauseStream: (streamId, toolCall) => void
  resumeStream: (streamId, callId, result, resultSeq) => void
  addToolResult: (callId, result, seq) => void
  updateContext: (contextId, data, seq) => void
  markStreamEnd: (streamId, seq) => void
  setConnectionState: (state) => void
  incrementReconnectAttempt: () => void
  resetReconnectAttempt: () => void
}
```

**2.2** `StreamingText.tsx` — incremental token renderer:
- Controlled by a `contentRef` (not state) for the actual text being streamed
- Uses a `span` that appends tokens on each `TOKEN` event — no batching
- On `TOOL_CALL`: freeze — stop appending, don't trigger re-render
- On `TOOL_RESULT`: resume appending to the same span
- Key: `<span key={streamId}>{text}</span>` — React won't re-mount on token updates

**2.3** `ToolCallCard.tsx`:
- Shows: tool name, args (formatted), result (when available)
- States: `pending` (spinner) → `resolved` (shows result)
- Stays visible during reconnection in "waiting" state
- Transition: `pending → resolved` on `TOOL_RESULT` — no unmount/remount, just diff update

**2.4** Layout shift prevention:
- Reserve space for tool call cards before they appear (min-height on a placeholder container)
- OR: insert the card as a sibling below the frozen text, not inside it
- Use `display: contents` on the token span so it doesn't create a layout box
- Absolute positioning or flexbox gap to prevent text reflow when card appears

**2.5** `MessageBubble.tsx`:
- User message (right-aligned)
- Agent message: streaming text span + stacked tool call cards below it
- Multiple sequential tool calls: rendered as a vertical stack

---

### Phase 3: Task 2 — Trace Timeline (Day 2-3)

**3.1** `TimelinePanel.tsx`:
- Virtualized list using `@tanstack/react-virtual`
- Each row: event type badge, seq, timestamp, content preview
- `TOKEN` rows batched: count consecutive TOKENs, show "Streamed N tokens (duration)"
- Click row → call `highlightStreamElement(streamId, elementType, id)`

**3.2** Token batching logic:
```typescript
// In timeline store, group consecutive tokens
function batchTokens(events: TimelineEvent[]): BatchedTokenRow[] {
  // Merge consecutive TOKEN events into one batch row
  // Track: startSeq, endSeq, totalTokens, duration
}
```

**3.3** Tool call/result linking:
- Rows with same `call_id` visually grouped (indented child rows or connecting line)
- Timeline store maintains a `callId → rowIndex` map for bidirectional linking

**3.4** Click-to-highlight:
- `TimelineRow` has `onClick` → sets `highlightedEventId` in a shared ref/store
- `ChatPanel` listens and scrolls to + highlights the relevant element
- `ToolCallCard` has `data-call-id` → timeline calls `scrollToRow(callId)`

**3.5** Filter bar:
- Dropdown: filter by event type (TOKEN, TOOL_CALL, TOOL_RESULT, etc.)
- Text input: search by content
- Both filters are applied client-side on the virtualized list

**3.6** Performance:
- `@tanstack/react-virtual` for windowed rendering — only render visible rows
- Timeline events stored in a flat array, not re-rendered on each token
- New TOKEN events update a token-count accumulator, not the full list
- Batch DOM updates with `requestAnimationFrame`

---

### Phase 4: Task 3 — Context Inspector (Day 3)

**4.1** `ContextPanel.tsx`:
- List of context snapshots (by `context_id`)
- Click to expand → shows tree view for that snapshot
- History scrubber: previous/next buttons to step through snapshot versions

**4.2** JSON diff engine (`jsonDiff.ts`):
```typescript
// Use fast-json-patch (RFC 6902)
// diff(a, b) → PatchOperation[]
// applyPatch(a, operations) → b
function computeContextDiff(oldData: object, newData: object) {
  const patch = compare(oldData, newData)
  return {
    added: patch.filter(op => op.op === 'add').map(op => op.path),
    removed: patch.filter(op => op.op === 'remove').map(op => op.path),
    changed: patch.filter(op => op.op === 'replace').map(op => op.path),
    patch  // full patch for applying
  }
}
```

**4.3** `JsonTree.tsx` — virtualized tree:
- For large objects (500KB+), don't render all nodes at once
- Lazy expansion: only expand nodes on click
- Use `react-window` or similar for very deep trees
- Syntax highlighting: keys (blue), strings (green), numbers (orange), booleans (purple)
- Diff highlighting: added keys (green bg), removed (red strikethrough), changed (yellow bg)

**4.4** History scrubber:
- Store all snapshots for a `context_id` in an array
- Scrubber shows: "Snapshot 1/5" with prev/next buttons
- On navigate: show diff between current and previous snapshot

---

### Phase 5: Task 4 — Reconnection (Day 3)

**5.1** Already partially built in Phase 1 — now wire it up:
- `reconnectAttempt` counter in Zustand store
- UI: `ReconnectBanner.tsx` — non-blocking overlay (not modal), shows attempt count
- Chat panel stays scrollable and interactive

**5.2** RESUME stitching:
- On `RESUME`, server replays from `last_seq + 1`
- Process replayed events through the same message processor
- Key insight: the buffer drains in seq order, so state updates are idempotent for TOKENs (append to existing text)
- Tool calls: check if `call_id` already exists → skip if duplicate
- Result: if tool call card is already rendered (from mid-stream drop), update it

**5.3** Mid-tool-call drop handling:
- Store: tool call is in `toolCalls[]` array with `result: null`
- UI: card shows "waiting..." spinner
- On `TOOL_RESULT` replay: update the entry, card transitions to resolved

---

### Phase 6: Documentation + Chaos Testing (Day 4-5)

**6.1** `DECISIONS.md`:
- Seq ordering: sorted array buffer with binary search, O(log n) insert
- Layout shift: `display: contents` token span, sibling tool card with reserved height
- Reconnection: `lastProcessedSeq` (DOM-confirmed) vs `lastReceivedSeq` (socket-only)
- 50 concurrent streams: would need per-stream message buffer + worker thread for processing
- 100x longer responses: streaming chunks + virtualized message list (only render visible messages)

**6.2** `README.md`:
- Architecture summary (2-3 sentences)
- ASCII state machine diagram
- Run instructions
- Screenshots: (a) streamed response with tool call, (b) trace timeline, (c) context inspector with diff

**6.3** Chaos mode testing + screen recording:
- Run backend in chaos mode
- Test each of the 5 scenarios
- Record 3-5 minutes with labels

---

## Critical Implementation Notes

### The TOOL_ACK Race Condition (from assignment)
The server waits 5 seconds for `TOOL_ACK` before sending `TOOL_RESULT` anyway. This creates a race: if `TOOL_RESULT` arrives before the client's `TOOL_ACK` is processed, the server has already given up waiting. The client must handle `TOOL_RESULT` arriving even if `TOOL_ACK` was never received. **Document this in DECISIONS.md.**

### Seq Tracking: Received vs. Processed
- "Received" = message arrived on WS socket
- "Processed" = message has been applied to state AND rendered to DOM

For RESUME, we send `lastProcessedSeq` — the highest seq the DOM has confirmed rendering. This ensures no messages are lost on reconnection.

### Layout Shift Prevention (Task 1)
The hardest part. Strategy:
1. Token text in a `<span>` with `display: contents` — no layout box
2. Tool call card inserted as a `div` below, not inside, the text span
3. Use a `min-height` container to reserve space before card appears
4. Alternative: CSS `position: absolute` for card, text container has `padding-bottom` reserved

### Timeline Performance
- At 30+ TOKEN events/second, pushing every token to a React state array causes 30 re-renders/sec
- Solution: timeline events go to a mutable ref (not state) for accumulation
- Only sync to state when batching (e.g., every 100ms or on user scroll pause)
- OR: use Zustand with a middleware that batches updates

---

## Verification Plan

1. **Normal mode smoke test**: Connect, send "hello", verify tokens stream incrementally
2. **Tool call test**: Send "report" → verify tool card appears mid-stream, result renders, stream resumes
3. **Multi-tool test**: Send "analyze" → verify two sequential tool calls stack correctly
4. **Reconnection test**: Drop connection mid-stream → verify seamless resume
5. **Seq ordering test**: (chaos) → verify text is correct despite shuffled seqs
6. **Dedup test**: (chaos) → verify duplicate seqs don't cause double tokens
7. **Heartbeat test**: Let PING expire → verify reconnection triggers
8. **Context diff test**: Trigger "schema" keyword → verify 500KB+ context renders without freeze
9. **Unit tests**: SeqBuffer (empty, single, duplicates, reversed), JSON diff (add, remove, change)
10. **Server log verification**: `curl http://localhost:4747/log` — all verdicts should be "ok"

---

## Estimated Timeline

| Day | Focus |
|-----|-------|
| Day 1 | Scaffold + Protocol Layer (wsManager, SeqBuffer, state machine, heartbeat) |
| Day 2 | Streaming Chat UI (Task 1) + Trace Timeline scaffolding |
| Day 3 | Trace Timeline finish (Task 2) + Context Inspector (Task 3) |
| Day 4 | Reconnection polish (Task 4) + Chaos testing |
| Day 5 | Documentation (README, DECISIONS.md) + Screen recording |