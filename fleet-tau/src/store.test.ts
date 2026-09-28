import assert from 'node:assert/strict'
import { cp, lstat, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session/types'
import type { SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import type { ContainerAdditions } from 'fleet-box/world'
import { FleetTau, type Spec } from './store.ts'

let home: string
let agent: string

before(async () => {
  home = await mkdtemp(join(tmpdir(), 'fleet-tau-home-'))
  process.env.DSH_HOME = home
  agent = await mkdtemp(join(tmpdir(), 'fleet-tau-agent-'))
  await writeFile(join(agent, 'PROMPT.md'), 'Greet ${name}.')
  await writeFile(join(agent, 'tau.json'), '{"args": [{"name": "name"}]}')
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
    ctx.provide('fleetServices', { list: () => [] })
    ctx.provide('fleetBox', {
      configure: (id: string, additions: ContainerAdditions) => { configured.set(id, additions); return Promise.resolve() },
      unconfigure: () => Promise.resolve(),
      rootHeaderOf: (id: string) => Promise.resolve(header(id, { cwd: '/w', ...id === 'session-p-fork' ? { parentSession: 'session-p' as SessionId } : {} })),
      // The container's files are under `container`, at their view paths; fleet-box refuses a symlink as it copies.
      copyOut: async (_root: string, view: string, target: string) => {
        copied.push(view)
        const source = join(container, view)
        if ((await lstat(source).catch(() => undefined))?.isSymbolicLink() === true) throw new Error(`${view} is a symlink, which is not copied out`)
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
    const spec: Spec = {
      version: 2, args: [], prompt: 'x', skills: [], services: {}, modules: [], ts: false, env: { LANG: 'C.UTF-8' },
      paths: [
        { name: 'rules', kind: 'file', mode: 'copy-in', host: join(dir, 'rules.md'), view: '/work/rules.md' },
        { name: 'data', kind: 'dir', mode: 'mount-rw', host: join(dir, 'data'), view: join(dir, 'data') },
        { name: 'report', kind: 'file', mode: 'copy-out', host: report, view: report },
      ],
    }
    await tau.create('session-p' as SessionId, spec)
    const folder = join(home, 'fleet', 'sessions', 'session-p')
    assert.deepEqual(configured.get('session-p'), {
      mounts: [
        { source: join(folder, 'agent'), target: '/opt/fleet/agent', readonly: true },
        { source: join(folder, 'paths', 'rules'), target: '/work/rules.md', readonly: false },
        { source: join(dir, 'data'), target: join(dir, 'data'), readonly: false },
      ],
      env: { LANG: 'C.UTF-8' },
      directories: [join(dir, 'out')],
    })
    assert.equal(await readFile(join(folder, 'paths', 'rules'), 'utf8'), 'be kind')

    // The agent left nothing: tau's check says so, and the caller's file stays.
    const nothing = await tau.publish('session-p' as SessionId, 3)
    assert.equal(nothing.length, 1)
    assert.match(nothing[0]!, /report/u)
    assert.equal(await readFile(report, 'utf8'), 'old report')

    // The agent's report replaces the caller's, once for its turn.
    await mkdir(join(container, dir, 'out'), { recursive: true })
    await writeFile(join(container, report), 'new report')
    assert.deepEqual(await tau.publish('session-p' as SessionId, 7), [])
    assert.equal(await readFile(report, 'utf8'), 'new report')
    await writeFile(join(container, report), 'later')
    assert.deepEqual(await tau.publish('session-p' as SessionId, 7), [])
    assert.equal(await readFile(report, 'utf8'), 'new report')
    assert.equal(copied.length, 2)

    // A fork of the session takes its spec but publishes nothing: the paths belong to the source's run.
    assert.deepEqual(await tau.publish('session-p-fork' as SessionId, 11), [])
    assert.equal(copied.length, 2)

    // A symlink left there is refused.
    await rm(join(container, report))
    await symlink('/etc/passwd', join(container, report))
    const linked = await tau.publish('session-p' as SessionId, 9)
    assert.deepEqual(linked, [`report: ${report} is a symlink, which is not copied out`])
    assert.equal(await readFile(report, 'utf8'), 'new report')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
