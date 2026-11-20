/**
 * Boxes as Docker containers (./driver.ts), through the Docker CLI: each
 * named by its box's id, labelled `fleet.box`, its creator's labels as
 * `fleet.label.<key>`, with an init as its first process, so that the
 * helper, its command, is told of the stop that `docker stop` sends, and
 * the folder of the gateway's socket for boxes mounted, which the helper
 * dials.
 * @module @sleepymug/fleet/boxes/docker
 */

import { execFile } from 'node:child_process'
import { BOX_LAYOUT, GATEWAY_SOCKET, GATEWAY_VARIABLE, HELPER_ENTRY, HELPER_NODE, TOKEN_VARIABLE } from '@sleepymug/fleet-protocol/layout'
import type { BoxDriver, ContainerSpec, ContainerState } from './driver.ts'

/** The label every box's container carries. */
export const BOX_LABEL = 'fleet.box'

export interface DockerOptions {
  /** The folder of the gateway's socket for boxes, which each box mounts. */
  gatewayDir: string
  /** The Docker CLI; `docker` without it. */
  docker?: string
}

export class DockerDriver implements BoxDriver {
  private readonly docker: string

  constructor(private readonly options: DockerOptions) {
    this.docker = options.docker ?? 'docker'
  }

  async create({ id, image, env, labels, token }: ContainerSpec): Promise<void> {
    const environment = { ...env, [GATEWAY_VARIABLE]: `${BOX_LAYOUT.gatewayDir}/${GATEWAY_SOCKET}` }
    // The token from Docker's own environment, so that it is on no command line.
    await this.run([
      'create', '--init', '--pull', 'never', '--name', id, '--label', BOX_LABEL,
      ...Object.entries(labels).flatMap(([key, value]) => ['--label', `fleet.label.${key}=${value}`]),
      ...Object.entries(environment).flatMap(([key, value]) => ['--env', `${key}=${value}`]),
      '--env', TOKEN_VARIABLE,
      '--mount', `type=bind,source=${this.options.gatewayDir},target=${BOX_LAYOUT.gatewayDir}`,
      image, HELPER_NODE, HELPER_ENTRY,
    ], { [TOKEN_VARIABLE]: token })
  }

  async start(id: string): Promise<void> {
    await this.run(['start', id])
  }

  async stop(id: string): Promise<void> {
    await this.run(['stop', id])
  }

  async remove(id: string): Promise<void> {
    await this.run(['rm', '--force', id])
  }

  async state(id: string): Promise<ContainerState> {
    try {
      const running = await this.run(['container', 'inspect', '--format', '{{.State.Running}}', id])
      return running === 'true' ? 'running' : 'stopped'
    } catch (error) {
      if (/no such (?:object|container)/iu.test(String((error as Error).message))) return 'missing'
      throw error
    }
  }

  /** Run the Docker CLI with `args`, and with `env` added to its environment. */
  private run(args: string[], env: Record<string, string> = {}): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile(this.docker, args, { env: { ...process.env, ...env } }, (error, stdout, stderr) => {
        if (error === null) resolve(stdout.trim())
        else reject(new Error(`fleet: docker ${args[0]} failed: ${stderr.trim() || error.message}`, { cause: error }))
      })
    })
  }
}
