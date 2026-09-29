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
  ({ agent, args, bind, callerCwd: '/caller', cwd: '/session', env: {}, providers })

test('a run fills PROMPT.md with the arguments and titles the session after the agent', async () => {
  await withAgent({
    'PROMPT.md': 'Greet ${name}. Then say: ${rest}',
    'tau.json': '{"args": [{"name": "name", "type": "text"}, {"name": "rest", "type": "text"}]}',
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
    'tau.json': '{"args": [{"name": "src", "type": "dir", "role": "inout"}], "env": ["TAU_SOCKET", "LANG", "NODE_OPTIONS", "LD_PRELOAD"]}',
    'skills/bad/SKILL.md': 'no frontmatter',
  }, (dir) => {
    const prepared = prepare(request(dir, []))
    assert.ok(!prepared.ok)
    assert.equal(prepared.problems.length, 3)
    assert.match(prepared.problems[0]!, /env lists TAU_SOCKET, NODE_OPTIONS, LD_PRELOAD, which the container keeps as its own/u)
    assert.match(prepared.problems[1]!, /expected 1 argument/u)
    assert.match(prepared.problems[2]!, /bad\/SKILL\.md/u)
  })
})

test('path arguments and variables are bound, outside the session folder only', async () => {
  const outside = await mkdtemp(join(tmpdir(), 'fleet-tau-outside-'))
  try {
    await mkdir(join(outside, 'src'))
    await withAgent({
      'PROMPT.md': 'Edit ${src} into ${report} with ${rules}',
      'tau.json': JSON.stringify({
        args: [{ name: 'src', type: 'dir', role: 'inout' }, { name: 'report', type: 'file', role: 'out' }, { name: 'rules', type: 'file', role: 'in' }],
        env: ['LANG', 'UNSET'],
      }),
    }, (dir) => {
      const args = [join(outside, 'src'), join(outside, 'report.md'), join(dir, 'PROMPT.md')]
      const prepared = prepare({ ...request(dir, args), env: { LANG: 'C.UTF-8' } })
      assert.ok(prepared.ok, JSON.stringify(prepared))
      assert.deepEqual(prepared.spec.env, { LANG: 'C.UTF-8' })
      assert.deepEqual(prepared.spec.paths.map(({ name, type, role, host }) => [name, type, role, host]), [
        ['src', 'dir', 'inout', join(outside, 'src')], ['report', 'file', 'out', join(outside, 'report.md')], ['rules', 'file', 'in', join(dir, 'PROMPT.md')],
      ])
      assert.equal(prepared.spec.prompt, `Edit ${join(outside, 'src')} into ${join(outside, 'report.md')} with ${join(dir, 'PROMPT.md')}`)
      // The same paths inside the session folder are refused, and so is a missing input.
      const inside = prepare({ ...request(dir, [join(outside, 'src'), join(outside, 'report.md'), join(dir, 'PROMPT.md')]), cwd: outside })
      assert.ok(!inside.ok)
      assert.equal(inside.problems.filter(problem => /the session folder/u.test(problem)).length, 2)
      const missing = prepare(request(dir, [join(outside, 'src'), join(outside, 'report.md'), join(dir, 'missing.md')]))
      assert.ok(!missing.ok)
      assert.match(missing.problems.join('\n'), /rules: .*missing\.md/u)
    })
  } finally {
    await rm(outside, { recursive: true, force: true })
  }
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
  await withAgent({ 'PROMPT.md': '${text}', 'tau.json': '{"args": [{"name": "text", "type": "text"}]}' }, (dir) => {
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
    assert.deepEqual(Object.keys(prepared.spec.services), ['notes'])
    assert.deepEqual(prepared.spec.services.notes?.functions, ['addNote'])
    assert.equal(prepared.spec.services.notes?.description, 'Notes.')
    assert.match(prepared.spec.services.notes?.declarations ?? '', /addNote\(text: string\): Promise<number>/u)
    assert.equal(prepared.spec.ts, true, 'an agent with services gets the TypeScript tools')
  })
})

test('a manifest tau refuses, and a module that is no package, are problems', async () => {
  await withAgent({ 'PROMPT.md': 'x', 'services/bad.d.ts': 'export declare function f(when: Date): Promise<void>;\n', 'modules/m/package.json': '{}' }, (dir) => {
    const prepared = prepare(request(dir, []))
    assert.ok(!prepared.ok)
    assert.equal(prepared.problems.length, 2)
    assert.match(prepared.problems[0]!, /modules\/m/u)
    assert.match(prepared.problems[1]!, /bad\.d\.ts/u)
  })
})

test('modules are recorded by name and folder, with a module whose imports do not resolve refused', async () => {
  const shout = {
    'modules/shout/package.json': JSON.stringify({ name: 'shout', description: 'Loud.', type: 'module', exports: { '.': { types: './index.d.ts', default: './index.js' } } }),
    'modules/shout/index.js': 'export const shout = (text) => text.toUpperCase()\n',
    'modules/shout/index.d.ts': 'export declare const shout: (text: string) => string;\n',
  }
  await withAgent({ 'PROMPT.md': 'x', ...shout }, (dir) => {
    const prepared = prepare(request(dir, []))
    assert.ok(prepared.ok, JSON.stringify(prepared))
    assert.deepEqual(prepared.spec.modules, [{ name: 'shout', description: 'Loud.', dir: 'shout' }])
    assert.equal(prepared.spec.ts, true)
  })
  await withAgent({ 'PROMPT.md': 'x', ...shout, 'modules/shout/index.js': 'import "not-installed"\n' }, (dir) => {
    const prepared = prepare(request(dir, []))
    assert.ok(!prepared.ok)
    assert.match(prepared.problems.join('\n'), /not-installed/u)
  })
})

test('the TypeScript tools come only when asked for or needed', async () => {
  await withAgent({ 'PROMPT.md': 'x' }, (dir) => {
    const plain = prepare(request(dir, []))
    assert.ok(plain.ok && !plain.spec.ts)
    const asked = prepare({ ...request(dir, []), ts: true })
    assert.ok(asked.ok && asked.spec.ts)
  })
})
