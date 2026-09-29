import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseStat } from './terminals.ts'

test('parseStat reads the fields after the command name', () => {
  assert.deepEqual(parseStat('34 (bash) S 0 34 34 34816 34 4194560 1097 0 0 0 1 0 0 0 20 0 1 0 66381427 5984256 414'),
    { pid: 34, state: 'S', ppid: 0, pgrp: 34, session: 34, tpgid: 34, start: 66381427 })
})

test('parseStat counts from the last parenthesis, since a command name may hold spaces and parentheses', () => {
  assert.deepEqual(parseStat('71 (a b) (c)) R 34 71 34 34816 71 4194304 112 0 0 0 0 0 0 0 20 0 1 0 66381500 5984256 414'),
    { pid: 71, state: 'R', ppid: 34, pgrp: 71, session: 34, tpgid: 71, start: 66381500 })
})

test('parseStat keeps -1 for a process without a controlling terminal', () => {
  assert.deepEqual(parseStat('7 (sleep) S 1 7 1 0 -1 4194560 90 0 0 0 0 0 0 0 20 0 1 0 1200 2461696 200'),
    { pid: 7, state: 'S', ppid: 1, pgrp: 7, session: 1, tpgid: -1, start: 1200 })
})

test('parseStat refuses a line it cannot read', () => {
  assert.equal(parseStat('garbage'), undefined)
  assert.equal(parseStat('12 (x) S'), undefined)
  assert.equal(parseStat('12 (x) S 1 12 1 0 -1 4194560'), undefined)
})
