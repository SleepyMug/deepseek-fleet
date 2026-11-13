/**
 * fleet's gateway, for the tests: a fake of the runs' {@link FleetPort},
 * whose boxes are folders, and whose pipe has dsh-tau's half set a box up
 * and pack its result there.
 * @module @sleepymug/dsh-tau/tau/fake-fleet.test.util
 */

import { createReadStream, createWriteStream } from 'node:fs'
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { Envelope } from '@sleepymug/tau/core'
import type { BoxSpec, BoxState } from '@sleepymug/fleet-protocol/fleet'
import type { Result } from '@sleepymug/dsh-tau-box/runs'
import { pack, setup } from '@sleepymug/dsh-tau-box/box/endpoint'
import { readTauCommand } from '@sleepymug/dsh-tau-box/protocol'
import type { FleetBoxPort, FleetPort } from './ports.ts'

/**
 * What the agent leaves in the box, by path: a file's text, or null for a
 * folder.
 */
export type Left = Record<string, string | null>

/** A failure with a code, as the gateway's client throws one. */
function coded(message: string, code: string): Error {
  return Object.assign(new Error(message), { code })
}

/** A box of the fake gateway's. */
interface FakeBox {
  spec: BoxSpec
  state: BoxState
  occupants: Set<symbol>
  /** To stop as soon as nothing occupies it. */
  soon: boolean
  watchers: Set<(state: BoxState | 'removed') => void>
}

/**
 * The gateway, as a record of what is done with its boxes, failing the
 * verb `failing` names. Each box has its files in a folder of `work`, where
 * its pipe has dsh-tau's half place a call, and pack a result from what
 * `left` says the agent left, or as `tamper` says, in place of that. A box
 * starts as a lease or a pipe asks for it; what stops it is a stop, or a
 * stop when vacant once nothing occupies it.
 */
export class FakeFleet implements FleetPort {
  readonly calls: string[] = []
  readonly made = new Map<string, FakeBox>()
  failing: string | undefined
  left: Left
  tamper: ((outcome: Result, files: Envelope['files']) => AsyncIterable<Uint8Array>) | undefined
  /** How a process a box spawns, such as a run's init, ends, after writing what it writes: by default at once, with 0, writing nothing. */
  spawn: (params: { argv: string[]; cwd: string }, write: (stream: 'stdout' | 'stderr', text: string) => void) => Promise<{ code: number | null; signal: string | null }> =
    async () => ({ code: 0, signal: null })
  /** What a box's `kill` of a process does, besides being recorded. */
  kill: () => void = () => {}
  private made_ = 0

  constructor(private readonly work: string, left: Left = {}) {
    this.left = { ...left }
  }

  /** Where a box has its files. */
  root(id: string): string {
    return join(this.work, 'boxes', id)
  }

  async create(spec: BoxSpec): Promise<string> {
    const id = `box-${(++this.made_).toString(16).padStart(16, '0')}`
    this.record('create', `create ${id}`)
    this.made.set(id, { spec, state: 'stopped', occupants: new Set(), soon: false, watchers: new Set() })
    await mkdir(this.root(id), { recursive: true })
    return id
  }

  async services(): Promise<never[]> {
    return []
  }

  /** As if someone removed a box's container by other means. */
  lose(id: string): void {
    this.made.delete(id)
  }

  box(id: string): FleetBoxPort {
    const fleet = this
    const known = (gone = 'NO_BOX'): FakeBox => {
      const box = this.made.get(id)
      if (box === undefined) throw coded(`no box ${id}`, gone)
      return box
    }
    const set = (box: FakeBox, state: BoxState): void => {
      box.state = state
      for (const watcher of box.watchers) watcher(state)
    }
    const start = (box: FakeBox): void => {
      if (box.state === 'started') return
      fleet.record('start', 'start')
      set(box, 'started')
    }
    const stop = (box: FakeBox): void => {
      fleet.record('stop', 'stop')
      box.soon = false
      set(box, 'stopped')
    }
    return {
      id,
      async request(method, params, options = {}) {
        const box = known()
        if (options.hold !== false) start(box)
        fleet.record(method, `${method} ${JSON.stringify(params)}`)
        if (method === 'spawn') {
          return await fleet.spawn(params as { argv: string[]; cwd: string }, (stream, text) => {
            options.onEvent?.({ stream, data: Buffer.from(text).toString('base64') } as never)
          }) as never
        }
        if (method === 'kill') fleet.kill()
        return { code: 0, signal: null, stdout: '', stderr: '' } as never
      },
      async lease(_occupant, { start: starting = true } = {}) {
        const box = known('BOX_GONE')
        if (starting) start(box)
        const token = Symbol('lease')
        box.occupants.add(token)
        return async () => {
          if (!box.occupants.delete(token)) return
          if (box.occupants.size === 0 && box.soon && fleet.made.get(id) === box) stop(box)
        }
      },
      watch(listener) {
        const box = fleet.made.get(id)
        listener(box?.state ?? 'removed')
        box?.watchers.add(listener)
        return () => { box?.watchers.delete(listener) }
      },
      async start() { start(known('BOX_GONE')) },
      async stop() { stop(known()) },
      async stopWhenVacant() {
        const box = known()
        if (box.occupants.size === 0) stop(box)
        else box.soon = true
      },
      async remove() {
        const box = known()
        fleet.record('remove', 'remove')
        fleet.made.delete(id)
        for (const watcher of box.watchers) watcher('removed')
        await rm(fleet.root(id), { recursive: true, force: true })
      },
      async copyIn(from, to) {
        known()
        fleet.record('copyIn', `copyIn ${from} ${to}`)
        await cp(from, join(fleet.root(id), to), { recursive: true })
      },
      async pipe(argv, io = {}) {
        start(known('BOX_GONE'))
        const command = readTauCommand(argv.slice(2))
        fleet.record('pipe', `pipe ${command.command}`)
        const root = fleet.root(id)
        if (command.command === 'setup') {
          return JSON.stringify(await setup(createReadStream(io.input as string), root))
        }
        const { outcome } = command
        const { files } = JSON.parse(await readFile(join(root, '/tau/.run.json'), 'utf8')) as { files: Envelope['files'] }
        for (const [path, text] of Object.entries(fleet.left).sort(([a], [b]) => a.localeCompare(b))) {
          const at = join(root, path)
          if (text === null) await mkdir(at, { recursive: true })
          else await mkdir(dirname(at), { recursive: true }).then(() => writeFile(at, text))
        }
        await pipeline(Readable.from(fleet.tamper?.(outcome, files) ?? await pack(outcome, root)), createWriteStream(io.output as string))
        return ''
      },
      async exec(argv) {
        known()
        fleet.record('exec', `exec ${argv.join(' ')}`)
        return ''
      },
    }
  }

  private record(verb: string, call: string): void {
    this.calls.push(call)
    if (verb === this.failing) throw new Error(`${verb} failed`)
  }
}

