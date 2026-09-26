import assert from 'node:assert/strict'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { dshHome, lineReader } from './protocol.ts'

test('lines split across and within chunks', () => {
  const lines: string[] = []
  const read = lineReader((line) => { lines.push(line) }, 1024)
  read(Buffer.from('{"a":1}\n{"b"'))
  read(Buffer.from(':2}\n'))
  read(Buffer.from('{"c":3}\n{"d":4}\n'))
  assert.deepEqual(lines, ['{"a":1}', '{"b":2}', '{"c":3}', '{"d":4}'])
})

test('a multi-byte character split across chunks survives', () => {
  const lines: string[] = []
  const read = lineReader((line) => { lines.push(line) }, 1024)
  const bytes = Buffer.from('é\n')
  read(bytes.subarray(0, 1))
  read(bytes.subarray(1))
  assert.deepEqual(lines, ['é'])
})

test('an overlong line is refused', () => {
  const read = lineReader(() => {}, 4)
  assert.throws(() => { read(Buffer.from('12345')) }, /longer than 4 bytes/u)
})

test('the dsh home follows DSH_HOME as dsh does', () => {
  assert.equal(dshHome({}), join(homedir(), '.dsh'))
  assert.equal(dshHome({ DSH_HOME: '  ' }), join(homedir(), '.dsh'))
  assert.equal(dshHome({ DSH_HOME: '~/other' }), join(homedir(), 'other'))
  assert.equal(dshHome({ DSH_HOME: '/srv/dsh/' }), '/srv/dsh')
})

test('the command finds the home the host serves, which dsh resolves', () => {
  for (const home of [undefined, '', '  ', '~', '~/other', '/srv/dsh/', 'relative/home']) {
    const env = home === undefined ? {} : { DSH_HOME: home }
    assert.equal(dshHome(env), resolveDshHome(undefined, env), `DSH_HOME=${String(home)}`)
  }
})
