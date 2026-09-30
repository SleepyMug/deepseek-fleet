import assert from 'node:assert/strict'
import { test } from 'node:test'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { dshHome } from 'fleet-protocol/control'

test('the command finds the home the host serves, which dsh resolves', () => {
  for (const home of [undefined, '', '  ', '~', '~/other', '/srv/dsh/', 'relative/home']) {
    const env = home === undefined ? {} : { DSH_HOME: home }
    assert.equal(dshHome(env), resolveDshHome(undefined, env), `DSH_HOME=${String(home)}`)
  }
})
