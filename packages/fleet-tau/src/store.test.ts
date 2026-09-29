import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { cp, lstat, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session/types'
import type { SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import type { ContainerAdditions } from 'fleet-box/world'
import { FleetTau, InputError, type Spec } from './store.ts'

let home: string
let agent: string

before(async () => {
  home = await mkdtemp(join(tmpdir(), 'fleet-tau-home-'))
  process.env.DSH_HOME = home
  agent = await mkdtemp(join(tmpdir(), 'fleet-tau-agent-'))
  await writeFile(join(agent, 'PROMPT.md'), 'Greet ${name}.')
  await writeFile(join(agent, 'tau.json'), '{"args": [{"name": "name", "type": "text"}]}')
  await writeFile(join(agent, 'notes.txt'), 'not part of the agent')
  const shared = await mkdtemp(join(tmpdir(), 'fleet-tau-shared-'))
  await mkdir(join(shared, 'shout'))
  await writeFile(join(shared, 'shout', 'SKILL.md'), '---\nname: shout\ndescription: Shout.\n---\nSHOUT\n')
  await mkdir(join(agent, 'skills'))
  // A skill kept elsewhere, as a tau may link one; the snapshot follows the link.
  await symlink(join(shared, 'shout'), join(agent, 'skills', 'shout'))
})

after(async () => {
  await rm(home, { recursive: true, force: true })
  await rm(agent, { recursive: true, force: true })
})

function header(id: string, fields: Partial<SessionHeader> = {}): SessionHeader {
  return { version: SESSION_FORMAT_VERSION, id: id as SessionId, createdAt: 0, isSeeded: false, ...fields }
}

async function setup() {
  const ctx = new Context()
  const configured = new Map<string, ContainerAdditions>()
  const headers: Record<string, SessionHeader> = {
    'session-a': header('session-a', { cwd: '/w' }),
    'session-fork-of-sub': header('session-fork-of-sub', { cwd: '/w', parentSession: 'session-sub' as SessionId }),
    'session-web': header('session-web', { cwd: '/w' }),
  }
  ctx.provide('fleetServices', { list: () => [] })
  ctx.provide('fleetBox', {
    configure: (id: string, additions: ContainerAdditions) => { configured.set(id, additions); return Promise.resolve() },
    unconfigure: (id: string) => { configured.delete(id); return Promise.resolve() },
    turnRunning: () => false,
    rootHeaderOf: (id: string) => {
      let current = headers[id]
      while (current?.origin === 'subagent' && current.parentSession !== undefined) current = headers[current.parentSession]
      return current === undefined ? Promise.reject(new Error(`unknown ${id}`)) : Promise.resolve(current)
    },
  })
  await ctx.plugin(FleetTau)
  let tau: FleetTau | undefined
  await ctx.plugin({ name: 'caller', inject: ['fleetTau'], apply: (inner: Context) => { tau = inner.fleetTau } })
  assert.ok(tau !== undefined)
  return { tau, configured, headers }
}

test('a run is read in a worker, and its spec is stored with a snapshot of the agent before the session exists', async () => {
  const { tau, configured, headers } = await setup()
  const prepared = await tau.prepare({ agent, args: ['World'], bind: true, callerCwd: '/caller', cwd: '/session', env: {} })
  assert.ok(prepared.ok, JSON.stringify(prepared))
  assert.equal(prepared.spec.prompt, 'Greet World.')

  await tau.create('session-a' as SessionId, prepared.spec)
  const folder = join(home, 'fleet', 'sessions', 'session-a')
  assert.equal((await stat(folder)).mode & 0o777, 0o700)
  assert.equal(await readFile(join(folder, 'agent', 'PROMPT.md'), 'utf8'), 'Greet ${name}.')
  assert.ok((await stat(join(folder, 'agent', 'skills', 'shout', 'SKILL.md'))).isFile())
  await assert.rejects(stat(join(folder, 'agent', 'notes.txt')))
  assert.deepEqual(configured.get('session-a'), { mounts: [{ source: join(folder, 'agent'), target: '/opt/fleet/agent', readonly: true }] })

  assert.deepEqual((await tau.specOf(headers['session-a']!))?.spec, prepared.spec)
  assert.equal(await tau.specOf(headers['session-web']!), undefined)
  // A second spec never lands in a session's folder.
  await assert.rejects(tau.create('session-a' as SessionId, prepared.spec))
})

test('a fork, even one of a subagent, takes its source\'s spec and snapshot', async () => {
  const { tau, configured, headers } = await setup()
  const prepared = await tau.prepare({ agent, args: ['Fork'], bind: true, callerCwd: '/caller', cwd: '/session', env: {} })
  assert.ok(prepared.ok)
  await tau.create('session-src' as SessionId, prepared.spec)
  headers['session-src'] = header('session-src', { cwd: '/w' })
  headers['session-fork'] = header('session-fork', { cwd: '/w', parentSession: 'session-src' as SessionId })
  headers['session-sub'] = header('session-sub', { cwd: '/w', origin: 'subagent', parentSession: 'session-src' as SessionId })
  const found = await tau.specOf(headers['session-fork'])
  assert.equal(found?.owner, 'session-src')
  assert.equal((await tau.specOf(headers['session-fork-of-sub']!))?.owner, 'session-src')
  assert.ok(found !== undefined)
  await tau.configureFork('session-fork' as SessionId, found)
  assert.deepEqual(configured.get('session-fork'), configured.get('session-src'))
})

test('a spec is removed with its additions, and a broken one fails to read', async () => {
  const { tau, configured } = await setup()
  const prepared = await tau.prepare({ agent, args: ['X'], bind: true, callerCwd: '/caller', cwd: '/session', env: {} })
  assert.ok(prepared.ok)
  await tau.create('session-gone' as SessionId, prepared.spec)
  await tau.remove('session-gone' as SessionId)
  await assert.rejects(stat(join(home, 'fleet', 'sessions', 'session-gone')))
  assert.equal(configured.has('session-gone'), false)

  await tau.create('session-broken' as SessionId, prepared.spec)
  await writeFile(join(home, 'fleet', 'sessions', 'session-broken', 'spec.json'), '{"version": 99}')
  await assert.rejects(tau.specOf(header('session-broken')), /not valid/u)
  // One an older fleet made says so, and what to do instead.
  await tau.create('session-older' as SessionId, prepared.spec)
  await writeFile(join(home, 'fleet', 'sessions', 'session-older', 'spec.json'), '{"version": 2, "paths": [{"mode": "copy-out"}]}')
  await assert.rejects(tau.specOf(header('session-older')), /made by an older fleet, with a spec of version 2, .*start a new session with `fleet run`$/u)
})

test('a problem in the agent directory comes back from the worker as problems', async () => {
  const { tau } = await setup()
  const prepared = await tau.prepare({ agent, args: [], bind: true, callerCwd: '/caller', cwd: '/session', env: {} })
  assert.ok(!prepared.ok)
  assert.match(prepared.problems.join('\n'), /expected 1 argument/u)
})

test('a run\'s paths reach its container, and its outputs are published once per completed turn', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fleet-tau-paths-'))
  try {
    const ctx = new Context()
    const configured = new Map<string, ContainerAdditions>()
    const container = join(dir, 'container')
    const copied: string[] = []
    let running = false
    ctx.provide('fleetServices', { list: () => [] })
    ctx.provide('fleetBox', {
      configure: (id: string, additions: ContainerAdditions) => { configured.set(id, additions); return Promise.resolve() },
      unconfigure: () => Promise.resolve(),
      turnRunning: () => running,
      rootHeaderOf: (id: string) => Promise.resolve(header(id, { cwd: '/w', ...id === 'session-p-fork' ? { parentSession: 'session-p' as SessionId } : {} })),
      // The container's files are under `container`, at their view paths; fleet-box refuses a symlink as it copies.
      copyOut: async (_root: string, view: string, target: string) => {
        copied.push(view)
        const source = join(container, view)
        if ((await lstat(source).catch(() => undefined))?.isSymbolicLink() === true) throw new Error(`${view} is a symlink, which is not copied out`)
        // Slow enough for a second publish to start meanwhile.
        await new Promise((resolve) => { setTimeout(resolve, 20) })
        await cp(source, target, { recursive: true }).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error })
        return true
      },
    })
    await ctx.plugin(FleetTau)
    let tau: FleetTau | undefined
    await ctx.plugin({ name: 'caller', inject: ['fleetTau'], apply: (inner: Context) => { tau = inner.fleetTau } })
    assert.ok(tau !== undefined)

    await writeFile(join(dir, 'rules.md'), 'be kind')
    await mkdir(join(dir, 'data'))
    const report = join(dir, 'out', 'report.md')
    await mkdir(join(dir, 'out'))
    await writeFile(report, 'old report')
    const summary = join(dir, 'summary.md')
    const spec: Spec = {
      version: 3, args: [], prompt: 'x', skills: [], services: {}, modules: [], ts: false, env: { LANG: 'C.UTF-8' },
      paths: [
        { name: 'rules', type: 'file', role: 'in', host: join(dir, 'rules.md') },
        { name: 'data', type: 'dir', role: 'inout', host: join(dir, 'data') },
        { name: 'report', type: 'file', role: 'out', host: report },
        { name: 'summary', type: 'file', role: 'out', host: summary },
      ],
    }
    await tau.create('session-p' as SessionId, spec)
    const folder = join(home, 'fleet', 'sessions', 'session-p')
    const agentMount = { source: join(folder, 'agent'), target: '/opt/fleet/agent', readonly: true }
    // An in path is its snapshot, which the agent cannot change.
    const rulesMount = { source: join(folder, 'in', 'rules'), target: join(dir, 'rules.md'), readonly: true }
    assert.deepEqual(configured.get('session-p'), {
      mounts: [agentMount, rulesMount, { source: join(dir, 'data'), target: join(dir, 'data'), readonly: false }],
      env: { LANG: 'C.UTF-8' },
      directories: [join(dir, 'out'), dir],
    })
    await writeFile(join(dir, 'rules.md'), 'changed later')
    assert.equal(await readFile(join(folder, 'in', 'rules'), 'utf8'), 'be kind')

    // The agent left nothing: the check says so, and the caller's file stays.
    const nothing = await tau.publish('session-p' as SessionId, 3)
    assert.deepEqual(nothing, [`report: the agent left nothing at ${report}`, `summary: the agent left nothing at ${summary}`])
    assert.equal(await readFile(report, 'utf8'), 'old report')

    // A turn running now keeps the outputs where they are, and the turn unpublished.
    await mkdir(join(container, dir, 'out'), { recursive: true })
    await writeFile(join(container, report), 'new report')
    await writeFile(join(container, summary), 'short')
    running = true
    assert.match((await tau.publish('session-p' as SessionId, 7))[0]!, /started another turn/u)
    running = false

    // The agent's report replaces the caller's, once for its turn, however many wait on it at once.
    const before = copied.length
    const [first, second] = await Promise.all([tau.publish('session-p' as SessionId, 7), tau.publish('session-p' as SessionId, 7)])
    assert.deepEqual([first, second], [[], []])
    assert.equal(copied.length - before, 2, 'one publish copied both outputs; the other found the turn published')
    assert.equal(await readFile(report, 'utf8'), 'new report')
    assert.equal(await readFile(summary, 'utf8'), 'short')
    await writeFile(join(container, report), 'later')
    assert.deepEqual(await tau.publish('session-p' as SessionId, 7), [])
    assert.equal(await readFile(report, 'utf8'), 'new report')
    assert.deepEqual((await readdir(join(home, 'fleet', 'sessions', 'session-p'))).sort(), ['agent', 'in', 'published.json', 'spec.json'])

    // A fork of the session takes its spec and its snapshots, but none of its other paths or its variables, and publishes nothing.
    const found = await tau.specOf(header('session-p-fork', { cwd: '/w', parentSession: 'session-p' as SessionId }))
    assert.equal(found?.owner, 'session-p')
    await tau.configureFork('session-p-fork' as SessionId, found!)
    assert.deepEqual(configured.get('session-p-fork'), { mounts: [agentMount, rulesMount] })
    const copiedBefore = copied.length
    assert.deepEqual(await tau.publish('session-p-fork' as SessionId, 11), [])
    assert.equal(copied.length, copiedBefore)

    // A symlink left there is refused.
    await rm(join(container, report))
    await symlink('/etc/passwd', join(container, report))
    const linked = await tau.publish('session-p' as SessionId, 9)
    assert.deepEqual(linked, [`report: ${report} is a symlink, which is not copied out`])
    assert.equal(await readFile(report, 'utf8'), 'new report')

    // An inout path the run did not leave as declared fails it, and nothing is published.
    await rm(join(container, report))
    await writeFile(join(container, report), 'unchecked')
    await rm(join(dir, 'data'), { recursive: true })
    assert.deepEqual(await tau.publish('session-p' as SessionId, 10), [`data: ${join(dir, 'data')} is gone`])
    assert.equal(await readFile(report, 'utf8'), 'new report')

    // A run with only inout paths is checked too.
    await mkdir(join(dir, 'tree'))
    await tau.create('session-io' as SessionId, { ...spec, env: {}, paths: [{ name: 'tree', type: 'dir', role: 'inout', host: join(dir, 'tree') }] })
    assert.deepEqual(await tau.publish('session-io' as SessionId, 1), [])
    await rm(join(dir, 'tree'), { recursive: true })
    await writeFile(join(dir, 'tree'), 'a file now')
    assert.deepEqual(await tau.publish('session-io' as SessionId, 2), [`tree: ${join(dir, 'tree')} is not a folder`])

    // The container's root is always there, so an out path directly in it needs no folder made.
    await tau.create('session-root' as SessionId, { ...spec, env: {}, paths: [{ name: 'top', type: 'file', role: 'out', host: '/top.md' }] })
    assert.deepEqual(configured.get('session-root'), { mounts: [{ ...agentMount, source: join(home, 'fleet', 'sessions', 'session-root', 'agent') }] })

    // An in path that cannot be copied is the caller's to fix, and leaves nothing behind.
    await mkdir(join(dir, 'odd'))
    execFileSync('mkfifo', [join(dir, 'odd', 'pipe')])
    const refused = await tau.create('session-odd' as SessionId, { ...spec, env: {}, paths: [{ name: 'odd', type: 'dir', role: 'in', host: join(dir, 'odd') }] })
      .then(() => undefined, (error: unknown) => error)
    assert.ok(refused instanceof InputError)
    assert.deepEqual(refused.problems, [`odd: ${join(dir, 'odd', 'pipe')} is neither a file, a folder nor a symlink, which fleet does not copy in`])
    await assert.rejects(stat(join(home, 'fleet', 'sessions', 'session-odd')))
    assert.equal(configured.has('session-odd'), false)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('an agent directory that takes too long to read fails, and the next is read by a new worker', async () => {
  const ctx = new Context()
  ctx.provide('fleetServices', { list: () => [] })
  ctx.provide('fleetBox', {})
  await ctx.plugin(FleetTau, { prepareTimeoutMs: 1 })
  let tau: FleetTau | undefined
  await ctx.plugin({ name: 'caller', inject: ['fleetTau'], apply: (inner: Context) => { tau = inner.fleetTau } })
  assert.ok(tau !== undefined)
  await assert.rejects(tau.prepare({ agent, args: ['X'], bind: true, callerCwd: '/caller', cwd: '/session', env: {} }), /took longer than 0\.001 s/u)
  const patient = new Context()
  patient.provide('fleetServices', { list: () => [] })
  patient.provide('fleetBox', {})
  await patient.plugin(FleetTau, { prepareTimeoutMs: 60_000 })
  let other: FleetTau | undefined
  await patient.plugin({ name: 'caller', inject: ['fleetTau'], apply: (inner: Context) => { other = inner.fleetTau } })
  assert.ok((await other!.prepare({ agent, args: ['X'], bind: true, callerCwd: '/caller', cwd: '/session', env: {} })).ok)
})
