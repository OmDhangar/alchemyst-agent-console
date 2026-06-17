/**
 * seqBuffer.test.ts — Unit tests for the SeqBuffer
 *
 * The SeqBuffer is the heart of our out-of-order message handling.
 * If it has bugs, messages render in the wrong order (gibberish tokens),
 * or duplicates cause double-rendering. These tests cover every edge case
 * we've identified from the chaos mode spec.
 *
 * Test coverage:
 *   ✓ Basic sequential insertion and drain
 *   ✓ Out-of-order arrival (chaos mode)
 *   ✓ Fully reversed sequence
 *   ✓ Duplicate detection and rejection
 *   ✓ Partial drain with gaps
 *   ✓ Peek without mutation
 *   ✓ Empty buffer edge cases
 *   ✓ Large scale (1000+ items)
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { SeqBuffer } from '../messageBuffer'

// Simple test message type
type TestMsg = { seq: number; data: string }

describe('SeqBuffer', () => {
  let buffer: SeqBuffer<TestMsg>

  beforeEach(() => {
    buffer = new SeqBuffer<TestMsg>()
  })

  // ── Basic Operations ──────────────────────────────────────────────────

  it('should start empty', () => {
    expect(buffer.size()).toBe(0)
    expect(buffer.peek()).toBeNull()
  })

  it('should add a single item', () => {
    const result = buffer.add({ seq: 1, data: 'hello' })
    expect(result).not.toBeNull()
    expect(buffer.size()).toBe(1)
    expect(buffer.peek()?.seq).toBe(1)
  })

  it('should maintain seq order on sequential adds', () => {
    buffer.add({ seq: 1, data: 'a' })
    buffer.add({ seq: 2, data: 'b' })
    buffer.add({ seq: 3, data: 'c' })

    expect(buffer.size()).toBe(3)
    expect(buffer.peek()?.seq).toBe(1)
    expect(buffer.snapshot().map(m => m.seq)).toEqual([1, 2, 3])
  })

  // ── Out-of-Order (chaos mode) ──────────────────────────────────────────

  it('should sort out-of-order arrivals', () => {
    // Messages arrive: 3, 1, 2 (chaos mode shuffled delivery)
    buffer.add({ seq: 3, data: 'third' })
    buffer.add({ seq: 1, data: 'first' })
    buffer.add({ seq: 2, data: 'second' })

    const snapshot = buffer.snapshot()
    expect(snapshot.map(m => m.seq)).toEqual([1, 2, 3])
    expect(snapshot.map(m => m.data)).toEqual(['first', 'second', 'third'])
  })

  it('should handle fully reversed sequence', () => {
    // Worst case: messages arrive in reverse order
    for (let i = 10; i >= 1; i--) {
      buffer.add({ seq: i, data: `msg-${i}` })
    }

    const snapshot = buffer.snapshot()
    expect(snapshot.map(m => m.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
  })

  it('should handle interleaved arrivals', () => {
    // Pattern: even numbers first, then odd numbers
    buffer.add({ seq: 2, data: 'b' })
    buffer.add({ seq: 4, data: 'd' })
    buffer.add({ seq: 6, data: 'f' })
    buffer.add({ seq: 1, data: 'a' })
    buffer.add({ seq: 3, data: 'c' })
    buffer.add({ seq: 5, data: 'e' })

    expect(buffer.snapshot().map(m => m.seq)).toEqual([1, 2, 3, 4, 5, 6])
  })

  // ── Deduplication ──────────────────────────────────────────────────────

  it('should reject duplicates (returns null)', () => {
    const first = buffer.add({ seq: 5, data: 'original' })
    const duplicate = buffer.add({ seq: 5, data: 'duplicate' })

    expect(first).not.toBeNull()
    expect(duplicate).toBeNull()
    expect(buffer.size()).toBe(1)
    // Original data should be preserved
    expect(buffer.peek()?.data).toBe('original')
  })

  it('should handle multiple duplicates of same seq', () => {
    buffer.add({ seq: 3, data: 'first' })
    buffer.add({ seq: 3, data: 'second' })
    buffer.add({ seq: 3, data: 'third' })

    expect(buffer.size()).toBe(1)
  })

  // ── Drain ──────────────────────────────────────────────────────────────

  it('should drain messages up to untilSeq', () => {
    buffer.add({ seq: 1, data: 'a' })
    buffer.add({ seq: 2, data: 'b' })
    buffer.add({ seq: 3, data: 'c' })
    buffer.add({ seq: 4, data: 'd' })

    const drained = buffer.drain(2)
    expect(drained.map(m => m.seq)).toEqual([1, 2])
    expect(buffer.size()).toBe(2)
    expect(buffer.peek()?.seq).toBe(3)
  })

  it('should drain nothing when buffer has only higher seqs', () => {
    buffer.add({ seq: 5, data: 'a' })
    buffer.add({ seq: 6, data: 'b' })

    const drained = buffer.drain(3)
    expect(drained).toEqual([])
    expect(buffer.size()).toBe(2)
  })

  it('should drain everything when untilSeq covers all items', () => {
    buffer.add({ seq: 1, data: 'a' })
    buffer.add({ seq: 2, data: 'b' })
    buffer.add({ seq: 3, data: 'c' })

    const drained = buffer.drain(100)
    expect(drained.length).toBe(3)
    expect(buffer.size()).toBe(0)
    expect(buffer.peek()).toBeNull()
  })

  it('should drain from empty buffer without error', () => {
    const drained = buffer.drain(5)
    expect(drained).toEqual([])
  })

  it('should handle partial drain with gaps', () => {
    // Buffer: [1, 2, 7, 8] — gap between 2 and 7
    buffer.add({ seq: 1, data: 'a' })
    buffer.add({ seq: 2, data: 'b' })
    buffer.add({ seq: 7, data: 'g' })
    buffer.add({ seq: 8, data: 'h' })

    // Drain up to 5 — should only get 1 and 2 (3-5 don't exist, 7 is too high)
    const drained = buffer.drain(5)
    expect(drained.map(m => m.seq)).toEqual([1, 2])
    expect(buffer.size()).toBe(2)
    expect(buffer.peek()?.seq).toBe(7)
  })

  // ── Peek ──────────────────────────────────────────────────────────────

  it('should peek without mutating the buffer', () => {
    buffer.add({ seq: 5, data: 'test' })

    const peeked = buffer.peek()
    expect(peeked?.seq).toBe(5)
    expect(buffer.size()).toBe(1) // unchanged
  })

  // ── Snapshot ───────────────────────────────────────────────────────────

  it('should return a copy from snapshot', () => {
    buffer.add({ seq: 1, data: 'a' })
    buffer.add({ seq: 2, data: 'b' })

    const snap = buffer.snapshot()
    snap.push({ seq: 99, data: 'injected' })

    // Original buffer should be unaffected
    expect(buffer.size()).toBe(2)
  })

  // ── Scale ──────────────────────────────────────────────────────────────

  it('should handle 1000 items in random order', () => {
    // Generate shuffled seq numbers 1-1000
    const seqs = Array.from({ length: 1000 }, (_, i) => i + 1)
    for (let i = seqs.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1))
      ;[seqs[i], seqs[j]] = [seqs[j], seqs[i]]
    }

    // Insert in random order
    for (const seq of seqs) {
      buffer.add({ seq, data: `msg-${seq}` })
    }

    // Verify they're stored in correct order
    const snapshot = buffer.snapshot()
    for (let i = 0; i < 1000; i++) {
      expect(snapshot[i].seq).toBe(i + 1)
    }
  })
})
