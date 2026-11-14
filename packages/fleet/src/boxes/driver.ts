/**
 * Where a box's container is: what makes, starts, stops and removes it,
 * and says whether it runs. A container runs the helper as its command,
 * told the gateway's socket and its box's id, so the helper dials the
 * gateway once it starts; the driver knows nothing else of the helper.
 * Docker's (./docker.ts) by default; a box that is a folder on this
 * machine, for tests and for trying fleet out (./local.ts).
 * @module @sleepymug/fleet/boxes/driver
 */

/** What a driver makes a box's container with. */
export interface ContainerSpec {
  /** The box's id, which names its container. */
  id: string
  image: string
  /** The environment of every process in it. */
  env: Readonly<Record<string, string>>
  labels: Readonly<Record<string, string>>
}

/** Where a container is in its life, as its driver knows it. */
export type ContainerState = 'running' | 'stopped' | 'missing'

export interface BoxDriver {
  /** Make a box's container, stopped. */
  create(spec: ContainerSpec): Promise<void>
  /** Start a box's container, whose helper then dials the gateway. */
  start(id: string): Promise<void>
  /** Stop a box's container, which ends its helper and everything it ran, and keeps what is in it. */
  stop(id: string): Promise<void>
  /** Remove a box's container, running or not. */
  remove(id: string): Promise<void>
  state(id: string): Promise<ContainerState>
  /** End what the driver runs itself, for a driver whose containers cannot outlive it; one whose containers do outlive it has none. */
  close?(): Promise<void>
}
