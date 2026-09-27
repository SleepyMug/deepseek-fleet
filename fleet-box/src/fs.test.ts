import assert from 'node:assert/strict'
import { posix } from 'node:path'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { FsTargetKey } from '@deepseek-ai/dsh-fs'
import type { FsTarget } from '@deepseek-ai/dsh-fs'
import { FleetBoxFileSystem } from './fs.ts'
import type { Occupant } from './occupancy.ts'

interface Request {
  /** The root session whose container got the request. */
  root: string
  method: string
  params: Record<string, unknown>
}

/** The helper's answer to a request; a promise holds the request open. */
type Answer = (method: string, params: Record<string, unknown>) => unknown

/** Answers as a helper whose files are all three-byte text files, and whose streams hold one chunk. */
const helper: Answer = (method, params) => {
  switch (method) {
    case 'fs.resolve': return { targetKey: posix.resolve(String(params.cwd ?? '/'), String(params.path)), displayPath: String(params.path) }
    case 'fs.stat': return { version: 'v1', type: 'file', size: 3 }
    case 'fs.listDir': return [{ name: 'a', type: 'file', target: { targetKey: '/tmp/d/a', displayPath: '/tmp/d/a' } }]
    case 'fs.writeText': return { operation: 'create', version: 'v2', before: null, after: String(params.content) }
    case 'fs.streamOpen': return 7
    case 'fs.streamNext': return { done: false, value: 'abc' }
    case 'fs.streamClose': return null
    default: throw new Error(`unexpected ${method}`)
  }
}

/**
 * `ctx.fs` over a stub fleet-box, reached from a plugin's context as dsh's
 * plugins reach it: every session is its own root, named `<session>-root`,
 * requests are recorded, and so are the occupants held now.
 * @param options.agent - the session whose own work every call is, if any.
 * @param options.accessor - whether `ctx.invocation` is defined, as dsh does once a Remote service loads;
 *   without it, a plugin's context throws on reading it.
 */
async function setup(options: { agent?: string; accessor?: boolean; answer?: Answer } = {}) {
  const ctx = new Context()
  if (options.accessor !== false) ctx.accessor('invocation', { get: () => undefined })
  const answer = options.answer ?? helper
  const requests: Request[] = []
  const occupants = new Map<symbol, { root: string; occupant: Occupant }>()
  ctx.provide('fleetBox', {
    sessionAgent: () => options.agent === undefined ? undefined : { session: { header: { id: options.agent } } },
    rootHeaderOf: (id: string) => Promise.resolve({ id: `${id}-root` }),
    occupy: (root: string, occupant: Occupant) => {
      const token = Symbol(occupant.id)
      occupants.set(token, { root, occupant })
      return () => { occupants.delete(token) }
    },
    forRoot: (header: { id: string }) => Promise.resolve({
      connection: {
        request: async (method: string, params: Record<string, unknown>, schema: { parse(value: unknown): unknown }) => {
          requests.push({ root: header.id, method, params })
          return schema.parse(await answer(method, params))
        },
      },
    }),
  })
  await ctx.plugin(FleetBoxFileSystem)
  let caller: Context | undefined
  await ctx.plugin({ name: 'caller', inject: ['fs'], apply: (inner: Context) => { caller = inner } })
  assert.ok(caller !== undefined)
  const plugin = caller
  /** The context of a Remote call, as dsh's Gateway derives it from the receiving plugin's. */
  const call = (service: string, args: Record<string, unknown>) =>
    plugin.extend({ invocation: { service, request: { namespace: service, method: 'read', args } } })
  const viewer = (session: string) => call('workspaceFiles', { workspaceFileScopeId: session })
  const held = () => [...occupants.values()].map(({ root, occupant }) => ({ root, kind: occupant.kind }))
  return { fs: plugin.fs, requests, held, call, viewer }
}

function target(root: string, path: string): FsTarget {
  return { targetKey: FsTargetKey(`fleet-box://${root}${path}`), displayPath: path }
}

test('a call no session makes is refused, and reaches no container', async () => {
  for (const accessor of [true, false]) {
    const { fs, requests, held } = await setup({ accessor })
    await assert.rejects(fs.resolve('/tmp/out.txt'), { code: 'FS_PERMISSION_DENIED' })
    await assert.rejects(fs.stat(target('s1-root', '/tmp/out.txt')), { code: 'FS_PERMISSION_DENIED' })
    assert.deepEqual(requests, [])
    assert.deepEqual(held(), [])
  }
})

test('another Remote service\'s call, or one without the session, is no file-viewer call', async () => {
  const { call, requests } = await setup()
  await assert.rejects(call('session', { workspaceFileScopeId: 's1' }).fs.resolve('/tmp/out.txt'), { code: 'FS_PERMISSION_DENIED' })
  await assert.rejects(call('workspaceFiles', {}).fs.resolve('/tmp/out.txt'), { code: 'FS_PERMISSION_DENIED' })
  assert.deepEqual(requests, [])
})

test('a file-viewer call reads in its session\'s root container, and its targets name that container', async () => {
  const { viewer, requests } = await setup()
  const fs = viewer('s1').fs
  const resolved = await fs.resolve('out.txt', { cwd: '/tmp' })
  assert.deepEqual(resolved, { targetKey: 'fleet-box://s1-root/tmp/out.txt', displayPath: 'out.txt' })
  assert.equal(fs.processPath(resolved), '/tmp/out.txt')
  assert.equal(fs.fileUrl(resolved), 'file:///tmp/out.txt')
  assert.deepEqual(await fs.stat(resolved), { version: 'v1', type: 'file', size: 3 })
  assert.deepEqual(requests.map(({ root, method }) => [root, method]), [['s1-root', 'fs.resolve'], ['s1-root', 'fs.stat']])
  assert.deepEqual(requests[1]?.params, { target: { targetKey: '/tmp/out.txt', displayPath: 'out.txt' } })

  const [entry] = await fs.listDir(target('s1-root', '/tmp/d'))
  assert.deepEqual(entry?.target, target('s1-root', '/tmp/d/a'))
})

test('the file viewer only reads; a session\'s own work writes', async () => {
  const viewed = await setup()
  await assert.rejects(viewed.viewer('s1').fs.writeText(target('s1-root', '/tmp/out.txt'), 'hi'), { code: 'FS_PERMISSION_DENIED' })
  assert.deepEqual(viewed.requests, [])

  const own = await setup({ agent: 's1' })
  const outcome = await own.fs.writeText(target('s1-root', '/tmp/out.txt'), 'hi')
  assert.equal(outcome.after, 'hi')
  assert.deepEqual(own.requests.map(({ root, method }) => [root, method]), [['s1-root', 'fs.writeText']])
})

test('a target of another session\'s container is refused, and is inside no target of this one', async () => {
  const { viewer, requests } = await setup()
  const fs = viewer('s1').fs
  await assert.rejects(fs.stat(target('s2-root', '/tmp/out.txt')), { code: 'FS_PERMISSION_DENIED' })
  await assert.rejects(fs.stat({ targetKey: FsTargetKey('/tmp/out.txt'), displayPath: '/tmp/out.txt' }), { code: 'FS_PERMISSION_DENIED' })
  assert.deepEqual(requests, [])
  assert.equal(fs.contains(target('s1-root', '/tmp'), target('s1-root', '/tmp/out.txt')), true)
  assert.equal(fs.contains(target('s1-root', '/tmp'), target('s2-root', '/tmp/out.txt')), false)
  assert.equal(fs.contains(target('s1-root', '/tmp'), target('s1-root', '/tmpx')), false)
})

test('a call occupies its container until it is answered', async () => {
  const answered = Promise.withResolvers<void>()
  const { viewer, held } = await setup({
    answer: async (method, params) => {
      await answered.promise
      return helper(method, params)
    },
  })
  const pending = viewer('s1').fs.stat(target('s1-root', '/tmp/out.txt'))
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(held(), [{ root: 's1-root', kind: 'file' }])
  answered.resolve()
  await pending
  assert.deepEqual(held(), [])
})

test('a text stream occupies its container until it ends, which the helper closes itself', async () => {
  let chunks = 0
  const { viewer, held, requests } = await setup({
    answer: (method, params) => method === 'fs.streamNext' ? { done: chunks++ > 0, value: chunks > 1 ? '' : 'abc' } : helper(method, params),
  })
  const stream = await viewer('s1').fs.streamText(target('s1-root', '/tmp/out.txt'))
  assert.deepEqual(held(), [{ root: 's1-root', kind: 'file' }])
  const text: string[] = []
  for await (const chunk of stream) text.push(chunk)
  assert.deepEqual(text, ['abc'])
  assert.deepEqual(held(), [])
  assert.equal(requests.some(({ method }) => method === 'fs.streamClose'), false)
})

test('a text stream closed before it is read, or whose signal aborts, releases its container and closes', async () => {
  const closed = await setup()
  const stream = await closed.viewer('s1').fs.streamText(target('s1-root', '/tmp/out.txt'))
  const iterator = stream[Symbol.asyncIterator]()
  await iterator.return?.()
  assert.deepEqual(closed.held(), [])
  assert.deepEqual(closed.requests.map(({ method }) => method), ['fs.streamOpen', 'fs.streamClose'])
  assert.deepEqual(await iterator.next(), { done: true, value: undefined })

  const aborted = await setup()
  const controller = new AbortController()
  await aborted.viewer('s1').fs.streamText(target('s1-root', '/tmp/out.txt'), controller.signal)
  controller.abort()
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(aborted.held(), [])
  assert.deepEqual(aborted.requests.map(({ method }) => method), ['fs.streamOpen', 'fs.streamClose'])
})
