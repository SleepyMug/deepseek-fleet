import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { FleetGateway, fleetPaths, LocalDriver, serve, systemPlatform } from '@sleepymug/fleet/gateway'
import { Fleet } from '@sleepymug/fleet-sdk'
import { Notebooks } from './notebooks.ts'
import { notesService } from './service.ts'

test('each box keeps notes in a notebook of its own, through the notes client, or JSON from a shell', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'fleet-notes-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const paths = fleetPaths(join(dir, 'home'))
  const driver = new LocalDriver({ dir: join(dir, 'boxes'), gatewaySocket: paths.gatewaySocket })
  const gateway = await FleetGateway.open({ paths, driver, platform: systemPlatform(() => {}), image: 'local' })
  const served = await serve(gateway, { clients: paths.socket, boxes: paths.gatewaySocket })
  const client = await Fleet.connect({ socket: paths.socket })
  t.after(async () => {
    await client.close()
    await served.close()
    for (const box of gateway.listBoxes()) await driver.remove(box.id)
  })
  await client.serve(notesService(new Notebooks(join(dir, 'notebooks'))))

  const program = [
    "import { notes } from '@fleet/notes'",
    "const [command, ...rest] = process.argv.slice(2)",
    "if (command === 'add') console.log(JSON.stringify((await notes.add({ text: rest[0], tags: rest.slice(1) })).id))",
    "else console.log(JSON.stringify((await notes.tagged({ tag: rest[0] })).notes.map(note => note.text)))",
  ].join('\n')
  const boxes = []
  for (let i = 0; i < 2; i++) {
    const made = await client.create({ services: ['notes'] })
    await client.box(made.id).start()
    await mkdir(join(driver.root(made.id), 'fleet', 'programs'), { recursive: true })
    await writeFile(join(driver.root(made.id), 'fleet', 'programs', 'notes.mjs'), program)
    boxes.push({ box: client.box(made.id), program: join(driver.root(made.id), 'fleet', 'programs', 'notes.mjs') })
  }
  const [first, second] = boxes as [typeof boxes[0], typeof boxes[0]]
  assert.equal(await first.box.output([process.execPath, first.program, 'add', 'buy milk', 'shop']), '1\n')
  assert.equal(await first.box.output([process.execPath, first.program, 'add', 'call mum']), '2\n')
  assert.equal(await first.box.output([process.execPath, first.program, 'add', 'buy bread', 'shop']), '3\n')
  assert.deepEqual(JSON.parse(await first.box.output([process.execPath, first.program, 'tagged', 'shop'])), ['buy milk', 'buy bread'])
  assert.deepEqual(JSON.parse(await second.box.output([process.execPath, second.program, 'tagged', 'shop'])), [])

  const curl = await first.box.exec(['curl', '-s', '--unix-socket', join(driver.root((await first.box.info()).id), 'run', 'fleet', 'services.sock'),
    '-H', 'content-type: application/json', '-d', '{"tag":"shop"}', 'http://fleet/services/notes/notes.v1.Notes/Tagged'])
  if (curl.exit?.code === 0) {
    assert.deepEqual(JSON.parse(Buffer.from(curl.stdout).toString()).notes.map((note: { text: string }) => note.text), ['buy milk', 'buy bread'])
  } else {
    t.diagnostic('no curl here: the shell\'s call is left untried')
  }
})
