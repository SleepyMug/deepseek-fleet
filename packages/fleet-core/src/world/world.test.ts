import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { FsTargetKey } from '@deepseek-ai/dsh-fs'
import type { FileSystem } from '@deepseek-ai/dsh-fs'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { SpillStore } from '@deepseek-ai/dsh-spill'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import type { TauRuns } from '../tau/runs.ts'
import { BoxFileSystem } from './box-fs.ts'
import { BoxSubprocessRuntime } from './box-subprocess.ts'
import { FleetFileSystem } from './fs.ts'
import { FleetSpillStore } from './spill.ts'

const TAU = 'session-00000000-0000-4000-8000-000000000000'
const OTHER = 'session-11111111-1111-4111-8111-111111111111'

/** A temporary folder, removed after the test. */
async function folder(t: { after(fn: () => Promise<void>): void }): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'fleet-world-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return dir
}

/**
 * A context with the runs, whose one tau's session is `TAU`, which no box
 * serves, so that a test sees what is refused before a box is asked; no turn
 * of any agent; and a workspace-write sandbox policy whose workspace is `root`.
 */
function world(root: string): Context {
  const ctx = new Context()
  ctx.provide('fleetTauRuns', {
    isTau: (sessionId: string) => sessionId === TAU,
    hold: () => Promise.reject(new Error('no box here')),
  } as unknown as TauRuns)
  ctx.provide('agents', { currentInitiator: () => undefined, get: () => undefined } as unknown as Context['agents'])
  ctx.provide('sandboxPolicy', {
    defaultMode: 'workspace-write',
    workspaceRoot: root,
    resolve: () => ({ mode: 'workspace-write', workspaceRoot: root }),
  } as unknown as Context['sandboxPolicy'])
  return ctx
}

test('fleet-fs serves what is no box\'s with dsh\'s sandboxed file system, its sandbox mode and its refusals', async (t) => {
  const root = await folder(t)
  const ctx = world(root)
  await ctx.plugin(FleetFileSystem, { dshHome: root })
  const fs = ctx.get('fs') as FileSystem
  assert.equal(fs.sandboxMode, 'workspace-write')
  await fs.writeText(await fs.resolve(join(root, 'in.md')), 'in\n')
  assert.equal(await readFile(join(root, 'in.md'), 'utf8'), 'in\n')
  // Outside every writable root: the workspace and the temporary folders.
  await assert.rejects(fs.writeText(await fs.resolve('/fleet-world-out.md'), 'out\n'), { code: 'FS_SANDBOX_DENIED' })
})

test('a box\'s files are written for its own session alone', async (t) => {
  const ctx = world(await folder(t))
  await ctx.plugin(BoxFileSystem)
  const fs = ctx.get('fs') as FileSystem
  const target = { targetKey: FsTargetKey(`fleet-box://${TAU}/tau/out/report.md`), displayPath: '/tau/out/report.md' }
  await assert.rejects(fs.writeText(target, 'report\n'), { code: 'FS_PERMISSION_DENIED', message: /only that session writes/u })
  await assert.rejects(fs.editText(target, { oldString: 'a', newString: 'b', replaceAll: false }), { code: 'FS_PERMISSION_DENIED' })
})

test('a box\'s file system and subprocess runtime have nothing for a session that is not a tau\'s', async (t) => {
  const ctx = world(await folder(t))
  await ctx.plugin(BoxFileSystem)
  await ctx.plugin(BoxSubprocessRuntime)
  const fs = ctx.get('fs') as FileSystem
  await assert.rejects(fs.resolve('/etc/hostname'), { code: 'FS_NOT_FOUND' })
  assert.equal(fs.sandboxMode, undefined)
  const subprocess = ctx.get('subprocess') as SubprocessRuntime
  assert.throws(() => subprocess.spawn({ argv: ['true'], cwd: '/', graceMs: 0, stdio: { stdin: 'ignore', stdout: { maxBytes: 1024 }, stderr: { maxBytes: 1024 } } }), /runs only the processes of a tau's session/u)
  await assert.rejects(subprocess.resolveExecutable('true'), /runs only the processes of a tau's session/u)
})

test('fleet-spill saves another session\'s spill with dsh\'s local store, and none of a tau\'s session', async (t) => {
  const root = await folder(t)
  const ctx = world(root)
  await ctx.plugin(FleetSpillStore, { root: join(root, 'spill'), cleanupPeriodDays: 0 })
  const store = ctx.get('spillStore') as SpillStore
  const spill = (sessionId: string): ReturnType<SpillStore['saveText']> => store.saveText({
    owner: { sessionId: sessionId as SessionId }, source: { kind: 'tool', toolName: 'bash', callId: 'call' as never, label: 'result' },
    suggestedName: 'bash.txt', content: 'a lot\n',
  })
  await assert.rejects(spill(TAU), /is a tau's session, whose files are its box's/u)
  const saved = await spill(OTHER)
  assert.ok(String(saved.locator).startsWith(join(root, 'spill')))
  assert.equal(await readFile(String(saved.locator), 'utf8'), 'a lot\n')
})
