/**
 * messageProcessor.test.ts — Unit tests for the MessageProcessor
 *
 * This test suite verifies the message processor's ability to:
 *   ✓ Process in-order tokens
 *   ✓ Buffer and reorder out-of-order tokens
 *   ✓ Handle tool call interruptions and trigger immediate TOOL_ACK
 *   ✓ Accumulate tokens during pending tool calls and emit them on result
 *   ✓ Reset sequence state and clear buffer on reset()
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { MessageProcessor, type MessageProcessorOptions, type StoreUpdate } from '../messageProcessor'
import type { TimelineEvent } from '@/lib/streams/types'

describe('MessageProcessor', () => {
  let processor: MessageProcessor
  let mockOpts: MessageProcessorOptions
  let storeUpdates: StoreUpdate[]
  let timelineEvents: TimelineEvent[]
  let toolAcks: string[]
  let seqAdvances: number[]

  beforeEach(() => {
    storeUpdates = []
    timelineEvents = []
    toolAcks = []
    seqAdvances = []

    mockOpts = {
      onSeqAdvance: (seq) => seqAdvances.push(seq),
      onStoreUpdate: (update) => storeUpdates.push(update),
      onTimelineEvent: (event) => timelineEvents.push(event),
      onSendToolAck: (callId) => toolAcks.push(callId),
    }

    processor = new MessageProcessor(mockOpts)
  })

  it('should process consecutive token messages and advance seq', () => {
    processor.process({
      type: 'TOKEN',
      seq: 1,
      text: 'hello',
      stream_id: 's1',
    })

    expect(seqAdvances).toEqual([1])
    expect(storeUpdates).toHaveLength(1)
    expect(storeUpdates[0]).toEqual({
      type: 'TOKEN',
      streamId: 's1',
      text: 'hello',
      seq: 1,
    })
  })

  it('should buffer out-of-order tokens and process them when gap is filled', () => {
    // Message 2 arrives first
    processor.process({
      type: 'TOKEN',
      seq: 2,
      text: 'world',
      stream_id: 's1',
    })

    // Gap detected: lastProcessedSeq was 0, expecting 1. Nothing processed yet.
    expect(seqAdvances).toEqual([])
    expect(storeUpdates).toEqual([])

    // Message 1 arrives
    processor.process({
      type: 'TOKEN',
      seq: 1,
      text: 'hello ',
      stream_id: 's1',
    })

    // Now both should be processed in order
    expect(seqAdvances).toEqual([1, 2])
    expect(storeUpdates).toHaveLength(2)
    expect(storeUpdates[0]).toEqual({
      type: 'TOKEN',
      streamId: 's1',
      text: 'hello ',
      seq: 1,
    })
    expect(storeUpdates[1]).toEqual({
      type: 'TOKEN',
      streamId: 's1',
      text: 'hello world', // accumulated text
      seq: 2,
    })
  })

  it('should handle tool call interruptions and acknowledgments', () => {
    // Stream starts
    processor.process({ type: 'TOKEN', seq: 1, text: 'Thinking...', stream_id: 's1' })

    // Tool call received
    processor.process({
      type: 'TOOL_CALL',
      seq: 2,
      call_id: 'tc1',
      tool_name: 'fetch_data',
      args: { query: 'metrics' },
      stream_id: 's1',
    })

    expect(seqAdvances).toEqual([1, 2])
    // Tool call should trigger immediately sending ACK
    expect(toolAcks).toEqual(['tc1'])
    expect(storeUpdates).toContainEqual({
      type: 'TOOL_CALL_START',
      streamId: 's1',
      toolCall: {
        type: 'TOOL_CALL',
        seq: 2,
        call_id: 'tc1',
        tool_name: 'fetch_data',
        args: { query: 'metrics' },
        stream_id: 's1',
      },
    })
  })

  it('should resume stream and emit accumulated tokens upon tool result', () => {
    processor.process({ type: 'TOKEN', seq: 1, text: 'Wait', stream_id: 's1' })
    processor.process({
      type: 'TOOL_CALL',
      seq: 2,
      call_id: 'tc1',
      tool_name: 'calc',
      args: {},
      stream_id: 's1',
    })

    // While tool call is pending, a token arrives. It should be accumulated but NOT emitted yet.
    const beforeResultCount = storeUpdates.length
    processor.process({ type: 'TOKEN', seq: 3, text: 'ing...', stream_id: 's1' })
    expect(storeUpdates.length).toBe(beforeResultCount) // no new update emitted

    // Tool result arrives
    processor.process({
      type: 'TOOL_RESULT',
      seq: 4,
      call_id: 'tc1',
      result: { ok: true },
      stream_id: 's1',
    })

    expect(seqAdvances).toEqual([1, 2, 3, 4])
    // The store update should emit the tool result and the accumulated token stream
    expect(storeUpdates).toContainEqual({
      type: 'TOOL_RESULT_ARRIVED',
      streamId: 's1',
      callId: 'tc1',
      result: { ok: true },
      seq: 4,
    })
    // Accumulated token is emitted
    expect(storeUpdates).toContainEqual({
      type: 'TOKEN',
      streamId: 's1',
      text: 'Waiting...',
      seq: 4,
    })
  })

  it('should reset sequence tracking and buffer on reset()', () => {
    // Process messages up to seq 2
    processor.process({ type: 'TOKEN', seq: 1, text: 'hello', stream_id: 's1' })
    processor.process({ type: 'TOKEN', seq: 2, text: ' world', stream_id: 's1' })
    expect(processor.getLastProcessedSeq()).toBe(2)

    // Call reset
    processor.reset()
    expect(processor.getLastProcessedSeq()).toBe(0)

    // Now message with seq 1 should be accepted and processed again (new turn simulation)
    processor.process({ type: 'TOKEN', seq: 1, text: 'new start', stream_id: 's2' })
    expect(processor.getLastProcessedSeq()).toBe(1)
    expect(storeUpdates[storeUpdates.length - 1]).toEqual({
      type: 'TOKEN',
      streamId: 's2',
      text: 'new start',
      seq: 1,
    })
  })

  it('should ignore and drain duplicate messages of already processed seq numbers without freezing', () => {
    // Process messages 1 and 2
    processor.process({ type: 'TOKEN', seq: 1, text: 'hello', stream_id: 's1' })
    processor.process({ type: 'TOKEN', seq: 2, text: ' world', stream_id: 's1' })
    expect(processor.getLastProcessedSeq()).toBe(2)
    const storeCountBefore = storeUpdates.length

    // A duplicate of seq 1 arrives (already processed and drained)
    processor.process({ type: 'TOKEN', seq: 1, text: 'hello', stream_id: 's1' })

    // It should be ignored and shouldn't add store updates or advance sequence
    expect(storeUpdates.length).toBe(storeCountBefore)
    expect(processor.getLastProcessedSeq()).toBe(2)

    // A new seq 3 arrives. It should be processed successfully
    processor.process({ type: 'TOKEN', seq: 3, text: '!', stream_id: 's1' })
    expect(processor.getLastProcessedSeq()).toBe(3)
    expect(storeUpdates[storeUpdates.length - 1]).toEqual({
      type: 'TOKEN',
      streamId: 's1',
      text: 'hello world!',
      seq: 3,
    })
  })
})
