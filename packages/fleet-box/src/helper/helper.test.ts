import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { create } from '@bufbuild/protobuf'
import { InstallRequestSchema } from '@sleepymug/fleet-protocol/box'
import { BOX_VARIABLE, boxLayout, GATEWAY_VARIABLE, SERVICES_SOCKET_VARIABLE } from '@sleepymug/fleet-protocol/layout'
import { bytesEntry, writeTar } from '@sleepymug/fleet-pack'
import { boxEnvironment, programEnvironment } from './box/env.ts'
import { Provision } from './provision.ts'

test('a program\'s environment is the box\'s, less the helper\'s own, the services\' commands first on its PATH', () => {
  const layout = boxLayout('/')
  const box = boxEnvironment({ PATH: '/usr/bin:/fleet/bin', [GATEWAY_VARIABLE]: '/run/fleet/gateway/gateway.sock', [BOX_VARIABLE]: 'box-0123456789abcdef', HOME: '/root' }, layout)
  assert.equal(box.PATH, '/fleet/bin:/usr/bin')
  assert.equal(box[GATEWAY_VARIABLE], undefined)
  assert.equal(box[BOX_VARIABLE], undefined)
  assert.equal(box[SERVICES_SOCKET_VARIABLE], '/run/fleet/services.sock')
  const program = programEnvironment(box, { PATH: '/opt/bin', MODE: 'x' }, ['HOME'], layout)
  assert.deepEqual([program.PATH, program.MODE, program.HOME], ['/fleet/bin:/opt/bin', 'x', undefined])
})

test('an install replaces the tree\'s places, and keeps what else is there', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'fleet-box-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const layout = boxLayout(root)
  const provision = new Provision(layout)
  await mkdir(join(layout.fleet, 'programs'), { recursive: true })
  await writeFile(join(layout.fleet, 'programs', 'mine.mjs'), 'kept')
  await mkdir(join(layout.fleet, 'node_modules', '@fleet', 'old'), { recursive: true })
  async function* parts(files: Record<string, string>) {
    for await (const chunk of writeTar(Object.entries(files).map(([path, text]) => bytesEntry(path, text)))) yield create(InstallRequestSchema, { chunk })
  }
  await provision.install(parts({ 'README.md': '# one\n', 'node_modules/@fleet/new/index.js': '' }))
  assert.equal(await readFile(join(layout.fleet, 'README.md'), 'utf8'), '# one\n')
  assert.equal(await readFile(join(layout.fleet, 'programs', 'mine.mjs'), 'utf8'), 'kept')
  await assert.rejects(readFile(join(layout.fleet, 'node_modules', '@fleet', 'old', 'index.js')))
  assert.deepEqual((await readdir(layout.fleet)).sort(), ['README.md', 'node_modules', 'programs'])
})
