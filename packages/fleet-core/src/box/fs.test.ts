import assert from 'node:assert/strict'
import { posix } from 'node:path'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { FsTargetKey } from '@deepseek-ai/dsh-fs'
import type { FsTarget } from '@deepseek-ai/dsh-fs'
import { SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session/types'
import type { SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import { FleetBoxFileSystem } from './fs.ts'
import type { Occupant } from './occupancy.ts'
import type { FleetBox } from './world.ts'

interface Request {
  /** The session whose container got the request. */
  owner: string
  method: string
  params: Record<string, unknown>
}

/** The helper's answer to a request; a promise holds the request open. */
type Answer = (method: string, params: Record<string, unknown>) => unknown

/** Answers as a helper whose files are all three-byte text files, and whose streams hold one chunk. */
const helper: Answer = (method, params) => {
  switch (method) {
    case 'fs.resolve': return { targetKey: posix.resolve(String(params.cwd ?? '/'), String(params.path)), displayPath: String(params.path) }
    case 'fs.stat':
    case 'fs.lstat': return { version: 'v1', type: 'file', size: 3 }
    case 'fs.listDir': return [{ name: 'a', type: 'file', target: { targetKey: '/tmp/d/a', displayPath: '/tmp/d/a' } }]
    case 'fs.writeText': return { operation: 'create', version: 'v2', before: null, after: String(params.content) }
    case 'fs.streamOpen': return 7
    case 'fs.streamNext': return { done: false, value: 'abc' }
    case 'fs.streamClose': return null
    default: throw new Error(`unexpected ${method}`)
  }
}

function header(id: string, fields: Partial<SessionHeader> = {}): SessionHeader {
  return { version: SESSION_FORMAT_VERSION, id: id as SessionId, createdAt: 0, isSeeded: false, ...fields }
}

/**
 * The stub world's sessions: s1 and s2 are root sessions, s1-sub a subagent of
 * s1 in a folder of its own, s1-run a subagent of s1 that owns a container,
 * s1-fork a fork of s1, and so a root session of its own, s0 has no folder,
 * and orphan is a subagent whose parent is not recorded.
 */
const headers: Record<string, SessionHeader> = {
  s0: header('s0'),
  s1: header('s1', { cwd: '/w/s1' }),
  's1-sub': header('s1-sub', { cwd: '/w/s1/sub', origin: 'subagent', parentSession: 's1' as SessionId }),
  's1-run': header('s1-run', { cwd: '/w/s1', origin: 'subagent', parentSession: 's1' as SessionId }),
  's1-fork': header('s1-fork', { cwd: '/w/s1', parentSession: 's1' as SessionId }),
  s2: header('s2', { cwd: '/w/s2' }),
  orphan: header('orphan', { cwd: '/w/orphan', origin: 'subagent' }),
}

/** The world's lookups over the stub sessions, walking up subagents that own no container, as the world does. */
const lineage = {
  sessionHeader: (id: SessionId) => Promise.resolve(headers[id]),
  ownerHeaderOf: (id: SessionId) => {
    let current = headers[id]
    while (current?.origin === 'subagent' && current.id !== 's1-run') {
      if (current.parentSession === undefined) return Promise.reject(new Error(`${id} has no parent whose container it could use`))
      current = headers[current.parentSession]
    }
    return current === undefined ? Promise.reject(new Error(`unknown session ${id}`)) : Promise.resolve(current)
  },
} satisfies Pick<FleetBox, 'sessionHeader' | 'ownerHeaderOf'>

/**
 * `ctx.fs` over a stub fleet-box, reached from a plugin's context as dsh's
 * plugins reach it, with a stub `typert` whose configured lookups are kept:
 * requests are recorded, and so are the occupants held now.
 * @param options.agent - the session whose own work every call is, if any.
 */
async function setup(options: { agent?: string; answer?: Answer } = {}) {
  const ctx = new Context()
  const answer = options.answer ?? helper
  const requests: Request[] = []
  const occupants = new Map<symbol, { owner: string; occupant: Occupant }>()
  const lookups = new Map<string, (id: string) => Promise<unknown>>()
  const occupy = (owner: SessionId, occupant: Occupant) => {
    const token = Symbol(occupant.id)
    occupants.set(token, { owner, occupant })
    return () => { occupants.delete(token) }
  }
  ctx.provide('fleetBox', {
    sessionAgent: () => options.agent === undefined ? undefined : { session: { header: { id: options.agent } } },
    ...lineage,
    occupy: occupy satisfies FleetBox['occupy'],
    forOwner: (header: { id: string }) => Promise.resolve({
      connection: {
        request: async (method: string, params: Record<string, unknown>, schema: { parse(value: unknown): unknown }) => {
          requests.push({ owner: header.id, method, params })
          return schema.parse(await answer(method, params))
        },
      },
    }),
  })
  ctx.provide('typert', {
    lookups: {
      configure: (key: string, resolver: (id: string) => Promise<unknown>) => {
        lookups.set(key, resolver)
        return () => { lookups.delete(key) }
      },
    },
  })
  await ctx.plugin(FleetBoxFileSystem)
  let caller: Context | undefined
  await ctx.plugin({ name: 'caller', inject: ['fs'], apply: (inner: Context) => { caller = inner } })
  assert.ok(caller !== undefined)
  const held = () => [...occupants.values()].map(({ owner, occupant }) => ({ owner, kind: occupant.kind }))
  return { fs: caller.fs, requests, held, lookups }
}

function target(owner: string, path: string): FsTarget {
  return { targetKey: FsTargetKey(`fleet-box://${owner}${path}`), displayPath: path }
}

const edit = { oldString: 'a', newString: 'b', replaceAll: false }

test('outside a session\'s work, a plain path or a target of no container is refused, and reaches no container', async () => {
  const { fs, requests, held } = await setup()
  await assert.rejects(fs.resolve('/tmp/out.txt'), { code: 'FS_PERMISSION_DENIED' })
  await assert.rejects(fs.resolve('out.txt', { cwd: '/tmp' }), { code: 'FS_PERMISSION_DENIED' })
  await assert.rejects(fs.lstat('out.txt', { cwd: '/tmp' }), { code: 'FS_PERMISSION_DENIED' })
  await assert.rejects(fs.stat({ targetKey: FsTargetKey('/tmp/out.txt'), displayPath: '/tmp/out.txt' }), { code: 'FS_PERMISSION_DENIED' })
  await assert.rejects(fs.resolve('fleet-box://s1'), { code: 'FS_PERMISSION_DENIED' })
  assert.deepEqual(requests, [])
  assert.deepEqual(held(), [])
})

test('a path, a cwd or a target that names a container is served in it, and its targets name it', async () => {
  const { fs, requests } = await setup()
  const root = await fs.resolve('fleet-box://s1/w/s1')
  assert.deepEqual(root, target('s1', '/w/s1'))
  const relative = await fs.resolve('src/a.ts', { cwd: 'fleet-box://s1/w/s1' })
  assert.deepEqual(relative, { targetKey: 'fleet-box://s1/w/s1/src/a.ts', displayPath: 'src/a.ts' })
  assert.equal(fs.processPath(relative), '/w/s1/src/a.ts')
  assert.equal(fs.fileUrl(relative), 'file:///w/s1/src/a.ts')
  assert.deepEqual(await fs.resolve('/etc/hosts', { cwd: 'fleet-box://s1/w/s1' }), target('s1', '/etc/hosts'))
  assert.deepEqual(await fs.lstat('src/a.ts', { cwd: 'fleet-box://s1/w/s1' }), { version: 'v1', type: 'file', size: 3 })
  assert.deepEqual(await fs.stat(relative), { version: 'v1', type: 'file', size: 3 })
  const [entry] = await fs.listDir(target('s1', '/tmp/d'))
  assert.deepEqual(entry?.target, target('s1', '/tmp/d/a'))
  assert.deepEqual(requests.map(({ owner, method, params }) => [owner, method, params]), [
    ['s1', 'fs.resolve', { path: '/w/s1', cwd: null }],
    ['s1', 'fs.resolve', { path: 'src/a.ts', cwd: '/w/s1' }],
    ['s1', 'fs.resolve', { path: '/etc/hosts', cwd: '/w/s1' }],
    ['s1', 'fs.lstat', { path: 'src/a.ts', cwd: '/w/s1' }],
    ['s1', 'fs.stat', { target: { targetKey: '/w/s1/src/a.ts', displayPath: 'src/a.ts' } }],
    ['s1', 'fs.listDir', { target: { targetKey: '/tmp/d', displayPath: '/tmp/d' } }],
  ])
})

test('outside a session\'s work, a named container is only read', async () => {
  const { fs, requests } = await setup()
  await assert.rejects(fs.writeText(target('s1', '/w/s1/out.txt'), 'hi'), { code: 'FS_PERMISSION_DENIED' })
  await assert.rejects(fs.editText(target('s1', '/w/s1/out.txt'), edit), { code: 'FS_PERMISSION_DENIED' })
  assert.deepEqual(requests, [])
})

test('a session\'s work reads and writes in the container it uses, where its plain paths are', async () => {
  const { fs, requests } = await setup({ agent: 's1-sub' })
  const resolved = await fs.resolve('out.txt', { cwd: '/w/s1/sub' })
  assert.deepEqual(resolved, { targetKey: 'fleet-box://s1/w/s1/sub/out.txt', displayPath: 'out.txt' })
  assert.equal((await fs.writeText(resolved, 'hi')).after, 'hi')
  assert.deepEqual(await fs.resolve('fleet-box://s1/w/s1/a.ts'), target('s1', '/w/s1/a.ts'))
  assert.deepEqual(requests.map(({ owner, method }) => [owner, method]), [['s1', 'fs.resolve'], ['s1', 'fs.writeText'], ['s1', 'fs.resolve']])
})

test('a subagent that owns a container works in its own, at its parent\'s path, which its parent\'s work does not reach', async () => {
  const run = await setup({ agent: 's1-run' })
  assert.deepEqual(await run.fs.resolve('out.txt', { cwd: '/w/s1' }), { targetKey: 'fleet-box://s1-run/w/s1/out.txt', displayPath: 'out.txt' })
  await assert.rejects(run.fs.resolve('fleet-box://s1/w/s1/a.ts'), { code: 'FS_PERMISSION_DENIED' })
  assert.deepEqual(run.requests.map(({ owner, method }) => [owner, method]), [['s1-run', 'fs.resolve']])

  const parent = await setup({ agent: 's1' })
  await assert.rejects(parent.fs.stat(target('s1-run', '/w/s1/a.ts')), { code: 'FS_PERMISSION_DENIED' })
  assert.deepEqual(parent.requests, [])
})

test('a session\'s work is refused another session\'s container', async () => {
  const { fs, requests, held } = await setup({ agent: 's1' })
  await assert.rejects(fs.resolve('fleet-box://s2/w/s2/a.ts'), { code: 'FS_PERMISSION_DENIED' })
  await assert.rejects(fs.resolve('a.ts', { cwd: 'fleet-box://s2/w/s2' }), { code: 'FS_PERMISSION_DENIED' })
  await assert.rejects(fs.lstat('/w/s2/a.ts', { cwd: 'fleet-box://s2/w/s2' }), { code: 'FS_PERMISSION_DENIED' })
  await assert.rejects(fs.stat(target('s2', '/w/s2/a.ts')), { code: 'FS_PERMISSION_DENIED' })
  await assert.rejects(fs.writeText(target('s2', '/w/s2/a.ts'), 'hi'), { code: 'FS_PERMISSION_DENIED' })
  await assert.rejects(fs.editText(target('s2', '/w/s2/a.ts'), edit), { code: 'FS_PERMISSION_DENIED' })
  assert.deepEqual(requests, [])
  assert.deepEqual(held(), [])
})

test('a call naming two containers, one no session id could name, or a session without a container of its own is refused', async () => {
  const { fs, requests, held } = await setup()
  await assert.rejects(fs.resolve('fleet-box://s1/w/s1/a.ts', { cwd: 'fleet-box://s2/w/s2' }), { code: 'FS_PERMISSION_DENIED' })
  for (const path of ['fleet-box:///w/a.ts', 'fleet-box://../w/a.ts', 'fleet-box://-s1/w/a.ts', 'fleet-box://s 1/w/a.ts']) {
    await assert.rejects(fs.resolve(path), { code: 'FS_PERMISSION_DENIED' }, path)
    await assert.rejects(fs.resolve('a.ts', { cwd: path }), { code: 'FS_PERMISSION_DENIED' }, path)
    await assert.rejects(fs.stat({ targetKey: FsTargetKey(path), displayPath: path }), { code: 'FS_PERMISSION_DENIED' }, path)
  }
  await assert.rejects(fs.stat(target('s1-sub', '/w/s1/sub/a.ts')), { code: 'FS_PERMISSION_DENIED' })
  await assert.rejects(fs.stat(target('orphan', '/w/orphan/a.ts')), { code: 'FS_IO_ERROR' })
  assert.deepEqual(requests, [])
  assert.deepEqual(held(), [])
})

test('a fork is a root session with its own container, which its source\'s work does not reach', async () => {
  const viewed = await setup()
  assert.deepEqual(await viewed.fs.stat(target('s1-fork', '/w/s1/a.ts')), { version: 'v1', type: 'file', size: 3 })
  assert.deepEqual(viewed.requests.map(({ owner, method }) => [owner, method]), [['s1-fork', 'fs.stat']])

  const source = await setup({ agent: 's1' })
  await assert.rejects(source.fs.stat(target('s1-fork', '/w/s1/a.ts')), { code: 'FS_PERMISSION_DENIED' })
  assert.deepEqual(source.requests, [])
})

test('a target is inside no target of another container', async () => {
  const { fs } = await setup()
  assert.equal(fs.contains(target('s1', '/tmp'), target('s1', '/tmp/out.txt')), true)
  assert.equal(fs.contains(target('s1', '/tmp'), target('s2', '/tmp/out.txt')), false)
  assert.equal(fs.contains(target('s1', '/tmp'), target('s1', '/tmpx')), false)
})

test('the file viewer\'s scope of a session is its folder in the container it uses, where its calls are served', async () => {
  const { fs, lookups, requests } = await setup()
  const resolve = lookups.get('workspaceFileScope')
  assert.ok(resolve !== undefined)
  assert.deepEqual(await resolve('s1'), { sessionId: 's1', workspaceRoot: 'fleet-box://s1/w/s1' })
  assert.deepEqual(await resolve('s1-fork'), { sessionId: 's1-fork', workspaceRoot: 'fleet-box://s1-fork/w/s1' })
  assert.deepEqual(await resolve('s1-run'), { sessionId: 's1-run', workspaceRoot: 'fleet-box://s1-run/w/s1' })
  assert.deepEqual(await resolve('s0'), undefined)
  assert.deepEqual(await resolve('orphan'), undefined)
  assert.deepEqual(await resolve('s9'), undefined)

  const scope = await resolve('s1-sub')
  assert.deepEqual(scope, { sessionId: 's1-sub', workspaceRoot: 'fleet-box://s1/w/s1/sub' })
  const { workspaceRoot } = scope as { workspaceRoot: string }
  const folder = await fs.resolve(workspaceRoot)
  const file = await fs.resolve('a.ts', { cwd: workspaceRoot })
  assert.equal(fs.contains(folder, file), true)
  assert.equal(fs.processPath(file), '/w/s1/sub/a.ts')
  assert.deepEqual(requests.map(({ owner, method }) => [owner, method]), [['s1', 'fs.resolve'], ['s1', 'fs.resolve']])
})

test('a call occupies its container until it is answered', async () => {
  const answered = Promise.withResolvers<void>()
  const { fs, held } = await setup({
    answer: async (method, params) => {
      await answered.promise
      return helper(method, params)
    },
  })
  const pending = fs.stat(target('s1', '/tmp/out.txt'))
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(held(), [{ owner: 's1', kind: 'file' }])
  answered.resolve()
  await pending
  assert.deepEqual(held(), [])
})

test('a text stream occupies its container until it ends, which the helper closes itself', async () => {
  let chunks = 0
  const { fs, held, requests } = await setup({
    answer: (method, params) => method === 'fs.streamNext' ? { done: chunks++ > 0, value: chunks > 1 ? '' : 'abc' } : helper(method, params),
  })
  const stream = await fs.streamText(target('s1', '/tmp/out.txt'))
  assert.deepEqual(held(), [{ owner: 's1', kind: 'file' }])
  const text: string[] = []
  for await (const chunk of stream) text.push(chunk)
  assert.deepEqual(text, ['abc'])
  assert.deepEqual(held(), [])
  assert.equal(requests.some(({ method }) => method === 'fs.streamClose'), false)
})

test('a text stream closed before it is read, or whose signal aborts, releases its container and closes', async () => {
  const closed = await setup()
  const stream = await closed.fs.streamText(target('s1', '/tmp/out.txt'))
  const iterator = stream[Symbol.asyncIterator]()
  await iterator.return?.()
  assert.deepEqual(closed.held(), [])
  assert.deepEqual(closed.requests.map(({ method }) => method), ['fs.streamOpen', 'fs.streamClose'])
  assert.deepEqual(await iterator.next(), { done: true, value: undefined })

  const aborted = await setup()
  const controller = new AbortController()
  await aborted.fs.streamText(target('s1', '/tmp/out.txt'), controller.signal)
  controller.abort()
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(aborted.held(), [])
  assert.deepEqual(aborted.requests.map(({ method }) => method), ['fs.streamOpen', 'fs.streamClose'])
})
