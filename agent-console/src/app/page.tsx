/**
 * page.tsx — Root page for the Agent Console
 *
 * This is the entry point. It's a client component (marked 'use client')
 * because the entire console is interactive — WebSocket, real-time updates,
 * user input — none of that works with server-side rendering.
 *
 * The structure is simple:
 *   1. Initialize the WebSocket connection via useWebSocket hook
 *   2. Render the ConsoleShell (which contains the 3-panel layout)
 *
 * The sendMessage function is registered in the Zustand store by the hook,
 * so components anywhere in the tree can call it without prop drilling.
 */

'use client'

import { ConsoleShell } from '@/components/ConsoleShell'
import { useWebSocket } from '@/hooks/useWebSocket'

export default function Home() {
  // Initialize the WebSocket connection.
  // This hook sets up the processor, subscribes to events, and registers
  // sendMessage in the Zustand store. It runs for the lifetime of the app.
  useWebSocket()

  return <ConsoleShell />
}