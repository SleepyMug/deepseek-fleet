import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import { Occupancy } from './occupancy.ts'

const root = 'session-root' as SessionId
const other = 'session-other' as SessionId

/** A live agent as the occupancy reads it; `parent` makes it a subagent session. */
function agent(id: string, status: 'idle' | 'running', parent?: SessionId): Agent {
  const header = { id, ...parent === undefined ? {} : { origin: 'subagent', parentSession: parent } }
  return { id, status, session: { header } } as unknown as Agent
}

function setup(agents: Agent[]) {
  const vacated: SessionId[] = []
  const occupancy = new Occupancy({
    agents: () => agents,
    ownerOf: (header: SessionHeader) => {
      if (header.id === 'session-orphan') return undefined
      return (header.parentSession ?? header.id) as SessionId
    },
    vacated: (id) => { vacated.push(id) },
  })
  return { occupancy, vacated }
}

test('a running agent of the session or of its subagents occupies the container as a turn', () => {
  const agents = [agent(root, 'idle'), agent('session-child', 'running', root), agent(other, 'running')]
  const { occupancy } = setup(agents)
  assert.deepEqual(occupancy.of(root), [{ kind: 'turn', id: 'session-child' }])
  assert.deepEqual(occupancy.of(other), [{ kind: 'turn', id: other }])
})

test('an idle agent, or one whose lineage is not loaded, occupies nothing', () => {
  const { occupancy } = setup([agent(root, 'idle'), agent('session-orphan', 'running')])
  assert.deepEqual(occupancy.of(root), [])
})

test('turns are read from the agents each time, not kept', () => {
  const agents = [agent(root, 'running')]
  const { occupancy } = setup(agents)
  assert.equal(occupancy.of(root).length, 1)
  agents.length = 0
  assert.deepEqual(occupancy.of(root), [])
})

test('an occupant held with occupy stays until it is released, and its release reports the vacancy once', () => {
  const { occupancy, vacated } = setup([])
  const release = occupancy.occupy(root, { kind: 'terminal', id: 't1' })
  assert.deepEqual(occupancy.of(root), [{ kind: 'terminal', id: 't1' }])
  assert.deepEqual(occupancy.of(other), [])
  release()
  release()
  assert.deepEqual(occupancy.of(root), [])
  assert.deepEqual(vacated, [root])
})

test('two occupants with the same id do not release each other', () => {
  const { occupancy } = setup([])
  const first = occupancy.occupy(root, { kind: 'call', id: 'same' })
  occupancy.occupy(root, { kind: 'call', id: 'same' })
  first()
  assert.deepEqual(occupancy.of(root), [{ kind: 'call', id: 'same' }])
})

test('an agent that settles reports its root as possibly vacant', () => {
  const { occupancy, vacated } = setup([])
  occupancy.settled(agent('session-child', 'idle', root))
  occupancy.settled(agent('session-orphan', 'idle'))
  assert.deepEqual(vacated, [root])
})
