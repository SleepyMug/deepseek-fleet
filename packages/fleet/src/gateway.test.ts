import assert from 'node:assert/strict'
import { mkdir, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { create } from '@bufbuild/protobuf'
import { Code, ConnectError } from '@connectrpc/connect'
import { SpawnRequestSchema, TerminalRequestSchema, WriteFileRequestSchema, FileType } from '@sleepymug/fleet-protocol/box'
import { BoxState } from '@sleepymug/fleet-protocol/gateway'
import { Reason, reasonOf } from '@sleepymug/fleet-sdk'
import { writeTar, bytesEntry } from '@sleepymug/fleet-pack'
import { echoRoutes, echoSchema, serving, until } from './test.util.ts'

test('a box made with a service has its client, which a program below /fleet imports, and the service is told the box', async (t) => {
  const { dir, client, driver } = await serving(t)
  const { schema, Echo } = await echoSchema(dir)
  await client.serve({ name: 'echo', description: 'Says back what it is told.', schema, services: [Echo], routes: echoRoutes(Echo) })
  const made = await client.create({ labels: { who: 'test' }, services: ['echo'] })
  assert.deepEqual(made.services, ['echo'])
  assert.equal(made.state, BoxState.STOPPED)
  const box = client.box(made.id)
  await box.start()
  const root = driver.root(made.id)
  await mkdir(join(root, 'fleet', 'programs'), { recursive: true })
  await writeFile(join(root, 'fleet', 'programs', 'say.mjs'), [
    "import { echo } from '@fleet/echo'",
    "const said = await echo.say({ text: 'hello' })",
    'const repeated = []',
    "for await (const each of echo.repeat({ text: 'again', times: 2 })) repeated.push(each.text)",
    'console.log(JSON.stringify({ text: said.text, from: said.from, labels: said.labels, repeated }))',
  ].join('\n'))
  const out = await box.output([process.execPath, join(root, 'fleet', 'programs', 'say.mjs')])
  assert.deepEqual(JSON.parse(out), { text: 'hello', from: made.id, labels: { who: 'test' }, repeated: ['again 1', 'again 2'] })
  const readme = await readFile(join(root, 'fleet', 'README.md'), 'utf8')
  assert.match(readme, /## echo/u)
  assert.match(readme, /`echo.say\(request\)`, answers a `SayResponse`: Say `text` back, with who said it\./u)
  assert.match(await readFile(join(root, 'fleet', 'node_modules', '@fleet', 'echo', 'index.d.ts'), 'utf8'), /Says back what it is told, and who told it\./u)
  assert.equal((await box.info()).state, BoxState.STARTED)
})

test('a client calls a service through the gateway as a client; a box not made with it is refused', async (t) => {
  const { dir, client } = await serving(t)
  const { schema, Echo } = await echoSchema(dir)
  await client.serve({ name: 'echo', description: 'Says back.', schema, services: [Echo], routes: echoRoutes(Echo) })
  const echo = client.client('echo', Echo) as unknown as { say(req: { text: string }): Promise<{ text: string; from: string }> }
  assert.equal((await echo.say({ text: 'hi' })).from, 'client')

  const bare = await client.create({})
  const program = [
    "import { request } from 'node:http'",
    "const call = request({ socketPath: process.env.FLEET_SERVICES_SOCKET, path: '/services/echo/echo.v1.Echo/Say', method: 'POST', headers: { 'content-type': 'application/json' } }, (res) => {",
    "  let body = ''; res.on('data', (c) => { body += c }); res.on('end', () => { console.log(JSON.stringify({ status: res.statusCode, body: JSON.parse(body) })) })",
    '})',
    "call.end(JSON.stringify({ text: 'hi' }))",
  ].join('\n')
  await client.box(bare.id).start()
  const refused = JSON.parse(await client.box(bare.id).output([process.execPath, '--input-type=module', '--eval', program]))
  assert.equal(refused.status, 404)
  assert.equal(refused.body.code, 'not_found')
  assert.match(refused.body.message, /has no service echo/u)
})

test('a box\'s API: files written and read, folders listed, trees put and got, programs spawned with their input, and which', async (t) => {
  const { dir, client, driver } = await serving(t)
  const made = await client.create({})
  const box = client.box(made.id)
  await box.start()
  const root = driver.root(made.id)
  const file = join(root, 'work', 'notes.txt')
  async function* write() {
    yield create(WriteFileRequestSchema, { request: { case: 'start', value: { path: file, parents: true } } })
    yield create(WriteFileRequestSchema, { request: { case: 'chunk', value: Buffer.from('one\n') } })
    yield create(WriteFileRequestSchema, { request: { case: 'chunk', value: Buffer.from('two\n') } })
  }
  assert.equal((await box.api.writeFile(write())).size, 8n)
  const read: Buffer[] = []
  for await (const { chunk } of box.api.readFile({ path: file, offset: 4n })) read.push(Buffer.from(chunk))
  assert.equal(Buffer.concat(read).toString(), 'two\n')
  const stat = await box.api.stat({ path: file })
  assert.equal(stat.info?.type, FileType.FILE)
  assert.equal(stat.info?.size, 8n)
  assert.equal((await box.api.stat({ path: join(root, 'nothing') })).info, undefined)
  await box.put(writeTar([bytesEntry('a/b.txt', 'b'), bytesEntry('c.txt', 'c')]), join(root, 'tree'))
  const listed = await box.api.listDir({ path: join(root, 'tree') })
  assert.deepEqual(listed.entries.map(entry => [entry.name, entry.info?.type]), [['a', FileType.DIRECTORY], ['c.txt', FileType.FILE]])
  await box.getPath(join(root, 'tree'), join(dir, 'got'))
  assert.equal(await readFile(join(dir, 'got', 'a', 'b.txt'), 'utf8'), 'b')
  assert.deepEqual(await box.api.remove({ path: join(root, 'tree'), recursive: true }), { $typeName: 'fleet.box.v1.RemoveResponse', removed: true })
  await assert.rejects(box.api.readFile({ path: join(root, 'nothing') })[Symbol.asyncIterator]().next(), (error: unknown) => ConnectError.from(error).code === Code.NotFound)

  async function* spawn() {
    yield create(SpawnRequestSchema, { request: { case: 'start', value: { program: { argv: ['sh', '-c', 'read line; echo "got $line"; echo oops >&2; exit 3'] }, stdin: true } } })
    yield create(SpawnRequestSchema, { request: { case: 'stdin', value: Buffer.from('milk\n') } })
    yield create(SpawnRequestSchema, { request: { case: 'closeStdin', value: true } })
  }
  const seen: string[] = []
  for await (const { response } of box.api.spawn(spawn())) {
    if (response.case === 'started') seen.push('started')
    else if (response.case === 'stdout') seen.push(`out ${Buffer.from(response.value).toString().trim()}`)
    else if (response.case === 'stderr') seen.push(`err ${Buffer.from(response.value).toString().trim()}`)
    else if (response.case === 'exit') seen.push(`exit ${String(response.value.code)}`)
  }
  assert.deepEqual(seen.sort(), ['err oops', 'exit 3', 'out got milk', 'started'])
  assert.notEqual((await box.api.which({ command: 'sh' })).path, '')
  assert.equal((await box.api.which({ command: 'no-such-program' })).path, '')
})

test('a box\'s files have versions a write can wait on, are replaced whole, keep their bits, resolve through symlinks, and are watched', async (t) => {
  const { client, driver } = await serving(t)
  const made = await client.create({})
  const box = client.box(made.id)
  await box.start()
  const root = driver.root(made.id)
  const file = join(root, 'work', 'notes.txt')
  const write = (content: string, start: Record<string, unknown>) => (async function* () {
    yield create(WriteFileRequestSchema, { request: { case: 'start', value: { path: file, parents: true, ...start } } })
    yield create(WriteFileRequestSchema, { request: { case: 'chunk', value: Buffer.from(content) } })
  })()
  const first = await box.api.writeFile(write('one', { exclusive: true, mode: 0o640 }))
  assert.equal(first.version, (await box.api.stat({ path: file })).info?.version)
  await assert.rejects(box.api.writeFile(write('again', { exclusive: true })), (error: unknown) => ConnectError.from(error).code === Code.AlreadyExists)
  const second = await box.api.writeFile(write('two', { ifVersion: first.version }))
  assert.notEqual(second.version, first.version)
  assert.equal((await box.api.stat({ path: file })).info?.mode, 0o640)
  await assert.rejects(box.api.writeFile(write('stale', { ifVersion: first.version })), (error: unknown) => ConnectError.from(error).code === Code.Aborted)
  assert.equal(await readFile(file, 'utf8'), 'two')

  // Through a symlink, the file it leads to is written, and the link stays.
  await box.exec(['ln', '-s', file, join(root, 'link')])
  await box.api.writeFile((async function* () {
    yield create(WriteFileRequestSchema, { request: { case: 'start', value: { path: join(root, 'link') } } })
    yield create(WriteFileRequestSchema, { request: { case: 'chunk', value: Buffer.from('three') } })
  })())
  assert.equal(await readFile(file, 'utf8'), 'three')
  assert.equal((await box.api.stat({ path: join(root, 'link') })).info?.type, FileType.SYMLINK)
  const real = await realpath(file)
  assert.equal((await box.api.resolve({ path: join(root, 'link') })).path, real)
  await box.exec(['ln', '-s', dirname(file), join(root, 'folder')])
  assert.equal((await box.api.resolve({ path: `${root}/folder/missing/deeper` })).path, join(dirname(real), 'missing', 'deeper'))

  const controller = new AbortController()
  const events: string[] = []
  const watching = (async () => {
    for await (const { event } of box.api.watch({ path: file }, { signal: controller.signal })) {
      events.push(event.case ?? '')
      if (event.case === 'ready') await box.api.writeFile(write('four', {}))
      if (event.case === 'changed') controller.abort()
    }
  })()
  await assert.rejects(watching, (error: unknown) => ConnectError.from(error).code === Code.Canceled)
  assert.deepEqual(events, ['ready', 'changed'])
})

test('a spawned program is ended, its group with it, when its call is cancelled', async (t) => {
  const { client } = await serving(t)
  const box = client.box((await client.create({})).id)
  await box.start()
  const controller = new AbortController()
  async function* spawn() {
    yield create(SpawnRequestSchema, { request: { case: 'start', value: { program: { argv: ['sh', '-c', 'sleep 30 & echo $!; wait'] }, graceMs: 200 } } })
    await new Promise(() => {})
  }
  let child = 0
  await assert.rejects((async () => {
    for await (const { response } of box.api.spawn(spawn(), { signal: controller.signal })) {
      if (response.case === 'stdout') {
        child = Number(Buffer.from(response.value).toString().trim())
        controller.abort()
      }
    }
  })())
  assert.ok(child > 0)
  await until(() => { try { process.kill(child, 0); return false } catch { return true } }, 5000, 'the spawned group to end')
})

test('a terminal runs a program, takes what is typed, and says how it ended', async (t) => {
  const { client } = await serving(t)
  const box = client.box((await client.create({})).id)
  await box.start()
  const typed = Promise.withResolvers<void>()
  async function* terminal() {
    yield create(TerminalRequestSchema, { request: { case: 'start', value: { program: { argv: ['sh'] }, size: { cols: 80, rows: 24 } } } })
    await typed.promise
    yield create(TerminalRequestSchema, { request: { case: 'input', value: Buffer.from('echo hel""lo; exit 4\n') } })
  }
  let output = ''
  let exit: number | undefined
  for await (const { response } of box.api.terminal(terminal())) {
    if (response.case === 'started') typed.resolve()
    if (response.case === 'output') output += Buffer.from(response.value).toString()
    if (response.case === 'exit') exit = response.value.code
  }
  assert.match(output, /hello/u)
  assert.equal(exit, 4)
})

test('a box runs from its start until it is stopped, and its watch follows it', async (t) => {
  const { client } = await serving(t)
  const made = await client.create({})
  const box = client.box(made.id)
  const states: (BoxState | 'removed')[] = []
  const stop = box.watch((state) => { states.push(state) })
  await box.start()
  assert.equal((await box.info()).state, BoxState.STARTED)
  await new Promise(resolve => setTimeout(resolve, 300))
  assert.equal((await box.info()).state, BoxState.STARTED, 'nothing stops it but a stop')
  await box.stop()
  assert.equal((await box.info()).state, BoxState.STOPPED)
  await box.remove()
  await until(() => states.at(-1) === 'removed', 5000, 'the watch to see the removal')
  stop()
  assert.deepEqual(states, [BoxState.STOPPED, BoxState.STARTING, BoxState.STARTED, BoxState.STOPPING, BoxState.STOPPED, 'removed'])
})

test('a call of a box\'s API needs the box started, which the call does not do', async (t) => {
  const { client } = await serving(t)
  const box = client.box((await client.create({})).id)
  await assert.rejects(box.api.which({ command: 'sh' }), (error: unknown) => reasonOf(error) === Reason.NOT_STARTED)
  assert.equal((await box.info()).state, BoxState.STOPPED)
  await box.start()
  assert.notEqual((await box.api.which({ command: 'sh' })).path, '')
})

test('a service gone fails its calls, and the box\'s client calls it again once it is back; a name served by another is refused', async (t) => {
  const { dir, client, driver } = await serving(t)
  const { schema, Echo } = await echoSchema(dir)
  const definition = { name: 'echo', description: 'Says back.', schema, services: [Echo], routes: echoRoutes(Echo) }
  const first = await client.serve(definition)
  await assert.rejects(client.serve(definition), (error: unknown) => /another server serves echo/u.test(String(error)))
  const made = await client.create({ services: ['echo'] })
  const box = client.box(made.id)
  const program = join(driver.root(made.id), 'fleet', 'programs', 'say.mjs')
  await box.start()
  await mkdir(join(driver.root(made.id), 'fleet', 'programs'), { recursive: true })
  await writeFile(program, "import { echo } from '@fleet/echo'\ntry { console.log((await echo.say({ text: 'x' })).from) } catch (error) { console.log(error.code === 'not_found' ? 'not found' : String(error)) }\n")
  assert.equal((await box.output([process.execPath, program])).trim(), made.id)
  first.close()
  await until(() => client.serviceList().then(list => list.length === 0), 5000, 'the service to be gone')
  assert.equal((await box.output([process.execPath, program])).trim(), 'not found')
  await client.serve(definition)
  assert.equal((await box.output([process.execPath, program])).trim(), made.id)
})

test('the gateway restarted, a running box\'s helper dials it again, and a service\'s server opens its tunnel again', async (t) => {
  const server = await serving(t)
  const { dir, client } = server
  const { schema, Echo } = await echoSchema(dir)
  await client.serve({ name: 'echo', description: 'Says back.', schema, services: [Echo], routes: echoRoutes(Echo) })
  const made = await client.create({ services: ['echo'] })
  const box = client.box(made.id)
  await box.start()
  await server.restart()
  await until(() => client.serviceList().then(list => list.length === 1, () => false), 10_000, 'the service to register again')
  await until(async () => (await box.info().catch(() => undefined))?.state === BoxState.STARTED, 10_000, 'the box to be taken as started')
  assert.notEqual((await box.api.which({ command: 'sh' })).path, '')
})

test('a box is recorded before its container is made: a record not written, or a container not made, leaves nothing, and a record without one is a box gone, which is removed', async (t) => {
  const server = await serving(t)
  const { dir, client, driver, paths } = server
  await writeFile(paths.boxes, 'in the way')
  await assert.rejects(client.create({}))
  assert.deepEqual(await readdir(join(dir, 'boxes')).catch(() => []), [], 'no container is made for a box not recorded')
  await rm(paths.boxes)

  const create = driver.create.bind(driver)
  driver.create = async () => { throw new Error('no container') }
  await assert.rejects(client.create({}))
  driver.create = create
  assert.deepEqual(await client.list(), [])
  assert.deepEqual(await readdir(paths.boxes).catch(() => []), [])

  // As if the gateway died once the record was written, before the container was made.
  const made = await client.create({})
  await driver.lose(made.id)
  await server.restart()
  const box = client.box(made.id)
  await assert.rejects(box.start(), (error: unknown) => reasonOf(error) === Reason.BOX_GONE)
  assert.equal((await box.info()).state, BoxState.GONE)
  await box.remove()
  assert.deepEqual(await client.list(), [])
})
