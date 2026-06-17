# Agent Console

A real-time WebSocket console for monitoring and interacting with an AI agent. Built with Next.js 14, TypeScript, and Zustand.

## Architecture

The app uses a three-layer architecture where each layer has a single responsibility:

```
┌─────────────────────────────────────────────────────────────────┐
│  UI Layer (React Components)                                    │
│  ChatPanel │ TimelinePanel │ ContextPanel │ ReconnectBanner      │
├─────────────────────────────────────────────────────────────────┤
│  State Layer (Zustand Store)                                    │
│  Messages │ Streams │ Timeline Events │ Snapshots │ Connection  │
├─────────────────────────────────────────────────────────────────┤
│  Protocol Layer                                                 │
│  wsManager │ stateMachine │ messageProcessor │ heartbeat         │
│  (WebSocket lifecycle, seq ordering, PING/PONG, RESUME)         │
└─────────────────────────────────────────────────────────────────┘
```

**Protocol Layer** handles the raw WebSocket connection: opening, closing, reconnecting with exponential backoff, responding to heartbeats, and ordering messages by sequence number.

**State Layer** (Zustand) is the single source of truth for everything the UI renders. Components subscribe to specific slices so only the affected panel re-renders when state changes.

**UI Layer** is three panels: Chat (messages + tool cards), Timeline (virtualized event trace), and Context Inspector (JSON tree with diff).

## State Machine

Every WebSocket event passes through a pure `transition(state, event) → newState` function. No side effects, trivially testable.

```
DISCONNECTED ──(connect)──► CONNECTING ──(WS open)──► CONNECTED
                                                          │
                                                   (send message)
                                                          ▼
                                                     STREAMING ◄────────────┐
                                                          │                 │
                                                   (TOOL_CALL)    (TOOL_RESULT)
                                                          ▼                 │
                                                  TOOL_CALL_PENDING ────────┘
                                                          │
                                                    (WS closes)
                                                          ▼
                                                    RECONNECTING
                                                          │
                                               (reconnect + WS open)
                                                          ▼
                                                      RESUMING ──(replay done)──► STREAMING
                                                          │
                                                   (max retries)
                                                          ▼
                                                       FAILED
```

## Demo & Video Recording

A walk-through of the application handling Chaos Mode connections, out-of-order sequence resolution, duplicate filters, and hot reconnection states.

- 📺 **[Watch the Project Submission Video](./agent-console/Project%20submission.mp4)** (included locally in this repository)

## Running Locally

### Prerequisites
- Node.js 18+
- Docker (for the agent server)

### Start the Agent Server

```bash
# Normal mode
docker run -p 4747:4747 agent-server

# Chaos mode (out-of-order messages, connection drops, corrupt heartbeats)
docker run -p 4747:4747 agent-server --mode chaos
```

### Start the Console

```bash
cd agent-console
npm install
npm run dev
# Open http://localhost:3000
```

### Run Tests

```bash
npm test              # Run all tests once
npm run test:watch    # Watch mode
```

### Build for Production

```bash
npm run build
npm start
```

## Project Structure

```
agent-console/
├── src/
│   ├── app/
│   │   ├── globals.css          # Dark theme, animations, scrollbar
│   │   ├── layout.tsx           # Root layout with metadata
│   │   └── page.tsx             # Entry point — initializes WebSocket
│   ├── components/
│   │   ├── ChatPanel/
│   │   │   ├── ChatPanel.tsx    # Message list + input
│   │   │   ├── MessageBubble.tsx # User/agent message rendering
│   │   │   └── ToolCallCard.tsx # Tool call card with args/result
│   │   ├── TimelinePanel/
│   │   │   └── TimelinePanel.tsx # Virtualized event trace
│   │   ├── ContextPanel/
│   │   │   └── ContextPanel.tsx # JSON tree with diff + scrubber
│   │   ├── ConsoleShell.tsx     # 3-panel layout shell
│   │   └── ui/
│   │       └── ReconnectBanner.tsx # Non-blocking reconnect indicator
│   ├── hooks/
│   │   └── useWebSocket.ts     # Wires wsManager ↔ store ↔ processor
│   └── lib/
│       ├── protocol/
│       │   ├── stateMachine.ts  # Pure state transition function
│       │   ├── wsManager.ts     # WebSocket lifecycle + reconnection
│       │   ├── messageProcessor.ts # Seq-ordered processing pipeline
│       │   └── heartbeat.ts     # PING/PONG heartbeat manager
│       ├── streams/
│       │   ├── types.ts         # All protocol types
│       │   ├── streamState.ts   # Zustand store
│       │   └── messageBuffer.ts # SeqBuffer (sorted array + binary search)
│       └── utils/
│           └── jsonDiff.ts      # RFC 6902 JSON Patch diffing
```

## Key Techniques

| Challenge | Solution |
|-----------|----------|
| Out-of-order messages | SeqBuffer: sorted array with binary search, O(log n) insert |
| 30+ events/sec timeline | @tanstack/react-virtual: only renders visible rows |
| Token batching | Accumulate tokens for 200ms, then flush to one timeline entry |
| Layout shift on tool cards | Sibling rendering + min-height reservation |
| Reconnection transparency | lastProcessedSeq tracking + RESUME protocol |
| Corrupt heartbeats | `challenge ?? ''` — echo whatever we get, even empty |
| 500KB+ context diffs | fast-json-patch (RFC 6902) + lazy tree expansion |
| Duplicate message lockups | Discarding duplicate messages (`seq <= lastProcessedSeq`) in the drain loop |

## Sequence Reset Across Turns

A key protocol detail is that the server resets its sequence counter back to `0` when the user sends a new message (`USER_MESSAGE`). To keep the client in sync and prevent sequence number mismatches across different conversation turns:
- The client completely empties its sequence buffer and resets `lastProcessedSeq` to `0` whenever a new message is submitted.
- This ensures the next incoming message (which will be `seq: 1` from the server) is processed correctly instead of being flagged as a massive gap.


## Design Decisions

See [DECISIONS.md](./agent-console/DECISIONS.md) for detailed rationale on:
1. Why sorted array over heap for sequence ordering
2. How we prevent layout shift on tool call cards
3. Why `lastProcessedSeq` instead of `lastReceivedSeq` for RESUME
4. Scaling strategies for 50 concurrent streams
5. Scaling strategies for 100× longer responses
6. TOOL_ACK race condition analysis
7. Handling duplicate messages that were already processed

