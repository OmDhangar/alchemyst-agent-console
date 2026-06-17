/**
 * jsonDiff.test.ts — Unit tests for the JSON diffing engine
 *
 * The Context Inspector relies on accurate diffs to highlight changes.
 * These tests ensure we correctly identify added, removed, and changed
 * keys — including nested objects, arrays, and edge cases that chaos
 * mode's 500KB+ payloads might produce.
 */

import { describe, it, expect } from 'vitest'
import { computeContextDiff, getValueAtPath, pathToLabel, parentPath } from '../jsonDiff'

describe('computeContextDiff', () => {
  it('should return empty diff when objects are identical', () => {
    const data = { name: 'test', value: 42 }
    const diff = computeContextDiff(data, data)

    expect(diff.added).toEqual([])
    expect(diff.removed).toEqual([])
    expect(diff.changed).toEqual([])
  })

  it('should detect added keys', () => {
    const oldData = { name: 'test' }
    const newData = { name: 'test', score: 95, tags: ['a', 'b'] }
    const diff = computeContextDiff(oldData, newData)

    expect(diff.added).toContain('/score')
    expect(diff.added).toContain('/tags')
    expect(diff.removed).toEqual([])
    expect(diff.changed).toEqual([])
  })

  it('should detect removed keys', () => {
    const oldData = { name: 'test', score: 95, tags: ['a'] }
    const newData = { name: 'test' }
    const diff = computeContextDiff(oldData, newData)

    expect(diff.removed).toContain('/score')
    expect(diff.removed).toContain('/tags')
    expect(diff.added).toEqual([])
    expect(diff.changed).toEqual([])
  })

  it('should detect changed values', () => {
    const oldData = { version: 1, status: 'draft' }
    const newData = { version: 2, status: 'published' }
    const diff = computeContextDiff(oldData, newData)

    expect(diff.changed).toHaveLength(2)
    expect(diff.changed).toContainEqual({
      path: '/version',
      oldValue: 1,
      newValue: 2,
    })
    expect(diff.changed).toContainEqual({
      path: '/status',
      oldValue: 'draft',
      newValue: 'published',
    })
  })

  it('should detect nested changes', () => {
    const oldData = { metrics: { revenue: 100, users: 50 } }
    const newData = { metrics: { revenue: 150, users: 50 } }
    const diff = computeContextDiff(oldData, newData)

    expect(diff.changed).toHaveLength(1)
    expect(diff.changed[0].path).toBe('/metrics/revenue')
    expect(diff.changed[0].oldValue).toBe(100)
    expect(diff.changed[0].newValue).toBe(150)
  })

  it('should handle mixed changes (add + remove + change)', () => {
    const oldData = { a: 1, b: 2, c: 3 }
    const newData = { a: 10, c: 3, d: 4 }
    const diff = computeContextDiff(oldData, newData)

    expect(diff.changed.some(c => c.path === '/a')).toBe(true)
    expect(diff.removed).toContain('/b')
    expect(diff.added).toContain('/d')
  })

  it('should handle array element changes', () => {
    const oldData = { items: ['apple', 'banana', 'cherry'] }
    const newData = { items: ['apple', 'blueberry', 'cherry'] }
    const diff = computeContextDiff(oldData, newData)

    // Array element at index 1 changed
    expect(diff.changed.some(c => c.path === '/items/1')).toBe(true)
  })

  it('should handle empty objects', () => {
    const diff = computeContextDiff({}, {})
    expect(diff.added).toEqual([])
    expect(diff.removed).toEqual([])
    expect(diff.changed).toEqual([])
  })

  it('should handle type changes (number → string)', () => {
    const oldData = { value: 42 }
    const newData = { value: 'forty-two' }
    const diff = computeContextDiff(oldData, newData)

    expect(diff.changed).toHaveLength(1)
    expect(diff.changed[0].oldValue).toBe(42)
    expect(diff.changed[0].newValue).toBe('forty-two')
  })
})

describe('getValueAtPath', () => {
  const obj = { a: { b: { c: 'deep' } }, items: [10, 20, 30] }

  it('should get root level value', () => {
    expect(getValueAtPath({ name: 'test' }, '/name')).toBe('test')
  })

  it('should get nested value', () => {
    expect(getValueAtPath(obj, '/a/b/c')).toBe('deep')
  })

  it('should get array element', () => {
    expect(getValueAtPath(obj, '/items/1')).toBe(20)
  })

  it('should return undefined for missing path', () => {
    expect(getValueAtPath(obj, '/x/y/z')).toBeUndefined()
  })

  it('should return root object for empty/root path', () => {
    expect(getValueAtPath(obj, '/')).toBe(obj)
    expect(getValueAtPath(obj, '')).toBe(obj)
  })
})

describe('pathToLabel', () => {
  it('should return last segment', () => {
    expect(pathToLabel('/metrics/revenue')).toBe('revenue')
  })

  it('should format array indices', () => {
    expect(pathToLabel('/items/0')).toBe('[0]')
  })

  it('should return (root) for empty path', () => {
    expect(pathToLabel('/')).toBe('(root)')
  })
})

describe('parentPath', () => {
  it('should return parent for nested path', () => {
    expect(parentPath('/metrics/revenue')).toBe('/metrics')
  })

  it('should return root for top-level path', () => {
    expect(parentPath('/name')).toBe('/')
  })
})
