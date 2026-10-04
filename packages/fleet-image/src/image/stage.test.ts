import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { test } from 'node:test'
import { stagePackage } from './stage.ts'

/** Write `files` (path → contents; objects become JSON) under a fresh folder, and check what `check` finds there. */
async function withTree(files: Record<string, string | object>, check: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'fleet-image-stage-'))
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

/** The version of `name` that Node resolves from `from`. */
function versionFrom(from: string, name: string): string {
  const manifest = createRequire(from).resolve(`${name}/package.json`)
  return (JSON.parse(readFileSync(manifest, 'utf8')) as { version: string }).version
}

/** The files under `dir`, relative to it, sorted. */
async function filesUnder(dir: string): Promise<string[]> {
  return (await readdir(dir, { recursive: true, withFileTypes: true }))
    .filter(entry => !entry.isDirectory())
    .map(entry => relative(dir, join(entry.parentPath, entry.name)))
    .sort()
}

test('each package is copied once, linked to exactly the instances it resolved where installed', async () => {
  // npm's layout: a nests its own c@2 while @s/b gets the hoisted c@1, and b's
  // peer a is found above it. Optional dependencies that are missing or for
  // another platform are left out.
  await withTree({
    'app/package.json': {
      name: 'app', version: '0.0.0', files: ['lib'],
      dependencies: { a: '1', '@s/b': '1' }, optionalDependencies: { absent: '1', 'for-darwin': '1' },
    },
    'app/lib/main.js': '',
    'app/src/main.ts': '',
    'app/node_modules/a/package.json': { name: 'a', version: '1.0.0', dependencies: { c: '2' } },
    'app/node_modules/a/node_modules/c/package.json': { name: 'c', version: '2.0.0' },
    'app/node_modules/@s/b/package.json': {
      name: '@s/b', version: '1.0.0', dependencies: { c: '1' },
      peerDependencies: { a: '1', zod: '3' }, peerDependenciesMeta: { zod: { optional: true } },
    },
    'app/node_modules/c/package.json': { name: 'c', version: '1.0.0' },
    'app/node_modules/for-darwin/package.json': { name: 'for-darwin', version: '1.0.0', os: ['darwin'] },
    'app/node_modules/unrelated/package.json': { name: 'unrelated', version: '1.0.0' },
  }, async (root) => {
    const target = join(root, 'staged')
    await stagePackage(join(root, 'app'), target, process.arch)

    assert.ok(existsSync(join(target, 'lib/main.js')))
    assert.ok(!existsSync(join(target, 'src')), 'a source tree is copied as published')
    assert.ok(!existsSync(join(target, 'node_modules/.store/a@1.0.0/node_modules/a/node_modules')))
    assert.ok(!existsSync(join(target, 'node_modules/.store/unrelated@1.0.0')), 'only what is depended on')
    assert.ok(!existsSync(join(target, 'node_modules/.store/for-darwin@1.0.0')))

    const main = join(target, 'lib/main.js')
    const a = createRequire(main).resolve('a/package.json')
    const b = createRequire(main).resolve('@s/b/package.json')
    assert.equal(versionFrom(a, 'c'), '2.0.0')
    assert.equal(versionFrom(b, 'c'), '1.0.0')
    assert.equal(versionFrom(b, 'a'), '1.0.0')
    assert.throws(() => versionFrom(main, 'c'), /Cannot find module/, 'nothing undeclared is reachable')
  })
})

test('a source tree is copied as pnpm packs it, less what its files exclude', async () => {
  await withTree({
    'app/package.json': { name: 'app', version: '0.0.0', files: ['lib', '!lib/**/*.test.*'], main: 'main.js', bin: { app: 'bin/app.js' } },
    'app/README.md': '',
    'app/License.txt': '',
    'app/CHANGELOG.md': '',
    'app/main.js': '',
    'app/bin/app.js': '',
    'app/lib/index.js': '',
    'app/lib/index.test.js': '',
    'app/lib/sub/deep.js': '',
    'app/lib/sub/deep.test.d.ts': '',
    'app/src/index.ts': '',
  }, async (root) => {
    await mkdir(join(root, 'app/lib/empty'))
    const target = join(root, 'staged')
    await stagePackage(join(root, 'app'), target, process.arch)
    assert.deepEqual(await filesUnder(target), ['License.txt', 'README.md', 'bin/app.js', 'lib/index.js', 'lib/sub/deep.js', 'main.js', 'package.json'])
    assert.ok(!existsSync(join(target, 'lib/empty')), 'packing holds files, not folders')
  })
})

test('what cannot be copied faithfully is refused', async () => {
  const refused = (manifest: object, extra: Record<string, string | object>, arch: string, message: RegExp): Promise<void> => withTree(
    { 'app/package.json': { name: 'app', version: '0.0.0', files: ['lib'], ...manifest }, 'app/lib/main.js': '', ...extra },
    root => assert.rejects(stagePackage(join(root, 'app'), join(root, 'staged'), arch), message),
  )
  await refused({ dependencies: { gone: '1' } }, {}, process.arch, /depends on gone, which is not installed/u)
  await refused({ files: undefined }, {}, process.arch, /without "files"/u)
  await refused({ files: ['lib/*.js'] }, {}, process.arch, /is a pattern/u)
  await refused({ files: ['dist'] }, {}, process.arch, /dist, listed in its "files", does not exist; build the package first/u)
  const other = process.arch === 'arm64' ? 'x64' : 'arm64'
  await refused({}, {}, other, new RegExp(`installed for linux-${process.arch}, and the image is linux-${other}`, 'u'))
  await refused(
    { dependencies: { native: '1' } },
    { 'app/node_modules/native/package.json': { name: 'native', version: '1.0.0', libc: ['musl'] } },
    process.arch, /native@1.0.0 is not for the image's platform/u,
  )
})
