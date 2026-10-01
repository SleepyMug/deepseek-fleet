import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { linksLeaving } from './children.ts'

test('a copied agent directory may hold symlinks that stay inside it, and no other', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fleet-tau-children-'))
  try {
    const agent = join(dir, 'agent')
    await mkdir(join(agent, 'shared', 'shout'), { recursive: true })
    await mkdir(join(agent, 'skills'))
    await writeFile(join(dir, 'secret'), 'the host\'s')
    await symlink(join('..', 'shared', 'shout'), join(agent, 'skills', 'shout'))
    await symlink('missing', join(agent, 'dangling'))
    await symlink('/etc/passwd', join(agent, 'absolute'))
    await symlink(join('..', 'secret'), join(agent, 'up'))
    await symlink(join('..', 'nowhere'), join(agent, 'up-dangling'))
    // Inside as written, but `here/..` leaves it where it leads.
    await symlink('.', join(agent, 'here'))
    await symlink('here/../secret', join(agent, 'through'))
    // A chain of links that stays inside, through a folder another link leads to.
    await symlink(join('skills', 'shout'), join(agent, 'via'))
    await symlink('via/../../shared', join(agent, 'back'))
    assert.deepEqual(await linksLeaving(agent), ['absolute', 'through', 'up', 'up-dangling'])
    // A copy that is no folder, as of an agent directory that led nowhere, is refused, its link never followed.
    await symlink(join(dir, 'secret'), join(dir, 'not-a-folder'))
    await assert.rejects(linksLeaving(join(dir, 'not-a-folder')), /not a directory/u)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
