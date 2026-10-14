import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { test } from 'node:test'
import { dshPackages } from './dsh.ts'

/** Write `files` (path → contents; objects become JSON) under a fresh folder, and check what `check` finds there. */
async function withTree(files: Record<string, string | object>, check: (root: string) => Promise<void>): Promise<void> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'fleet-box-runtime-dsh-')))
  try {
    for (const [path, contents] of Object.entries(files)) {
      await mkdir(dirname(join(root, path)), { recursive: true })
      await writeFile(join(root, path), typeof contents === 'string' ? contents : JSON.stringify(contents))
    }
    await check(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

/** dsh's package at `dir`, which depends on a, and on c, which a has a version of its own of; a has b as its peer. */
function install(dir: string): Record<string, string | object> {
  return {
    [`${dir}/package.json`]: { name: '@deepseek-ai/dsh', version: '1.0.0', dependencies: { a: '1', c: '1' } },
    [`${dir}/lib/package.json`]: { type: 'module' },
    [`${dir}/lib/bin.js`]: '',
    [`${dir}/node_modules/a/package.json`]: { name: 'a', version: '1.0.0', dependencies: { c: '2' }, peerDependencies: { b: '1' } },
    [`${dir}/node_modules/a/node_modules/c/package.json`]: { name: 'c', version: '2.0.0' },
    [`${dir}/node_modules/b/package.json`]: { name: 'b', version: '1.0.0' },
    [`${dir}/node_modules/c/package.json`]: { name: 'c', version: '1.0.0' },
  }
}

test('dsh is found from npm\'s link to its bin, or pnpm\'s shim, and gives what its install has, the first found of each name', async () => {
  const dsh = 'lib/node_modules/@deepseek-ai/dsh'
  await withTree({ ...install(dsh), 'pnpm/bin/dsh': `#!/bin/sh\nexec node "$basedir/../../${dsh}/lib/bin.js" "$@"\n# cmd-shim-target=../../${dsh}/lib/bin.js\n` }, async (root) => {
    const expected = new Map([
      ['@deepseek-ai/dsh', join(root, dsh)],
      ['a', join(root, dsh, 'node_modules/a')],
      ['c', join(root, dsh, 'node_modules/c')],
      ['b', join(root, dsh, 'node_modules/b')],
    ])
    await chmod(join(root, dsh, 'lib/bin.js'), 0o755)
    await mkdir(join(root, 'npm/bin'), { recursive: true })
    await symlink(join('../..', dsh, 'lib/bin.js'), join(root, 'npm/bin/dsh'))
    assert.deepEqual(await dshPackages(join(root, 'npm/bin')), expected)

    await chmod(join(root, 'pnpm/bin/dsh'), 0o755)
    assert.deepEqual(await dshPackages(join(root, 'pnpm/bin')), expected)
    // A global shim names its bin by its absolute path.
    await writeFile(join(root, 'pnpm/bin/dsh'), `#!/bin/sh\n# cmd-shim-target=${join(root, dsh, 'lib/bin.js')}\n`)
    assert.deepEqual(await dshPackages(['', join(root, 'nowhere'), join(root, 'pnpm/bin')].join(delimiter)), expected)
  })
})

test('no dsh is found where the first dsh on the PATH is no install of it', async () => {
  await withTree({ 'bin/dsh': '#!/bin/sh\n', 'other/bin/dsh': '', ...install('lib/dsh') }, async (root) => {
    await chmod(join(root, 'bin/dsh'), 0o755)
    await chmod(join(root, 'lib/dsh/lib/bin.js'), 0o755)
    await mkdir(join(root, 'npm/bin'), { recursive: true })
    await symlink(join(root, 'lib/dsh/lib/bin.js'), join(root, 'npm/bin/dsh'))
    assert.equal(await dshPackages(''), undefined)
    assert.equal(await dshPackages(join(root, 'other/bin')), undefined, 'a file that is not executable is not the command')
    assert.equal(await dshPackages([join(root, 'bin'), join(root, 'npm/bin')].join(delimiter)), undefined, 'the dsh that runs is the first')
  })
})
