import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { loadSkills, parseSkill } from './skills.ts'

async function withFiles(files: Record<string, string>, check: (dir: string) => void | Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'fleet-tau-skills-'))
  try {
    for (const [path, text] of Object.entries(files)) {
      await mkdir(dirname(join(dir, path)), { recursive: true })
      await writeFile(join(dir, path), text)
    }
    await check(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

const skill = (name: string, extra = ''): string => `---\nname: ${name}\ndescription: Does ${name}.\n${extra}---\n\nBody of ${name}.\n`

test('a SKILL.md gives its name, description, flags and trimmed body', () => {
  assert.deepEqual(parseSkill(skill('shout', 'whenToUse: When greeting.\n')), {
    name: 'shout', description: 'Does shout.', whenToUse: 'When greeting.', modelInvocable: true, userInvocable: true, content: 'Body of shout.',
  })
  const flagged = parseSkill(skill('quiet', 'disable-model-invocation: "yes"\nuser-invocable: off\n'))
  assert.equal(flagged.modelInvocable, false)
  assert.equal(flagged.userInvocable, false)
})

test('a SKILL.md that dsh would skip is refused, saying why', () => {
  assert.throws(() => parseSkill('no frontmatter'), /frontmatter/u)
  assert.throws(() => parseSkill('---\nname: x\n'), /frontmatter/u)
  assert.throws(() => parseSkill('---\ndescription: d\n---\n'), /name and a description/u)
  assert.throws(() => parseSkill(skill('Not_Kebab')), /kebab-case/u)
  assert.throws(() => parseSkill(skill('x', 'userInvocable: false\n')), /user-invocable/u)
  assert.throws(() => parseSkill(skill('x', 'user-invocable: maybe\n')), /must be a boolean/u)
  assert.throws(() => parseSkill('---\n[1, 2\n---\n'), /YAML/u)
})

test('skills are the folders holding a SKILL.md, at any depth, not searched further', async () => {
  await withFiles({
    'skills/b/SKILL.md': skill('b'),
    'skills/a/SKILL.md': skill('a'),
    'skills/a/inner/SKILL.md': skill('inner'),
    'skills/group/c/SKILL.md': skill('c'),
    'skills/.hidden/SKILL.md': skill('hidden'),
    'skills/notes.txt': 'not a skill',
  }, (dir) => {
    const { skills, problems } = loadSkills(dir)
    assert.deepEqual(problems, [])
    assert.deepEqual(skills.map(({ name, dir: folder }) => [name, folder]), [['a', 'a'], ['b', 'b'], ['c', 'group/c']])
  })
})

test('a skills folder that is itself a skill, no skills folder, and broken or clashing skills', async () => {
  await withFiles({ 'skills/SKILL.md': skill('whole') }, (dir) => {
    assert.deepEqual(loadSkills(dir).skills.map(({ dir: folder }) => folder), ['.'])
  })
  await withFiles({ 'PROMPT.md': 'hi' }, (dir) => { assert.deepEqual(loadSkills(dir), { skills: [], problems: [] }) })
  await withFiles({ 'skills/a/SKILL.md': skill('same'), 'skills/b/SKILL.md': skill('same'), 'skills/c/SKILL.md': 'broken' }, (dir) => {
    const { problems } = loadSkills(dir)
    assert.equal(problems.length, 2)
    assert.match(problems[0]!, /c\/SKILL\.md: .*frontmatter/u)
    assert.match(problems[1]!, /a and b are both named same/u)
  })
})

test('a symlink back up the tree, or a broken one, ends the walk there with a problem at most', async () => {
  await withFiles({ 'skills/a/SKILL.md': skill('a'), 'skills/group/b/SKILL.md': skill('b') }, async (dir) => {
    await symlink(join(dir, 'skills'), join(dir, 'skills', 'group', 'loop'))
    await symlink(join(dir, 'nowhere'), join(dir, 'skills', 'broken'))
    await symlink(join(dir, 'skills', 'cycle'), join(dir, 'skills', 'cycle'))
    const { skills, problems } = loadSkills(dir)
    assert.deepEqual(skills.map(({ name }) => name), ['a', 'b'])
    assert.equal(problems.length, 2)
    assert.match(problems.join('\n'), /broken: ENOENT/u)
    assert.match(problems.join('\n'), /cycle: ELOOP/u)
  })
})
