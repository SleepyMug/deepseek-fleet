import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { test } from 'node:test'
import { declarations, implementation } from 'fleet-image/apis/registry'
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

const request = (agent: string, args: string[], bind = true, backends: string[] = []): PrepareRequest =>
  ({ agent, args, bind, callerCwd: '/caller', sessionFolder: '/session', env: {}, backends, dshHome: '/dsh' })

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
    'tau.json': '{"args": [{"name": "src", "type": "dir", "role": "share"}], "env": ["FLEET_SOCKET", "LANG", "NODE_OPTIONS", "LD_PRELOAD"]}',
    'skills/bad/SKILL.md': 'no frontmatter',
  }, (dir) => {
    const prepared = prepare(request(dir, []))
    assert.ok(!prepared.ok)
    assert.equal(prepared.problems.length, 3)
    assert.match(prepared.problems[0]!, /env lists FLEET_SOCKET, NODE_OPTIONS, LD_PRELOAD, which the container keeps as its own/u)
    assert.match(prepared.problems[1]!, /expected 1 argument/u)
    assert.match(prepared.problems[2]!, /bad\/SKILL\.md/u)
  })
})

test('path arguments are bound where the container shows them, and variables as the caller has them', async () => {
  const outside = await mkdtemp(join(tmpdir(), 'fleet-tau-outside-'))
  try {
    await mkdir(join(outside, 'src'))
    await withAgent({
      'PROMPT.md': 'Edit ${src} into ${report} with ${rules}',
      'tau.json': JSON.stringify({
        args: [{ name: 'src', type: 'dir', role: 'share' }, { name: 'report', type: 'file', role: 'out' }, { name: 'rules', type: 'file', role: 'in' }],
        env: ['LANG', 'UNSET'],
      }),
    }, (dir) => {
      const args = [join(outside, 'src'), join(outside, 'report.md'), join(dir, 'PROMPT.md')]
      const prepared = prepare({ ...request(dir, args), env: { LANG: 'C.UTF-8' } })
      assert.ok(prepared.ok, JSON.stringify(prepared))
      assert.deepEqual(prepared.spec.env, { LANG: 'C.UTF-8' })
      assert.deepEqual(prepared.spec.paths.map(({ name, type, role, host, view }) => [name, type, role, host, view]), [
        ['src', 'dir', 'share', join(outside, 'src'), join(outside, 'src')],
        ['report', 'file', 'out', join(outside, 'report.md'), '/tau/out/report/report.md'],
        ['rules', 'file', 'in', join(dir, 'PROMPT.md'), '/tau/in/rules/PROMPT.md'],
      ])
      assert.equal(prepared.spec.prompt, `Edit ${join(outside, 'src')} into /tau/out/report/report.md with /tau/in/rules/PROMPT.md`)
      // The session folder may hold any of them, but a share path may not hold the session folder, nor any path the dsh home.
      assert.ok(prepare({ ...request(dir, args), sessionFolder: outside }).ok)
      const holding = prepare({ ...request(dir, args), sessionFolder: join(outside, 'src', 'sub'), dshHome: dir })
      assert.ok(!holding.ok)
      assert.deepEqual(holding.problems.map(problem => problem.split(':')[0]), ['src', 'rules'])
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

test('each API is linked to fleet\'s implementation of its name, whose backends must be provided', async () => {
  const notes = implementation('notes')
  assert.ok(notes !== undefined)
  // What `fleet apis notes` prints, for the tau to copy.
  await withAgent({ 'PROMPT.md': 'Take notes.', 'api/notes.d.ts': declarations(notes), 'api/text-stats.d.ts': 'export declare function wordFrequencies(text: string): Record<string, number>;\n' }, (dir) => {
    const missing = prepare(request(dir, []))
    assert.ok(!missing.ok)
    assert.deepEqual(missing.problems, ['@api/notes: fleet\'s implementation calls the backend notes, which no fleet plugin provides now'])
    const prepared = prepare(request(dir, [], true, ['notes']))
    assert.ok(prepared.ok, JSON.stringify(prepared))
    assert.deepEqual(prepared.spec.apis.map(({ name, backends }) => [name, backends]), [['notes', ['notes']], ['text-stats', []]])
    // The agent's own description of each, if it gives one.
    assert.match(prepared.spec.apis[0]?.description ?? '', /^A notebook of short notes/u)
    assert.equal(prepared.spec.apis[1]?.description, undefined)
  })
})

test('an API fleet does not implement, one its implementation does not fit, and one tau refuses are problems', async () => {
  await withAgent({
    'PROMPT.md': 'x',
    'api/weather.d.ts': 'export declare function forecast(city: string): Promise<string>;\n',
    // Asks for a result the implementation does not give.
    'api/text-stats.d.ts': 'export declare function wordFrequencies(text: string): string[];\n',
  }, (dir) => {
    const prepared = prepare(request(dir, []))
    assert.ok(!prepared.ok)
    assert.equal(prepared.problems.length, 2)
    assert.match(prepared.problems[0]!, /does not implement @api\/text-stats/u)
    assert.equal(prepared.problems[1], '@api/weather: fleet has no implementation of it; `fleet apis` lists the ones it has')
  })
  await withAgent({ 'PROMPT.md': 'x', 'api/bad.d.ts': 'export declare function f(): Promise<Missing>;\n' }, (dir) => {
    const prepared = prepare(request(dir, []))
    assert.ok(!prepared.ok)
    assert.match(prepared.problems[0]!, /its APIs break the spec:[^]*Missing/u)
  })
})
