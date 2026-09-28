import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { agentEnv } from './agent-env.ts'

async function withAgent(tauJson: string | undefined, check: (dir: string) => void): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'fleet-agent-env-'))
  try {
    if (tauJson !== undefined) await writeFile(join(dir, 'tau.json'), tauJson)
    check(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

test('only the variables tau.json lists, and only those set, are sent', async () => {
  await withAgent('{"env": ["LANG", "TZ", "UNSET"]}', (dir) => {
    assert.deepEqual(agentEnv(dir, { LANG: 'C.UTF-8', TZ: 'UTC', SECRET: 'x' }), { LANG: 'C.UTF-8', TZ: 'UTC' })
  })
})

test('a missing or unreadable tau.json sends nothing and leaves the host to report it', async () => {
  await withAgent(undefined, (dir) => { assert.deepEqual(agentEnv(dir, { LANG: 'C' }), {}) })
  await withAgent('not json', (dir) => { assert.deepEqual(agentEnv(dir, { LANG: 'C' }), {}) })
  await withAgent('{"env": "LANG"}', (dir) => { assert.deepEqual(agentEnv(dir, { LANG: 'C' }), {}) })
  await withAgent('{"env": [1, "toString", "LANG"]}', (dir) => { assert.deepEqual(agentEnv(dir, { LANG: 'C' }), { LANG: 'C' }) })
})
