/**
 * messageBuffer.ts — Sequenced message buffer with deduplication
 *
 * PURPOSE
 * =======
 * In normal mode, the server sends messages with gapless, monotonically
 * increasing seq numbers. We can process them immediately in order.
 *
 * In chaos mode, the server may send:
 *   - Out-of-order messages (seq values that jump ahead or fall behind)
 *   - Duplicate messages (same seq sent twice)
 *   - Latency spikes (long pauses followed by message bursts)
 *
 * This buffer lets us handle all of that. We store incoming messages and
 * drain them in strict seq order, regardless of arrival order.
 *
 * DATA STRUCTURE
 * ==============
 * We use a sorted array. Why not a Map?
 *
 *   Map<seq, message>: Iterates in insertion order, not seq order.
 *                      To drain in seq order we'd need to sort every time.
 *
 *   Sorted array: Insertion is O(log n) via binary search.
 *                 Drain is O(k) where k = number of messages to drain.
 *                 In-order iteration is free (just traverse the array).
 *
 * At scale (50+ concurrent streams), a heap/priority queue would be better.
 * For this assignment, a sorted array is simpler and fast enough.
 *
 * DEDUPLICATION
 * ==============
 * If a message with seq N arrives twice (chaos mode duplicate), we return
 * null from add() on the second call. The caller knows this means "already
 * have this message" and skips processing.
 *
 * EDGE CASES COVERED
 * ===================
 * ✓ Empty buffer: add() first item → no drain needed
 * ✓ Single item: add() when nothing to drain → buffer grows by 1
 * ✓ Out-of-order: add(5) then add(3) → buffer is [3, 5]
 * ✓ Fully reversed: add(10..1) → buffer is [1..10] after all inserts
 * ✓ Duplicate: add(5) twice → second call returns null
 * ✓ Drain partial: drain(5) when buffer is [1, 2, 7, 8] → drains [1, 2]
 */

export class SeqBuffer<T extends { seq: number }> {
  /**
   * The buffer stores items in ascending seq order.
   * We maintain this invariant via binary search on every insert.
   */
  private buf: T[] = []

  /**
   * Insert a message into the buffer in the correct seq position.
   *
   * @returns The inserted item, or null if it was a duplicate (same seq as an
   *          existing item). The caller should skip duplicate processing.
   */
  add(item: T): T | null {
    // Check for duplicate before inserting
    if (this.hasSeq(item.seq)) {
      return null
    }

    // Binary search for the insertion point.
    // We're looking for the first index where buf[i].seq > item.seq.
    // If item.seq is smaller than buf[0].seq, insert at position 0.
    // If item.seq is larger than buf[last].seq, insert at the end.
    let lo = 0
    let hi = this.buf.length

    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2)
      if (this.buf[mid].seq < item.seq) {
        lo = mid + 1
      } else {
        hi = mid
      }
    }

    this.buf.splice(lo, 0, item)
    return item
  }

  /**
   * Drain all messages with seq <= `untilSeq` from the buffer.
   *
   * Messages are returned in strictly ascending seq order.
   * The buffer is modified in place (drained items are removed).
   *
   * @param untilSeq - drain all messages with seq <= this value
   * @returns An empty array if the next message in the buffer has seq > untilSeq
   */
  drain(untilSeq: number): T[] {
    const drained: T[] = []

    // Keep draining while the front of the buffer is at or below untilSeq
    while (this.buf.length > 0 && this.buf[0].seq <= untilSeq) {
      drained.push(this.buf.shift()!)
    }

    return drained
  }

  /**
   * Peek at the next message in the buffer without removing it.
   * Returns null if the buffer is empty.
   */
  peek(): T | null {
    return this.buf[0] ?? null
  }

  /**
   * How many messages are currently buffered.
   */
  size(): number {
    return this.buf.length
  }

  /**
   * Check if a seq value is already in the buffer (duplicate check).
   * Uses binary search — O(log n) rather than O(n) array scan.
   */
  private hasSeq(seq: number): boolean {
    let lo = 0
    let hi = this.buf.length - 1

    while (lo <= hi) {
      const mid = Math.floor((lo + hi) / 2)
      if (this.buf[mid].seq === seq) return true
      if (this.buf[mid].seq < seq) lo = mid + 1
      else hi = mid - 1
    }

    return false
  }

  /**
   * Get all items currently in the buffer, in seq order.
   * Returns a copy — the buffer is not modified.
   */
  snapshot(): T[] {
    return [...this.buf]
  }
}