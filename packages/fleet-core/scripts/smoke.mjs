// Runs the example agents' APIs through real session containers of the session image, as far as
// they go without a model: fleet-tau reads and stores each agent as `fleet run` has it, a
// container starts from the image as fleet-box starts one, and its helper, driven as fleet-box
// drives it, runs bash commands and the TypeScript runner as the agent's tools would, with its
// service calls relayed to fleet-tau's backends. A tau started inside one of them is read, stored
// and published as fleet-tau's `tau` backend has it, its own container started as fleet-box starts
// a subagent's, though no subagent runs it. Build the image first (`pnpm image`); `pnpm smoke` in
// the repository runs this. Needs Docker, and exits 1 at the first check that fails.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, posix } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { implementation } from 'fleet-image/apis/registry'
import { DEFAULT_IMAGE, HELPER_ENTRY, HELPER_NODE } from 'fleet-image/helper/image'
import { SERVICE_SOCKET, SOCKET_VARIABLE } from 'fleet-image/helper/protocol'
import { RUNNER_ENTRY, RUNNER_PROTOCOL, RUNNER_PROTOCOL_LABEL, TS_ROOT } from 'fleet-image/runner/protocol'
import { z } from 'zod'
import { additionArgs } from '../lib/box/additions.js'
import { HelperConnection } from '../lib/box/connection.js'
import { copyIn, replaceIn } from '../lib/box/copy-in.js'
import { copyOut } from '../lib/box/copy-out.js'
import { FleetBackends } from '../lib/tau/backends.js'
import * as archives from '../lib/tau/examples/archives.js'
import * as notes from '../lib/tau/examples/notes.js'
import * as relay from '../lib/tau/relay.js'
import { linksLeaving } from '../lib/tau/children.js'
import { AGENT_VIEW } from '../lib/tau/paths.js'
import { promptSpec } from '../lib/tau/spec.js'
import { FleetTau } from '../lib/tau/store.js'

const EXAMPLES = fileURLToPath(new URL('../../../examples/', import.meta.url))
const home = await mkdtemp(join(tmpdir(), 'fleet-smoke-home-'))
const workspace = await realpath(await mkdtemp(join(tmpdir(), 'fleet-smoke-session-')))
process.env.DSH_HOME = home
const containers = []
const connections = []
const step = (text) => { console.log(`\n== ${text}`) }

try {
  const label = execFileSync('docker', ['image', 'inspect', '--format', `{{index .Config.Labels "${RUNNER_PROTOCOL_LABEL}"}}`, DEFAULT_IMAGE], { encoding: 'utf8' }).trim()
  assert.equal(label, String(RUNNER_PROTOCOL), `${DEFAULT_IMAGE}'s runner speaks protocol ${label}, not ${RUNNER_PROTOCOL}; run \`pnpm image\``)

  // fleet-tau as the fleet profile loads it, with both example backends; ctx.fleetBox is this script.
  const ctx = new Context()
  const additionsOf = new Map()
  /** Each session's helper, which its container's copies and lookups go through. */
  const helpers = new Map()
  let serve
  ctx.provide('fleetBox', {
    configure: async (id, additions) => { additionsOf.set(id, additions) },
    unconfigure: async () => {},
    turnRunning: () => false,
    ownerHeaderOf: async id => ({ id, cwd: workspace }),
    serveCalls: (handler) => { serve = handler; return () => {} },
    copyOut: (id, source, target, options) => copyOut(helpers.get(id), source, target, options),
    copyIn: (id, source, target) => replaceIn(helpers.get(id), source, target),
    // As fleet-box looks a path up: resolved, then its type, symlinks followed.
    pathType: async (id, path) => {
      const target = await helpers.get(id).request('fs.resolve', { path }, z.object({ targetKey: z.string(), displayPath: z.string() }))
      return (await helpers.get(id).request('fs.stat', { target }, z.object({ type: z.string() }).nullable()))?.type
    },
  })
  await ctx.plugin(FleetBackends)
  await ctx.plugin(notes)
  await ctx.plugin(archives)
  await ctx.plugin(FleetTau)
  await ctx.plugin(relay)
  let tau
  await ctx.plugin({ name: 'smoke', inject: ['fleetTau'], apply: (inner) => { tau = inner.fleetTau } })

  /** A session as `fleet run` makes one, in the workspace dir as its project, and its container and helper as fleet-box starts them. */
  async function session(id, agent, args) {
    const prepared = await tau.prepare({ agent: join(EXAMPLES, agent), args, bind: true, callerCwd: EXAMPLES, project: workspace, env: {} })
    assert.ok(prepared.ok, JSON.stringify(prepared))
    await tau.create(id, prepared.spec)
    return { spec: prepared.spec, connection: await container(id, workspace) }
  }

  /**
   * A session's container and helper, as fleet-box starts them: one mounts
   * the workspace dir, unless its additions make the folder its own, as a
   * run of an agent directory's do.
   */
  async function container(id, folder) {
    const additions = additionsOf.get(id)
    const mounted = additions.ownFolder !== true
    const name = `fleet-smoke-${id}`
    execFileSync('docker', ['rm', '--force', name], { stdio: 'ignore' })
    execFileSync('docker', ['run', '--detach', '--name', name, '--init',
      ...mounted ? ['--mount', `type=bind,src=${folder},dst=${folder}`] : [], '--env', `${SOCKET_VARIABLE}=${SERVICE_SOCKET}`,
      ...additionArgs(additions, mounted ? folder : undefined), '--workdir', folder, DEFAULT_IMAGE, 'sleep', 'infinity'], { stdio: 'ignore' })
    containers.push(name)
    const connection = new HelperConnection({ docker: 'docker', container: name, workspace: folder, node: HELPER_NODE, entry: HELPER_ENTRY })
    await connection.start()
    connections.push(connection)
    helpers.set(id, connection)
    connection.serveCalls((call, signal) => serve(id, call, signal))
    if ((additions.directories ?? []).length > 0) execFileSync('docker', ['exec', name, 'mkdir', '-p', '--', ...additions.directories])
    for (const { source, target } of additions.copies ?? []) await copyIn(connection, source, target)
    return connection
  }

  let processes = 0
  /** One process through the helper, as ctx.subprocess spawns bash's commands and the runner. */
  async function run({ connection, cwd = workspace }, argv, stdin) {
    const id = `smoke-${processes++}`
    const out = []
    const err = []
    const done = new Promise((resolve, reject) => {
      connection.watch(id, { output: (stream, data) => { (stream === 'stdout' ? out : err).push(data) }, exit: (exitCode) => { resolve(exitCode) }, lost: reject })
    })
    await connection.request('process.spawn', { process: id, argv, cwd, env: {}, stdin: stdin ?? null, graceMs: 5000 }, z.object({ pid: z.number() }))
    const exitCode = await done
    return { exitCode, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') }
  }
  const bash = async (target, command) => {
    const result = await run(target, ['bash', '-c', command])
    assert.equal(result.exitCode, 0, result.stderr)
    return result.stdout
  }
  /** A runner request, with the agent's APIs as fleet-tau's ts-tools.ts sends them. */
  const runner = async (target, request) => {
    const apis = target.spec.apis.map(api => ({ name: api.name, types: posix.join(AGENT_VIEW, 'api', `${api.name}.d.ts`), implementation: implementation(api.name).image }))
    const result = await run(target, [HELPER_NODE, RUNNER_ENTRY], JSON.stringify({ root: TS_ROOT, apis, ...request }))
    assert.equal(result.exitCode, 0, result.stderr)
    return JSON.parse(result.stdout)
  }
  const execute = async (target, source, input) => {
    const reply = await runner(target, { command: 'execute', source, cwd: workspace, timeoutMs: 60_000, ...input === undefined ? {} : { input } })
    assert.ok(reply.ok, JSON.stringify(reply))
    return reply.value
  }

  step('notes: an API whose implementation keeps its notes on the host')
  await writeFile(join(workspace, 'host.txt'), 'the caller\'s own')
  const notesSession = await session('notes', 'notes', ['buy milk', 'shopping,errands'])
  // A run of an agent directory works in a folder of its container's own, at the workspace dir's path, which shows nothing of the host's.
  assert.equal(await bash(notesSession, 'pwd'), `${workspace}\n`)
  assert.equal(await bash(notesSession, 'ls -A'), '')
  const listed = await runner(notesSession, { command: 'modules' })
  console.log('ts_modules:', JSON.stringify(listed.modules.map(({ specifier, packageRoot }) => ({ specifier, packageRoot }))))
  const noted = await execute(notesSession, [
    'import { addNote, byTag } from "@api/notes"',
    'export async function main() {',
    '  const note = await addNote("buy milk", ["shopping", "errands"])',
    '  await addNote("fix the bike")',
    '  const found = await byTag("shopping")',
    '  return { note: { ...note, written: note.written instanceof Date }, found: found.map(n => n.text) }',
    '}',
  ].join('\n'))
  console.log('ts_execute:', JSON.stringify(noted))
  assert.deepEqual(noted, { note: { id: 1, text: 'buy milk', tags: ['shopping', 'errands'], written: true }, found: ['buy milk'] })
  // From bash, straight to the socket: a backend no API of the agent calls is refused.
  const refused = await bash(notesSession, `node -e 'const s = require("net").connect(process.env.${SOCKET_VARIABLE}); s.write(JSON.stringify({ service: "archives", function: "list", args: [] }) + "\\n"); s.on("data", d => { process.stdout.write(d); s.end() })'`)
  console.log('another backend, from bash:', refused.trim())
  assert.match(refused, /links no API that calls the backend archives/u)

  step('archive-dir: an API that takes a folder, packed with tar and sent to the host')
  const archiveSession = await session('archive', 'archive-dir', [join(EXAMPLES, 'hello')])
  // The snapshot of the in folder, at its place in the folder the agent works in, where the prompt names it.
  const dir = archiveSession.spec.paths[0].view
  assert.equal(dir, `${workspace}/dir`)
  assert.ok(archiveSession.spec.prompt.includes(`archive ${dir}.`), archiveSession.spec.prompt)
  assert.equal(await bash(archiveSession, 'ls -A'), 'dir\n')
  const archived = await execute(archiveSession, [
    'import { archiveDir, list } from "@api/archives"',
    'export async function main(input: { dir: string }) {',
    '  const receipt = await archiveDir(input.dir)',
    '  return { receipt, kept: await list() }',
    '}',
  ].join('\n'), { dir })
  console.log('ts_execute:', JSON.stringify(archived))
  const sha256 = (await bash(archiveSession, `tar -cf - -C ${dir} . | sha256sum`)).split(' ')[0]
  assert.equal(archived.receipt.sha256, sha256, 'the host hashed the bytes tar writes in the container')
  assert.deepEqual([...archived.receipt.entries].sort(), ['PROMPT.md', 'skills/', 'skills/shout/', 'skills/shout/SKILL.md', 'tau.json'])
  assert.deepEqual(archived.kept, [archived.receipt])
  const typed = await runner(archiveSession, { command: 'execute', source: 'import { archiveDir } from "@api/archives"\nexport async function main() { return await archiveDir(42) }', cwd: workspace, timeoutMs: 60_000 })
  assert.equal(typed.error?.name, 'TypeCheckError', 'the agent\'s declarations type its programs')

  step('text-stats: an API whose implementation runs in the program alone')
  const statsSession = await session('stats', 'text-stats', ['the cat and the hat'])
  const counted = await execute(statsSession, 'import { wordFrequencies } from "@api/text-stats"\nexport function main() { return wordFrequencies("the cat and the hat") }')
  console.log('ts_execute:', JSON.stringify(counted))
  assert.deepEqual(counted, { the: 2, cat: 1, and: 1, hat: 1 })

  step('a run started in a container: its agent and in paths copied out of the caller\'s, its outputs copied back')
  const caller = statsSession
  await copyIn(caller.connection, join(EXAMPLES, 'count-words'), '/tmp/agents/count')
  await bash(caller, 'ln -s PROMPT.md /tmp/agents/count/prompt-link.md && printf "#!/bin/sh\\necho run\\n" > /tmp/agents/count/run.sh && chmod 755 /tmp/agents/count/run.sh'
    + ' && printf "one two three" > /tmp/a.txt && mkdir -p /tmp/out && printf old > /tmp/out/report.txt && printf kept > /tmp/out/other.txt')
  const staging = await mkdtemp(join(tmpdir(), 'fleet-smoke-staging-'))
  try {
    const copied = join(staging, 'agent')
    assert.equal(await copyOut(caller.connection, '/tmp/agents/count', copied, { links: true }), true)
    assert.deepEqual(await linksLeaving(copied), [])
    const nested = await tau.prepare({
      agent: copied, source: '/tmp/agents/count', caller: 'stats', args: ['a.txt', '/tmp/out/report.txt'], bind: true, callerCwd: '/tmp', project: workspace,
      env: { LANG: 'C.UTF-8' },
    })
    assert.ok(nested.ok, JSON.stringify(nested))
    assert.deepEqual(nested.spec.agent, { name: 'count', source: '/tmp/agents/count' })
    await tau.create('child', nested.spec, undefined, copied)
    // It works as its caller's session does, at the workspace dir's path, in a folder of its container's own, which holds its paths at their places.
    const child = { spec: nested.spec, connection: await container('child', workspace) }
    assert.deepEqual(nested.spec.paths.map(path => path.view), [`${workspace}/text`, `${workspace}/report`])
    assert.equal(await bash(child, 'pwd'), `${workspace}\n`)
    assert.equal(await bash(child, 'ls -A'), 'text\n')
    assert.equal(await bash(child, 'cat text'), 'one two three')
    assert.equal(await bash(child, 'readlink /tau/agent/prompt-link.md'), 'PROMPT.md\n')
    assert.equal(await bash(child, '/tau/agent/run.sh'), 'run\n', 'a script keeps its mode through the copies')
    await bash(child, 'wc -w < text | tr -d " \n" > report')
    assert.deepEqual(await tau.publish('child', 0), [])
    // The caller's report is replaced, and nothing else in its folder is touched or left behind.
    assert.equal(await bash(caller, 'cat /tmp/out/report.txt'), '3')
    assert.equal(await bash(caller, 'ls -A /tmp/out'), 'other.txt\nreport.txt\n')
    // A path that is not there fails the run's start, checked in the caller's container.
    const missing = await tau.create('child-missing', { ...nested.spec, paths: nested.spec.paths.map(path => ({ ...path, host: `${path.host}.none` })) }, undefined, copied)
      .then(() => undefined, error => error)
    console.log('missing paths:', missing?.problems)
    assert.deepEqual(missing?.problems, ['text: /tmp/a.txt.none does not exist'])
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
  // The tau command reaches the host through the container's socket, which refuses an agent that does not declare the API.
  assert.match(await bash(caller, 'tau --help'), /^Usage: tau run/u)
  const refusedRun = await run(caller, ['tau', 'run', '/tmp/agents/count', 'a.txt', 'out.txt'])
  console.log('tau run, from an agent without the tau API:', refusedRun.stderr.trim())
  assert.equal(refusedRun.exitCode, 1)
  assert.match(refusedRun.stderr, /links no API that calls the backend tau/u)

  step('a run of a prompt: its container mounts the workspace dir to work in')
  await tau.create('prompt', promptSpec('Say hi.'))
  const promptSession = { connection: await container('prompt', workspace) }
  assert.equal(await bash(promptSession, 'cat host.txt'), 'the caller\'s own')

  console.log('\nevery check passed')
} finally {
  for (const connection of connections) await connection.close().catch(() => {})
  for (const name of containers) execFileSync('docker', ['rm', '--force', name], { stdio: 'ignore' })
  await rm(home, { recursive: true, force: true })
  await rm(workspace, { recursive: true, force: true })
}
