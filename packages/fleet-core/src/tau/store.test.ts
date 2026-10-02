import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { cp, lstat, mkdir, mkdtemp, readdir, readFile, readlink, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session/types'
import type { SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import type { ContainerAdditions } from '../box/world.ts'
import { promptSpec } from './spec.ts'
import { FleetTau, InputError, type Spec } from './store.ts'

let home: string
let agent: string

before(async () => {
  home = await mkdtemp(join(tmpdir(), 'fleet-tau-home-'))
  process.env.DSH_HOME = home
  agent = await mkdtemp(join(tmpdir(), 'fleet-tau-agent-'))
  await writeFile(join(agent, 'PROMPT.md'), 'Greet ${name}.')
  await writeFile(join(agent, 'tau.json'), '{"args": [{"name": "name", "type": "text"}]}')
  await writeFile(join(agent, 'notes.txt'), 'the author\'s own')
  await mkdir(join(agent, 'shared', 'shout'), { recursive: true })
  await writeFile(join(agent, 'shared', 'shout', 'SKILL.md'), '---\nname: shout\ndescription: Shout.\n---\nSHOUT\n')
  await mkdir(join(agent, 'skills'))
  // A skill kept elsewhere in the tau, as it may link one.
  await symlink(join('..', 'shared', 'shout'), join(agent, 'skills', 'shout'))
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
  ctx.provide('fleetBackends', { list: () => [] })
  ctx.provide('fleetBox', {
    configure: (id: string, additions: ContainerAdditions) => { configured.set(id, additions); return Promise.resolve() },
    unconfigure: (id: string) => { configured.delete(id); return Promise.resolve() },
    turnRunning: () => false,
    ownerHeaderOf: (id: string) => {
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
  const prepared = await tau.prepare({ agent, args: ['World'], bind: true, callerCwd: '/caller', env: {} })
  assert.ok(prepared.ok, JSON.stringify(prepared))
  assert.equal(prepared.spec.prompt, 'Greet World.')

  await tau.create('session-a' as SessionId, prepared.spec)
  const folder = join(home, 'fleet', 'sessions', 'session-a')
  assert.equal((await stat(folder)).mode & 0o777, 0o700)
  assert.equal(await readFile(join(folder, 'agent', 'PROMPT.md'), 'utf8'), 'Greet ${name}.')
  // The whole tau, whose symlinks stay as they are, and still lead where they did.
  assert.equal(await readlink(join(folder, 'agent', 'skills', 'shout')), join('..', 'shared', 'shout'))
  assert.ok((await stat(join(folder, 'agent', 'skills', 'shout', 'SKILL.md'))).isFile())
  assert.equal(await readFile(join(folder, 'agent', 'notes.txt'), 'utf8'), 'the author\'s own')
  // Nothing of the store is mounted: fleet-box copies the snapshot into the container, whose folder is its own, not the workspace dir.
  assert.deepEqual(configured.get('session-a'), { ownFolder: true, copies: [{ source: join(folder, 'agent'), target: '/tau/agent' }] })

  assert.deepEqual((await tau.specOf(headers['session-a']!))?.spec, prepared.spec)
  assert.equal(await tau.specOf(headers['session-web']!), undefined)
  // A second spec never lands in a session's folder.
  await assert.rejects(tau.create('session-a' as SessionId, prepared.spec))
})

test('a fork, even one of a subagent, takes its source\'s spec and snapshot', async () => {
  const { tau, configured, headers } = await setup()
  const prepared = await tau.prepare({ agent, args: ['Fork'], bind: true, callerCwd: '/caller', env: {} })
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
  assert.equal(configured.get('session-fork')?.ownFolder, true)
})

test('a run of a prompt works in the workspace dir, and so does a fork of it', async () => {
  const { tau, configured, headers } = await setup()
  await tau.create('session-prompt' as SessionId, promptSpec('Say hi.'))
  assert.equal(configured.get('session-prompt')?.ownFolder, undefined)
  headers['session-prompt'] = header('session-prompt', { cwd: '/w' })
  const fromPrompt = await tau.specOf(header('session-prompt-fork', { cwd: '/w', parentSession: 'session-prompt' as SessionId }))
  await tau.configureFork('session-prompt-fork' as SessionId, fromPrompt!)
  assert.equal(configured.get('session-prompt-fork')?.ownFolder, undefined)
})

test('a spec is removed with its additions, and a broken one fails to read', async () => {
  const { tau, configured } = await setup()
  const prepared = await tau.prepare({ agent, args: ['X'], bind: true, callerCwd: '/caller', env: {} })
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
  const prepared = await tau.prepare({ agent, args: [], bind: true, callerCwd: '/caller', env: {} })
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
    ctx.provide('fleetBackends', { list: () => [] })
    ctx.provide('fleetBox', {
      configure: (id: string, additions: ContainerAdditions) => { configured.set(id, additions); return Promise.resolve() },
      unconfigure: () => Promise.resolve(),
      turnRunning: () => running,
      ownerHeaderOf: (id: string) => Promise.resolve(header(id, { cwd: '/w', ...id === 'session-p-fork' ? { parentSession: 'session-p' as SessionId } : {} })),
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
      version: 3, agent: { name: 'paths', source: agent }, args: [], prompt: 'x', skills: [], apis: [], env: { LANG: 'C.UTF-8' },
      paths: [
        { name: 'rules', type: 'file', role: 'in', host: join(dir, 'rules.md'), view: '/w/rules.md' },
        { name: 'report', type: 'file', role: 'out', host: report, view: '/w/out/report.md' },
        { name: 'summary', type: 'file', role: 'out', host: summary, view: '/w/summary.md' },
      ],
    }
    await tau.create('session-p' as SessionId, spec)
    const folder = join(home, 'fleet', 'sessions', 'session-p')
    const agentCopy = { source: join(folder, 'agent'), target: '/tau/agent' }
    // An in path is its snapshot, which fleet-box copies into the container at its place, as it does the agent's.
    const rulesCopy = { source: join(folder, 'in', 'rules'), target: '/w/rules.md' }
    // Nothing of the caller's is mounted; the container's folder is its own.
    assert.deepEqual(configured.get('session-p'), {
      ownFolder: true,
      copies: [agentCopy, rulesCopy],
      env: { LANG: 'C.UTF-8' },
      directories: ['/w/out', '/w'],
    })
    await writeFile(join(dir, 'rules.md'), 'changed later')
    assert.equal(await readFile(join(folder, 'in', 'rules'), 'utf8'), 'be kind')

    // The agent left nothing: the check says so, and the caller's file stays.
    const nothing = await tau.publish('session-p' as SessionId, 3)
    assert.deepEqual(nothing, ['report: the agent left nothing at /w/out/report.md', 'summary: the agent left nothing at /w/summary.md'])
    assert.equal(await readFile(report, 'utf8'), 'old report')

    // A turn running now keeps the outputs where they are, and the turn unpublished.
    const reportView = join(container, '/w/out/report.md')
    await mkdir(join(container, '/w/out'), { recursive: true })
    await writeFile(reportView, 'new report')
    await writeFile(join(container, '/w/summary.md'), 'short')
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
    await writeFile(reportView, 'later')
    assert.deepEqual(await tau.publish('session-p' as SessionId, 7), [])
    assert.equal(await readFile(report, 'utf8'), 'new report')
    assert.deepEqual((await readdir(join(home, 'fleet', 'sessions', 'session-p'))).sort(), ['agent', 'in', 'published.json', 'spec.json'])

    // A fork of the session takes its spec and copies of its snapshots, but none of its other paths or its variables, and publishes nothing.
    const found = await tau.specOf(header('session-p-fork', { cwd: '/w', parentSession: 'session-p' as SessionId }))
    assert.equal(found?.owner, 'session-p')
    await tau.configureFork('session-p-fork' as SessionId, found!)
    assert.deepEqual(configured.get('session-p-fork'), { ownFolder: true, copies: [agentCopy, rulesCopy] })
    const copiedBefore = copied.length
    assert.deepEqual(await tau.publish('session-p-fork' as SessionId, 11), [])
    assert.equal(copied.length, copiedBefore)

    // A symlink left there is refused.
    await rm(reportView)
    await symlink('/etc/passwd', reportView)
    const linked = await tau.publish('session-p' as SessionId, 9)
    assert.deepEqual(linked, ['report: /w/out/report.md is a symlink, which is not copied out'])
    assert.equal(await readFile(report, 'utf8'), 'new report')

    // An out that shares its place with an in starts as the in's snapshot, and what the agent leaves there replaces the caller's path.
    const pages = join(dir, 'pages')
    await mkdir(pages)
    await writeFile(join(pages, 'a.md'), 'a')
    await tau.create('session-update' as SessionId, { ...spec, env: {}, paths: [
      { name: 'pages', type: 'dir', role: 'in', host: pages, view: '/w/pages' },
      { name: 'edited', type: 'dir', role: 'out', host: pages, view: '/w/pages' },
    ] })
    const updated = join(home, 'fleet', 'sessions', 'session-update')
    assert.deepEqual(configured.get('session-update'), {
      ownFolder: true,
      copies: [{ source: join(updated, 'agent'), target: '/tau/agent' }, { source: join(updated, 'in', 'pages'), target: '/w/pages' }],
      directories: ['/w'],
    })
    await mkdir(join(container, '/w/pages'), { recursive: true })
    await writeFile(join(container, '/w/pages/a.md'), 'A')
    await writeFile(join(container, '/w/pages/b.md'), 'B')
    assert.deepEqual(await tau.publish('session-update' as SessionId, 1), [])
    assert.deepEqual((await readdir(pages)).sort(), ['a.md', 'b.md'])
    assert.equal(await readFile(join(pages, 'a.md'), 'utf8'), 'A')

    // Where places lie in one another, the inner in is copied after the outer one, whose copy it replaces there, and out folders are made after both.
    await writeFile(join(dir, 'config.json'), '{}')
    await tau.create('session-places' as SessionId, { ...spec, env: {}, paths: [
      { name: 'config', type: 'file', role: 'in', host: join(dir, 'config.json'), view: '/w/pages/config.json' },
      { name: 'dist', type: 'dir', role: 'out', host: join(dir, 'dist'), view: '/w/pages/dist' },
      { name: 'pages', type: 'dir', role: 'in', host: pages, view: '/w/pages' },
    ] })
    const placed = join(home, 'fleet', 'sessions', 'session-places')
    assert.deepEqual(configured.get('session-places')?.copies, [
      { source: join(placed, 'agent'), target: '/tau/agent' },
      { source: join(placed, 'in', 'pages'), target: '/w/pages' },
      { source: join(placed, 'in', 'config'), target: '/w/pages/config.json' },
    ])
    assert.deepEqual(configured.get('session-places')?.directories, ['/w/pages'])

    // Out paths that overlap are published outermost first, whatever their order, each in place of what was there.
    const site = join(dir, 'site')
    await mkdir(site)
    await writeFile(join(site, 'stale.html'), 'stale')
    await tau.create('session-nested' as SessionId, { ...spec, env: {}, paths: [
      { name: 'note', type: 'file', role: 'out', host: join(site, 'note.md'), view: '/w/note.md' },
      { name: 'site', type: 'dir', role: 'out', host: site, view: '/w/site' },
    ] })
    await mkdir(join(container, '/w/site'), { recursive: true })
    await writeFile(join(container, '/w/site/index.html'), 'index')
    await writeFile(join(container, '/w/site/note.md'), 'the site\'s own note')
    await writeFile(join(container, '/w/note.md'), 'the note')
    assert.deepEqual(await tau.publish('session-nested' as SessionId, 1), [])
    assert.deepEqual((await readdir(site)).sort(), ['index.html', 'note.md'])
    assert.equal(await readFile(join(site, 'note.md'), 'utf8'), 'the note')

    // An in path that cannot be copied is the caller's to fix, and leaves nothing behind.
    await mkdir(join(dir, 'odd'))
    execFileSync('mkfifo', [join(dir, 'odd', 'pipe')])
    const refused = await tau.create('session-odd' as SessionId, { ...spec, env: {}, paths: [{ name: 'odd', type: 'dir', role: 'in', host: join(dir, 'odd'), view: '/w/odd' }] })
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
  ctx.provide('fleetBackends', { list: () => [] })
  ctx.provide('fleetBox', {})
  await ctx.plugin(FleetTau, { prepareTimeoutMs: 1 })
  let tau: FleetTau | undefined
  await ctx.plugin({ name: 'caller', inject: ['fleetTau'], apply: (inner: Context) => { tau = inner.fleetTau } })
  assert.ok(tau !== undefined)
  await assert.rejects(tau.prepare({ agent, args: ['X'], bind: true, callerCwd: '/caller', env: {} }), /took longer than 0\.001 s/u)
  const patient = new Context()
  patient.provide('fleetBackends', { list: () => [] })
  patient.provide('fleetBox', {})
  await patient.plugin(FleetTau, { prepareTimeoutMs: 60_000 })
  let other: FleetTau | undefined
  await patient.plugin({ name: 'caller', inject: ['fleetTau'], apply: (inner: Context) => { other = inner.fleetTau } })
  assert.ok((await other!.prepare({ agent, args: ['X'], bind: true, callerCwd: '/caller', env: {} })).ok)
})

test('a run started in a container takes its in paths from the caller\'s container, and publishes its outputs back into it', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fleet-tau-nested-'))
  try {
    // Each container's files are under a folder of its own, at their paths in the container.
    const roots: Record<string, string> = { 'session-caller': join(dir, 'caller'), 'session-run': join(dir, 'run') }
    const inside = (owner: string, path: string): string => join(roots[owner]!, path)
    await mkdir(inside('session-caller', '/workspace/data'), { recursive: true })
    await writeFile(inside('session-caller', '/workspace/a.txt'), 'one two')
    await writeFile(inside('session-caller', '/workspace/data/b.txt'), 'three')
    await symlink('b.txt', inside('session-caller', '/workspace/data/link'))
    await mkdir(inside('session-caller', '/tmp/out'), { recursive: true })

    const ctx = new Context()
    const configured = new Map<string, ContainerAdditions>()
    const copiedIn: string[] = []
    ctx.provide('fleetBackends', { list: () => [] })
    ctx.provide('fleetBox', {
      configure: (id: string, additions: ContainerAdditions) => { configured.set(id, additions); return Promise.resolve() },
      unconfigure: (id: string) => { configured.delete(id); return Promise.resolve() },
      turnRunning: () => false,
      ownerHeaderOf: (id: string) => Promise.resolve(header(id, { cwd: '/w', origin: 'subagent', parentSession: 'session-caller' as SessionId })),
      // As fleet-box copies: keeping links, the path is followed and the links in it copied as they are.
      copyOut: async (owner: string, source: string, target: string, options: { links?: boolean } = {}) => {
        const from = inside(owner, source)
        if ((await lstat(from).catch(() => undefined)) === undefined) return false
        await cp(options.links === true ? await realpath(from) : from, target, { recursive: true, verbatimSymlinks: true })
        return true
      },
      copyIn: async (owner: string, source: string, target: string) => {
        copiedIn.push(`${owner}:${target}`)
        await rm(inside(owner, target), { recursive: true, force: true })
        await cp(source, inside(owner, target), { recursive: true, verbatimSymlinks: true })
      },
      pathType: async (owner: string, path: string) => {
        const info = await stat(inside(owner, path)).catch(() => undefined)
        return info === undefined ? undefined : info.isDirectory() ? 'directory' : info.isFile() ? 'file' : 'other'
      },
    })
    await ctx.plugin(FleetTau)
    let tau: FleetTau | undefined
    await ctx.plugin({ name: 'caller', inject: ['fleetTau'], apply: (inner: Context) => { tau = inner.fleetTau } })
    assert.ok(tau !== undefined)

    const spec: Spec = {
      version: 3, agent: { name: 'count', source: '/workspace/agents/count' }, caller: 'session-caller', args: [], prompt: 'x', skills: [], apis: [], env: {},
      paths: [
        { name: 'text', type: 'file', role: 'in', host: '/workspace/a.txt', view: '/w/text' },
        { name: 'data', type: 'dir', role: 'in', host: '/workspace/data', view: '/w/data' },
        { name: 'report', type: 'file', role: 'out', host: '/tmp/out/report.md', view: '/w/out/report.md' },
      ],
    }
    // The paths are checked in the caller's container, as tau checks them.
    const missing = await tau.create('session-bad' as SessionId, {
      ...spec,
      paths: [
        { ...spec.paths[0]!, host: '/workspace/none.txt' },
        { ...spec.paths[1]!, host: '/workspace/a.txt' },
        { ...spec.paths[2]!, host: '/nowhere/report.md' },
      ],
    }, undefined, agent).then(() => undefined, (error: unknown) => error)
    assert.ok(missing instanceof InputError)
    assert.deepEqual(missing.problems, [
      'text: /workspace/none.txt does not exist',
      'data: /workspace/a.txt is not a directory',
      'report: cannot go in /nowhere, which does not exist',
    ])

    // The agent's snapshot is taken from the copy the call made, not from where the caller has it.
    await tau.create('session-run' as SessionId, spec, undefined, agent)
    const folder = join(home, 'fleet', 'sessions', 'session-run')
    assert.equal(await readFile(join(folder, 'agent', 'PROMPT.md'), 'utf8'), 'Greet ${name}.')
    assert.equal(await readFile(join(folder, 'in', 'text'), 'utf8'), 'one two')
    assert.equal(await readlink(join(folder, 'in', 'data', 'link')), 'b.txt')
    // Its container's folder is its own, as any run's is, and so is a fork's of it, as its source's is.
    assert.deepEqual(configured.get('session-run')?.directories, ['/w/out'])
    assert.equal(configured.get('session-run')?.ownFolder, true)
    await tau.configureFork('session-run-fork' as SessionId, { spec, owner: 'session-run' as SessionId })
    assert.equal(configured.get('session-run-fork')?.ownFolder, true)

    await mkdir(inside('session-run', '/w/out'), { recursive: true })
    await writeFile(inside('session-run', '/w/out/report.md'), '2')
    assert.deepEqual(await tau.publish('session-run' as SessionId, 0), [])
    assert.deepEqual(copiedIn, ['session-caller:/tmp/out/report.md'])
    assert.equal(await readFile(inside('session-caller', '/tmp/out/report.md'), 'utf8'), '2')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
