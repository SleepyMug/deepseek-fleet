/**
 * Boxes as folders on this machine (./driver.ts), for tests, and for
 * trying fleet out without Docker: each box's "container" is its folder,
 * which roots its layout, and the helper as built, run on this machine's
 * Node, as the process the box runs while it is started. Nothing isolates
 * such a box: its programs run as whoever runs the gateway.
 * @module @sleepymug/fleet/boxes/local
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { mkdir, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { BOX_VARIABLE, GATEWAY_VARIABLE, ROOT_VARIABLE } from '@sleepymug/fleet-protocol/layout'
import type { BoxDriver, ContainerSpec, ContainerState } from './driver.ts'

/** The helper's program, as fleet-box is built beside this package. */
const HELPER = join(dirname(createRequire(import.meta.url).resolve('@sleepymug/fleet-box/package.json')), 'lib', 'helper', 'main.js')

interface LocalBox {
  spec: ContainerSpec
  root: string
  process?: ChildProcess
}

export interface LocalOptions {
  /** The folder the boxes' folders are in. */
  dir: string
  /** The gateway's socket for boxes, which each helper dials. */
  gatewaySocket: string
  /** Where each helper's stderr goes; nowhere without it. */
  log?: (message: string) => void
}

export class LocalDriver implements BoxDriver {
  private readonly boxes = new Map<string, LocalBox>()

  constructor(private readonly options: LocalOptions) {}

  /** The folder a box's layout is rooted at. */
  root(id: string): string {
    return join(this.options.dir, id)
  }

  async create(spec: ContainerSpec): Promise<void> {
    const root = this.root(spec.id)
    await mkdir(root, { recursive: true })
    this.boxes.set(spec.id, { spec, root })
  }

  async start(id: string): Promise<void> {
    const box = this.find(id)
    if (box.process !== undefined) return
    const child = spawn(process.execPath, [HELPER], {
      env: { ...box.spec.env, PATH: box.spec.env.PATH ?? process.env.PATH ?? '', [GATEWAY_VARIABLE]: this.options.gatewaySocket, [BOX_VARIABLE]: id, [ROOT_VARIABLE]: box.root },
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => { this.options.log?.(`${id}: ${chunk.trimEnd()}`) })
    box.process = child
    child.once('exit', () => { if (box.process === child) box.process = undefined })
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve)
      child.once('error', reject)
    })
  }

  async stop(id: string): Promise<void> {
    const child = this.boxes.get(id)?.process
    if (child === undefined) return
    const exited = new Promise<void>((resolve) => { child.once('exit', () => { resolve() }) })
    child.kill('SIGTERM')
    await exited
  }

  async remove(id: string): Promise<void> {
    await this.stop(id)
    await rm(this.root(id), { recursive: true, force: true })
    this.boxes.delete(id)
  }

  async state(id: string): Promise<ContainerState> {
    const box = this.boxes.get(id)
    if (box === undefined) return 'missing'
    return box.process === undefined ? 'stopped' : 'running'
  }

  /** As if a box's container were removed by other means. */
  async lose(id: string): Promise<void> {
    await this.remove(id)
  }

  private find(id: string): LocalBox {
    const box = this.boxes.get(id)
    if (box === undefined) throw new Error(`fleet: no container for ${id}`)
    return box
  }
}
