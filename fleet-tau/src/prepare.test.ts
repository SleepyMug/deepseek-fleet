import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { test } from 'node:test'
import { prepare, type PrepareRequest } from './prepare.ts'

async function withAgent(files: Record<string, string>, check: (dir: string) => void): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'fleet-tau-agent-'))
  try {
    for (const [path, text] of Object.entries(files)) {
      await mkdir(dirname(join(dir, path)), { recursive: true })
      await writeFile(join(dir, path), text)
    }
    check(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

const request = (agent: string, args: string[], bind = true, providers: PrepareRequest['providers'] = []): PrepareRequest =>
  ({ agent, args, bind, callerCwd: '/caller', env: {}, providers })

test('a run fills PROMPT.md with the arguments and titles the session after the agent', async () => {
  await withAgent({
    'PROMPT.md': 'Greet ${name}. Then say: ${rest}',
    'tau.json': '{"args": [{"name": "name"}, {"name": "rest"}]}',
    'skills/shout/SKILL.md': '---\nname: shout\ndescription: Shout.\n---\nSHOUT\n',
  }, (dir) => {
    const prepared = prepare(request(dir, ['World', 'bye']))
    assert.ok(prepared.ok, JSON.stringify(prepared))
    assert.equal(prepared.spec.prompt, 'Greet World. Then say: bye')
    assert.equal(prepared.title, `${basename(dir)} World bye`)
    assert.deepEqual(prepared.spec.agent, { name: basename(dir), source: dir })
    assert.deepEqual(prepared.spec.skills.map(skill => skill.name), ['shout'])
  })
})

test('every problem is reported together', async () => {
  await withAgent({
    'PROMPT.md': 'Edit ${src}',
    'tau.json': '{"args": [{"name": "src", "dir": "mount-rw"}], "env": ["LANG"]}',
    'skills/bad/SKILL.md': 'no frontmatter',
  }, (dir) => {
    const prepared = prepare(request(dir, []))
    assert.ok(!prepared.ok)
    assert.equal(prepared.problems.length, 4)
    assert.match(prepared.problems[0]!, /src is a folder argument, which fleet does not provide yet/u)
    assert.match(prepared.problems[1]!, /env lists LANG/u)
    assert.match(prepared.problems[2]!, /expected 1 argument/u)
    assert.match(prepared.problems[3]!, /bad\/SKILL\.md/u)
  })
})

test('a directory that is no tau, or whose tau.json breaks the spec, is refused', async () => {
  await withAgent({ 'README.md': 'x' }, (dir) => {
    const prepared = prepare(request(dir, []))
    assert.ok(!prepared.ok)
    assert.match(prepared.problems[0]!, /not a tau/u)
  })
  await withAgent({ 'PROMPT.md': 'x', 'tau.json': '{"unknown": 1}' }, (dir) => {
    assert.ok(!prepare(request(dir, [])).ok)
  })
})

test('a check without arguments does not bind them, and an empty prompt is refused only when bound', async () => {
  await withAgent({ 'PROMPT.md': '${text}', 'tau.json': '{"args": [{"name": "text"}]}' }, (dir) => {
    assert.ok(prepare(request(dir, [], false)).ok)
    const prepared = prepare(request(dir, ['  ']))
    assert.ok(!prepared.ok)
    assert.match(prepared.problems[0]!, /empty prompt/u)
  })
})

test('declared services must be provided and fit, and are recorded with their functions', async () => {
  const manifest = '/** Notes. @packageDocumentation */\nexport declare function addNote(text: string): Promise<number>;\n'
  await withAgent({ 'PROMPT.md': 'Take notes.', 'services/notes.d.ts': manifest }, (dir) => {
    const missing = prepare(request(dir, []))
    assert.ok(!missing.ok)
    assert.deepEqual(missing.problems, ['no fleet plugin provides the service notes'])
    const provided = { name: 'notes', declarations: 'export declare function addNote(text: string, tags?: string[]): Promise<number>;\n', functions: ['addNote'] }
    const prepared = prepare(request(dir, [], true, [provided]))
    assert.ok(prepared.ok, JSON.stringify(prepared))
    assert.deepEqual(prepared.spec.services, { notes: ['addNote'] })
  })
})

test('a manifest tau refuses, and modules, are problems', async () => {
  await withAgent({ 'PROMPT.md': 'x', 'services/bad.d.ts': 'export declare function f(when: Date): Promise<void>;\n', 'modules/m/package.json': '{}' }, (dir) => {
    const prepared = prepare(request(dir, []))
    assert.ok(!prepared.ok)
    assert.equal(prepared.problems.length, 2)
    assert.match(prepared.problems[0]!, /modules: fleet does not give agents their modules yet/u)
    assert.match(prepared.problems[1]!, /bad\.d\.ts/u)
  })
})
