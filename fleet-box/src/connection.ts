/**
 * `ctx.ssh` for one session container, standing in for dsh-ssh's
 * `SshConnection` so the upstream SSH filesystem and subprocess providers run
 * unchanged. The dsh-ssh helper runs inside the container through
 * `docker exec`, and requests travel over that exec's stdin and stdout. Each
 * process stream is a Unix socket the helper creates under the container's
 * `/tmp`: the host reaches it through the session's bind-mounted `/tmp`
 * folder, without forwarding, and authenticates it with TLS-PSK. Like
 * `SshConnection`, a connection never reconnects: losing the helper fails
 * every pending operation, and `ended` tells the owner to tear the world down.
 * @module fleet-box/connection
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createConnection, type Socket } from 'node:net'
import { join, posix } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import { SshRpcPeer, SSH_PROTOCOL_VERSION } from '@deepseek-ai/dsh-ssh/protocol'
import { helloSchema, type SshStreamEndpoint } from '@deepseek-ai/dsh-ssh/schemas'
import { z } from 'zod'
import { authenticateStream } from './stream-security.ts'

type Hello = z.infer<typeof helloSchema>

/** dsh-ssh's ceilings for one request or response, and for concurrent requests. */
const MAX_FRAME_BYTES = 64 * 1024 * 1024
const MAX_PENDING = 128
/** Characters of the helper's stderr kept to explain a failed start. */
const STDERR_TAIL = 4096

export interface Config {
  /** Docker CLI executable. */
  docker: string
  /** Name of the running container that runs the helper. */
  container: string
  /** Absolute folder, the same in the container and on the host, that relative paths resolve against. */
  workspace: string
  /** Host folder mounted at the container's `/tmp`, where the helper creates its stream sockets. */
  tmp: string
  /** Node executable inside the container. */
  node: string
  /** Helper entry inside the container. */
  helper: string
  /** SHA-256 of the host's copy of the helper entry; any other helper is refused. */
  helperHash: string
  /** Deadline for the handshake and for every request that is not a process wait. */
  requestTimeoutMs: number
  /** Without a heartbeat for this long, the helper stops everything it started. */
  leaseMs: number
}

export class DockerConnection extends Service {
  /** The helper's handshake; operations wait for it. */
  readonly ready: Promise<Hello>
  /**
   * Settles with what ended the connection when anything but its own teardown
   * did: the helper failed, or dsh's providers gave up on it.
   */
  readonly ended: Promise<Error>

  private readonly config: Config
  private readonly markEnded: (error: Error) => void
  private readonly lifetime = new AbortController()
  private readonly sockets = new Set<Socket>()
  private rpc: SshRpcPeer | undefined
  private child: ChildProcessWithoutNullStreams | undefined
  private childClosed: Promise<void> | undefined
  private heartbeat: NodeJS.Timeout | undefined
  private stderr = ''
  private closed = false
  private failure: Error | undefined
  private closing: Promise<void> | undefined

  constructor(ctx: Context, config: Config) {
    super(ctx, 'ssh')
    this.config = config
    const ended = Promise.withResolvers<Error>()
    this.ended = ended.promise
    this.markEnded = ended.resolve
    this.ready = this.start()
    void this.ready.catch((error: unknown) => { this.fail(asError(error)) })
    ctx.effect(() => () => this.close(), 'fleet-box helper connection')
  }

  /** Keep the providers that use this connection waiting until the helper is verified. */
  async [Service.init](): Promise<void> {
    await this.ready
  }

  /**
   * Send one helper operation; cancellation does not undo an operation the helper already performed.
   * @param method - the helper operation.
   * @param params - request fields, validated by the helper.
   * @param result - validation of the helper's answer.
   * @param signal - cancellation.
   * @param wait - lift the request deadline, for process observations.
   * @returns the validated answer.
   */
  async request<T>(method: string, params: unknown, result: z.ZodType<T>, signal?: AbortSignal, wait = false): Promise<T> {
    this.assertOpen()
    await this.ready
    this.assertOpen()
    const deadline = AbortSignal.timeout(this.config.requestTimeoutMs)
    const bounded = wait ? signal : signal === undefined ? deadline : AbortSignal.any([signal, deadline])
    return (this.rpc as SshRpcPeer).request(method, params, result, bounded)
  }

  /**
   * Connect to one stream socket the helper published, through the host side of the container's `/tmp`.
   * @param endpoint - the socket path in the container and its key.
   * @param signal - cancels the connection and the resulting stream.
   * @returns the authenticated stream, paused; attach a consumer before resuming it.
   */
  async connectStream(endpoint: SshStreamEndpoint, signal?: AbortSignal): Promise<Socket> {
    const hello = await this.ready
    this.assertOpen()
    const combined = signal === undefined ? this.lifetime.signal : AbortSignal.any([signal, this.lifetime.signal])
    combined.throwIfAborted()
    if (!endpoint.path.startsWith(`${hello.root}/`)) throw new Error('fleet-box: the helper returned a stream outside its socket folder')
    const socket = await this.connectSocket(this.hostPath(endpoint.path), combined)
    const authenticated = await authenticateStream(socket, endpoint.capability, this.config.requestTimeoutMs, combined)
    this.track(authenticated)
    authenticated.on('error', () => { authenticated.destroy() })
    return authenticated
  }

  /**
   * What dsh's SSH providers call when they can no longer vouch for the
   * helper, after it did not confirm that a process was stopped: end the
   * connection and report it ended, so its owner tears the world down.
   */
  dispose(): Promise<void> {
    this.fail(new Error('fleet-box: dsh\'s SSH providers gave up on the helper after it did not confirm that a process was stopped'))
    return this.close()
  }

  /** Stop everything the helper started, then end the helper; this service's own teardown, which reports nothing. */
  private close(): Promise<void> {
    this.closing ??= this.closeOnce()
    return this.closing
  }

  private async closeOnce(): Promise<void> {
    this.closed = true
    this.lifetime.abort(new Error('fleet-box: the helper connection is closing'))
    clearInterval(this.heartbeat)
    try {
      await this.ready.catch(() => {})
      if (this.failure === undefined) await this.rpc?.request('close', {}, z.null(), AbortSignal.timeout(this.config.requestTimeoutMs))
    } finally {
      // Ending the exec's stdin ends the helper; the signal only stops the Docker CLI if it lingers.
      this.rpc?.close()
      // TLS streams close before the sockets under them.
      const closures = [...this.sockets].reverse().map(socket => new Promise<void>((resolve) => {
        if (socket.closed) resolve()
        else { socket.once('close', () => { resolve() }); socket.destroy() }
      }))
      this.child?.kill('SIGTERM')
      const force = setTimeout(() => { this.child?.kill('SIGKILL') }, this.config.requestTimeoutMs)
      try { await this.childClosed } finally { clearTimeout(force) }
      await Promise.all(closures)
    }
  }

  private async start(): Promise<Hello> {
    const { docker, container, workspace, node, helper } = this.config
    const child = spawn(docker, ['exec', '--interactive', '--workdir', workspace, container, node, '--disable-sigusr1', helper], {
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.child = child
    this.childClosed = new Promise((resolve) => { child.once('close', () => { resolve() }) })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => { this.stderr = (this.stderr + chunk).slice(-STDERR_TAIL) })
    child.once('error', (error) => { this.fail(error) })
    child.once('close', () => { this.fail(new Error(`fleet-box: the helper in ${container} exited${this.stderrNote()}`)) })
    const rpc = new SshRpcPeer(child.stdout, child.stdin, MAX_FRAME_BYTES, MAX_PENDING)
    this.rpc = rpc
    rpc.once('closed', (error: Error) => { this.fail(error) })

    let hello: Hello
    try {
      hello = await rpc.request('hello', {
        protocol: SSH_PROTOCOL_VERSION, workspace, leaseMs: this.config.leaseMs,
      }, helloSchema, AbortSignal.timeout(this.config.requestTimeoutMs))
    } catch (error) {
      // Docker's or the helper's own message explains a failed start better than the closed pipe.
      await Promise.race([this.childClosed, delay(1000, undefined, { ref: false })])
      if (this.stderr.trim() === '') throw error
      throw new Error(`fleet-box: the helper in ${container} did not start${this.stderrNote()}`, { cause: error })
    }
    if (hello.hash !== this.config.helperHash) {
      throw new Error(`fleet-box: the helper in ${container} differs from the host's @deepseek-ai/dsh-ssh; pin the same version in the image's helper/package.json`)
    }
    this.hostPath(hello.root)

    let pending: Promise<unknown> | undefined
    this.heartbeat = setInterval(() => {
      pending ??= rpc.request('heartbeat', {}, z.null(), AbortSignal.timeout(this.config.leaseMs / 2))
        .catch((error: unknown) => { this.fail(asError(error)) })
        .finally(() => { pending = undefined })
    }, Math.floor(this.config.leaseMs / 3))
    this.heartbeat.unref()
    return hello
  }

  /** The host path of a helper path below the container's `/tmp`. */
  private hostPath(path: string): string {
    const relative = posix.relative('/tmp', path)
    if (posix.normalize(path) !== path || relative === '' || relative === '..' || relative.startsWith('../')) {
      throw new Error(`fleet-box: the helper used ${JSON.stringify(path)}, which is not below the container's /tmp`)
    }
    return join(this.config.tmp, relative)
  }

  private async connectSocket(path: string, signal: AbortSignal): Promise<Socket> {
    const socket = createConnection({ path, allowHalfOpen: true })
    this.track(socket)
    await new Promise<void>((resolve, reject) => {
      const cleanup = (): void => {
        signal.removeEventListener('abort', aborted)
        socket.off('connect', connected)
        socket.off('error', failed)
        socket.off('close', closed)
      }
      const connected = (): void => { cleanup(); resolve() }
      const failed = (error: Error): void => { cleanup(); reject(error) }
      const closed = (): void => { failed(new Error('fleet-box: helper stream closed before it connected')) }
      const aborted = (): void => { socket.destroy(asError(signal.reason)) }
      socket.once('connect', connected)
      socket.once('error', failed)
      socket.once('close', closed)
      signal.addEventListener('abort', aborted, { once: true })
    })
    return socket
  }

  private track(socket: Socket): void {
    this.sockets.add(socket)
    socket.once('close', () => { this.sockets.delete(socket) })
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('fleet-box: the helper connection is closed')
    if (this.failure !== undefined) throw this.failure
  }

  private fail(error: Error): void {
    if (this.failure !== undefined) return
    this.failure = error
    this.lifetime.abort(error)
    clearInterval(this.heartbeat)
    this.rpc?.close(error)
    for (const socket of [...this.sockets].reverse()) socket.destroy(error)
    this.child?.kill('SIGTERM')
    if (!this.closed) this.markEnded(error)
  }

  private stderrNote(): string {
    const text = this.stderr.trim()
    return text === '' ? '' : `: ${text}`
  }
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value))
}

export default DockerConnection
