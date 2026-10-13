import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import type { DomainChanged } from '@deepseek-ai/dsh-storage-domain'
import { followArchived } from './archive.ts'

/** A write of the workspace registry's state, as dsh makes one. */
function write(value: unknown, change: Partial<DomainChanged> = {}): DomainChanged {
  return { domain: 'workspace', table: '', operation: 'put', value, ...change } as DomainChanged
}

test('the archived sessions are told at once, and again as a write of the workspace registry changes them', () => {
  const ctx = new Context()
  ctx.provide('workspaceRegistry', { archivedSessionIds: ['a'] } as unknown as Context['workspaceRegistry'])
  const told: string[][] = []
  followArchived(ctx, archived => told.push([...archived].sort()))
  assert.deepEqual(told, [['a']])
  ctx.emit('domain/changed', write({ archivedSessionIds: ['b', 'a'] }))
  // The same sessions, written again, or another write, tell nothing.
  ctx.emit('domain/changed', write({ archivedSessionIds: ['a', 'b'] }))
  ctx.emit('domain/changed', write({ archivedSessionIds: ['c'] }, { table: 'sessions' }))
  ctx.emit('domain/changed', write({ archivedSessionIds: ['c'] }, { domain: 'settings' }))
  ctx.emit('domain/changed', write({ archivedSessionIds: ['c'] }, { operation: 'deleted' }))
  ctx.emit('domain/changed', write({ other: true }))
  ctx.emit('domain/changed', write({ archivedSessionIds: [] }))
  assert.deepEqual(told, [['a'], ['a', 'b'], []])
})
