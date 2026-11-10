import assert from 'node:assert/strict'
import { existsSync, readlinkSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createClient, type Job } from '@sleepymug/tau'
import { decodeResult, packCall } from '@sleepymug/tau/wire-tar'
import { pack, setup } from './endpoint.ts'

/** The call `call` of the tau at `dir`, from `cwd`, as tau's client packs it, a tar archive. */
async function archived(dir: string, call: unknown, cwd: string): Promise<Buffer> {
  let job: Job | undefined
  const client = createClient({
    adaptors: {
      catch: {
        async submit(given) { job = given; return 'x' },
        async status() { return { state: 'running' } },
        async result() { throw new Error('no result') },
        async trace() { return { format: 'none', events: [] } },
        async release() {},
      },
    },
  })
  await client.start(dir, call, { cwd })
  const chunks: Buffer[] = []
  for await (const chunk of packCall(job as Job)) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks)
}

test('a box is set up from a run\'s call: its files placed, its context written, its packages below the program directory, and its result packed', async (t) => {
  const work = await mkdtemp(join(tmpdir(), 'dsh-tau-box-'))
  t.after(() => rm(work, { recursive: true, force: true }))
  const tau = join(work, 'shout')
  await mkdir(join(tau, 'node_modules', 'kit'), { recursive: true })
  await writeFile(join(tau, 'PROMPT.md'), 'Shout ${notes} into ${loud}, as ${style} says.\n')
  await writeFile(join(tau, 'tau.json'), JSON.stringify({
    files: { notes: { kind: 'file', mode: 'in', description: 'What.' }, loud: { kind: 'file', mode: 'out', description: 'Shouted.' } },
    args: { type: 'object', properties: { style: { type: 'string' } } },
    exposes: ['kit'],
    init: 'node ${self}/init.mts ${notes}',
  }))
  await writeFile(join(tau, 'node_modules', 'kit', 'package.json'), JSON.stringify({ name: 'kit', description: 'Loud helpers.' }))
  const caller = join(work, 'caller')
  await mkdir(caller)
  await writeFile(join(caller, 'notes.md'), 'hello\n')
  const root = join(work, 'box')
  const call = await archived(tau, { files: { notes: 'notes.md', loud: 'loud.txt' }, args: { style: 'as in ${notes}' } }, caller)

  const report = await setup((async function* () { yield call })(), root)
  assert.deepEqual(report, {
    prompt: 'Shout /tau/in/notes.md into /tau/out/loud.txt, as as in /tau/in/notes.md says.\n',
    cwd: '/tau/workspace',
    places: { notes: '/tau/in/notes.md', loud: '/tau/out/loud.txt' },
    self: '/tau/self',
    programs: '/tau',
    init: 'node /tau/self/init.mts /tau/in/notes.md',
    packages: [{ name: 'kit', dir: '/tau/node_modules/kit', description: 'Loud helpers.' }],
  })
  assert.equal(await readFile(join(root, 'tau/in/notes.md'), 'utf8'), 'hello\n')
  assert.deepEqual(JSON.parse(await readFile(join(root, 'tau/context.json'), 'utf8')), {
    self: '/tau/self', files: { notes: '/tau/in/notes.md', loud: '/tau/out/loud.txt' }, args: { style: 'as in /tau/in/notes.md' },
  })
  assert.equal(readlinkSync(join(root, 'tau/node_modules')), 'self/node_modules')
  assert.ok(existsSync(join(root, 'tau/TAU.md')) && existsSync(join(root, 'tau/TAU_DEV.md')))

  const failed = await decodeResult(await pack({ ok: true, text: 'Done.' }, root))
  assert.equal(failed.json.ok, false)
  assert.match(failed.json.failure ?? '', /loud: \S+ does not exist/u)
  await writeFile(join(root, 'tau/out/loud.txt'), 'HELLO\n')
  const { json } = await decodeResult(await pack({ ok: true, text: 'Done.' }, root))
  assert.deepEqual(json, { ok: true, text: 'Done.', outputs: { loud: { kind: 'file' } } })
})
