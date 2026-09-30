import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { after, before, test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { FleetBackends } from '../backends.ts'
import * as archives from './archives.ts'

let dir: string
/** A folder, and a path in it longer than a tar header's name field, so each format keeps it its own way. */
const DEEP = `sub/${'d'.repeat(90)}/`
const LONG = `${DEEP}long-name.txt`

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'fleet-tau-archives-'))
  await mkdir(join(dir, DEEP), { recursive: true })
  await writeFile(join(dir, 'a.txt'), 'a')
  await writeFile(join(dir, LONG), 'long')
})

after(async () => { await rm(dir, { recursive: true, force: true }) })

const tarball = (format: string): Buffer => execFileSync('tar', ['-cf', '-', `--format=${format}`, '-C', dir, '.'])

test('a tarball\'s paths are listed from GNU, pax and ustar headers alike', () => {
  for (const format of ['gnu', 'posix', 'ustar']) {
    assert.deepEqual(archives.tarEntries(tarball(format)).sort(), ['a.txt', 'sub/', DEEP, LONG], format)
  }
  assert.throws(() => archives.tarEntries(gzipSync(tarball('gnu'))), /send an uncompressed tarball/u)
  assert.throws(() => archives.tarEntries(tarball('gnu').subarray(0, 1024)), /ends before its end-of-archive/u)
})

test('the backend takes a tarball as base64, and keeps a receipt per session', async () => {
  const ctx = new Context()
  await ctx.plugin(FleetBackends)
  await ctx.plugin(archives)
  let backends: FleetBackends | undefined
  await ctx.plugin({ name: 'caller', inject: ['fleetBackends'], apply: (inner: Context) => { backends = inner.fleetBackends } })
  assert.ok(backends !== undefined)
  const never = new AbortController().signal
  const session = 'session-a' as SessionId
  const bytes = tarball('gnu')
  const receipt = await backends.call(session, { service: 'archives', function: 'store', args: ['docs', bytes.toString('base64')] }, never)
  assert.deepEqual(receipt, { name: 'docs', bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), entries: archives.tarEntries(bytes) })
  assert.deepEqual(await backends.call(session, { service: 'archives', function: 'list', args: [] }, never), [receipt])
  assert.deepEqual(await backends.call('session-b' as SessionId, { service: 'archives', function: 'list', args: [] }, never), [])
  await assert.rejects(backends.call(session, { service: 'archives', function: 'store', args: ['docs', 'not base64!'] }, never), /archives\.store: its arguments do not fit/u)
})
