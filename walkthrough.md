# Walkthrough — Agent Console Build

## Summary

Fixed 8 bugs (3 critical), rewrote 15 files, added 8 new files, and upgraded the UI from a plain white theme to a polished dark mode. The app now compiles cleanly, all 40 unit tests pass, and the production build succeeds.

---

## Changes by Layer

### Protocol Layer (4 files rewritten)

| File | What Changed | Why |
|------|-------------|-----|
| [stateMachine.ts](file:///c:/Users/omdha/.minimax/sessions/mvs_fe645826a6844438a9b1e9d5a9c088bf/workspace/agent-console/src/lib/protocol/stateMachine.ts) | Added `isReconnect` flag to WS_OPEN, TOOL_CALL_RECEIVED in TOOL_CALL_PENDING state, TOKEN_RECEIVED in CONNECTED state, full RESUMING state handlers | RESUME was never triggered; rapid tool calls broke the state machine |
| [wsManager.ts](file:///c:/Users/omdha/.minimax/sessions/mvs_fe645826a6844438a9b1e9d5a9c088bf/workspace/agent-console/src/lib/protocol/wsManager.ts) | Added `isReconnecting` flag, removed dead `lastSentSeq`, improved close/error handling | RESUME flow required knowing if connection is a reconnect |
| [heartbeat.ts](file:///c:/Users/omdha/.minimax/sessions/mvs_fe645826a6844438a9b1e9d5a9c088bf/workspace/agent-console/src/lib/protocol/heartbeat.ts) | Replaced 3-second countdown timer with 15-second stale-connection timer | Old timer caused spurious disconnections |
| [messageProcessor.ts](file:///c:/Users/omdha/.minimax/sessions/mvs_fe645826a6844438a9b1e9d5a9c088bf/workspace/agent-console/src/lib/protocol/messageProcessor.ts) | linkId/streamId now populated, pendingToolCalls counter for rapid calls, added `reset()` method | Bidirectional linking was broken; rapid tool calls weren't handled; resetting sequence state prevents lockups on new turns |

### State Layer (2 files rewritten)

| File | What Changed | Why |
|------|-------------|-----|
| [streamState.ts](file:///c:/Users/omdha/.minimax/sessions/mvs_fe645826a6844438a9b1e9d5a9c088bf/workspace/agent-console/src/lib/streams/streamState.ts) | Added sendMessageFn/setSendMessageFn, auto-advance scrubber, stable EMPTY_SNAPSHOTS selector reference | Replace window.__sendMessage, fix scrubber, prevent Zustand infinite re-render loop |
| [useWebSocket.ts](file:///c:/Users/omdha/.minimax/sessions/mvs_fe645826a6844438a9b1e9d5a9c088bf/workspace/agent-console/src/hooks/useWebSocket.ts) | RESUME sent inline on STATE_CHANGE, sendMessage resets sequence state and tracking on new turn | More reliable RESUME timing, sequence starts fresh on new USER_MESSAGE |

### UI Layer (8 files updated)

| File | What Changed |
|------|-------------|
| [page.tsx](file:///c:/Users/omdha/.minimax/sessions/mvs_fe645826a6844438a9b1e9d5a9c088bf/workspace/agent-console/src/app/page.tsx) | Simplified (removed window hack) |
| [ChatPanel.tsx](file:///c:/Users/omdha/.minimax/sessions/mvs_fe645826a6844438a9b1e9d5a9c088bf/workspace/agent-console/src/components/ChatPanel/ChatPanel.tsx) | Store-based sendMessage, dark theme, color-coded status dot |
| [MessageBubble.tsx](file:///c:/Users/omdha/.minimax/sessions/mvs_fe645826a6844438a9b1e9d5a9c088bf/workspace/agent-console/src/components/ChatPanel/MessageBubble.tsx) | Dark theme, improved auto-scroll |
| [ToolCallCard.tsx](file:///c:/Users/omdha/.minimax/sessions/mvs_fe645826a6844438a9b1e9d5a9c088bf/workspace/agent-console/src/components/ChatPanel/ToolCallCard.tsx) | Dark theme, min-height for layout shift |
| [ConsoleShell.tsx](file:///c:/Users/omdha/.minimax/sessions/mvs_fe645826a6844438a9b1e9d5a9c088bf/workspace/agent-console/src/components/ConsoleShell.tsx) | Dark theme, wider panels |
| [TimelinePanel.tsx](file:///c:/Users/omdha/.minimax/sessions/mvs_fe645826a6844438a9b1e9d5a9c088bf/workspace/agent-console/src/components/TimelinePanel/TimelinePanel.tsx) | Dark theme, more filter options |
| [ContextPanel.tsx](file:///c:/Users/omdha/.minimax/sessions/mvs_fe645826a6844438a9b1e9d5a9c088bf/workspace/agent-console/src/components/ContextPanel/ContextPanel.tsx) | **Bug fix**: scrubber now works. Dark theme, per-key diff highlighting |
| [ReconnectBanner.tsx](file:///c:/Users/omdha/.minimax/sessions/mvs_fe645826a6844438a9b1e9d5a9c088bf/workspace/agent-console/src/components/ui/ReconnectBanner.tsx) | Dark theme, FAILED state |

### Utilities (1 file fixed)

| File | What Changed |
|------|-------------|
| [jsonDiff.ts](file:///c:/Users/omdha/.minimax/sessions/mvs_fe645826a6844438a9b1e9d5a9c088bf/workspace/agent-console/src/lib/utils/jsonDiff.ts) | Fixed TS errors: oldValue lookup via getValueAtPath, applyPatch import alias |

### New Files (8)

| File | Purpose |
|------|---------|
| [seqBuffer.test.ts](file:///c:/Users/omdha/.minimax/sessions/mvs_fe645826a6844438a9b1e9d5a9c088bf/workspace/agent-console/src/lib/streams/__tests__/seqBuffer.test.ts) | 16 unit tests for SeqBuffer |
| [messageProcessor.test.ts](file:///c:/Users/omdha/.minimax/sessions/mvs_fe645826a6844438a9b1e9d5a9c088bf/workspace/agent-console/src/lib/protocol/__tests__/messageProcessor.test.ts) | 5 unit tests for MessageProcessor |
| [jsonDiff.test.ts](file:///c:/Users/omdha/.minimax/sessions/mvs_fe645826a6844438a9b1e9d5a9c088bf/workspace/agent-console/src/lib/utils/__tests__/jsonDiff.test.ts) | 19 unit tests for jsonDiff |
| [vitest.config.mts](file:///c:/Users/omdha/.minimax/sessions/mvs_fe645826a6844438a9b1e9d5a9c088bf/workspace/agent-console/vitest.config.mts) | Vitest config with @/ alias |
| [globals.css](file:///c:/Users/omdha/.minimax/sessions/mvs_fe645826a6844438a9b1e9d5a9c088bf/workspace/agent-console/src/app/globals.css) | Dark theme globals + font imports |
| [README.md](file:///c:/Users/omdha/.minimax/sessions/mvs_fe645826a6844438a9b1e9d5a9c088bf/workspace/agent-console/README.md) | Architecture, state diagram, instructions |
| [DECISIONS.md](file:///c:/Users/omdha/.minimax/sessions/mvs_fe645826a6844438a9b1e9d5a9c088bf/workspace/agent-console/DECISIONS.md) | 6 design rationale sections |

---

## Verification Results

| Check | Result |
|-------|--------|
| `npx tsc --noEmit` | ✅ 0 errors |
| `npm run build` | ✅ Compiled in 3.1s |
| `npm test` | ✅ 40/40 tests pass (281ms) |
