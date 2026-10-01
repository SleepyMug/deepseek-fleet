/**
 * Runs of taus started inside a session's container. fleet's implementation
 * of the `tau` API (fleet-image's apis/tau/), which programs import as
 * `@api/tau` and the container's `tau` command runs, calls the `tau` backend
 * here, which runs the tau as a child of the calling session's agent: a
 * one-shot dsh subagent, which the web UI shows under it, started through
 * this module's subagent provider in a container of its own (fleet-box's
 * world.ts), which mounts nothing. The call names no project: the run
 * belongs to its caller's, which it takes with dsh's other fields of a
 * child's session, so a fork of it belongs there too. As any run, it gets
 * its agent's skills, APIs and TypeScript tools (./agent.ts), so its
 * programs may run taus of their own.
 *
 * The caller's container is the model's, so nothing the call names is read
 * on the host: the agent directory is copied out of the container through
 * its helper, with its symlinks, and refused if one leads out of it, before
 * fleet-tau reads it as it reads any (./prepare.ts); the `in` paths are
 * copied out the same way, and the `out` paths copied back into the caller's
 * container once the run completes (./store.ts). A `share` path would name
 * the caller's files in its container, which no other container can mount,
 * so a procedural tau is refused.
 *
 * The call waits for the run, however long it takes. The program going
 * away, as when the tool call that ran it is cancelled, cancels the run, as
 * the cancellation of its caller cancels any subagent. Once the run ends, its
 * container is stopped, and kept until the caller's session is archived,
 * which removes it; the run's session and its folder in the store stay, as
 * any session's do.
 * @module fleet-core/tau/children
 */

import { randomUUID } from 'node:crypto'
import { lstat, mkdir, mkdtemp, readdir, readlink, rm } from 'node:fs/promises'
import { dirname, isAbsolute, join, posix, relative, sep } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { foldConsumedWork, type Agent, type AgentHandle } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { createUserMessage, type ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SessionId, TurnEndReason } from '@deepseek-ai/dsh-session'
import {
  appendDelegatedPolicyOverrides, captureDelegatedPolicyOverrides, childSessionMeta, finalAssistantOutput, resolveChildAgentOptions, resolveChildDepth,
  type ResolvedSubagentStartRequest, type SubagentCapabilities, type SubagentDescriptorData, type SubagentProvider, type SubagentResult,
  type SubagentRun, type SubagentStopReason,
} from '@deepseek-ai/dsh-subagent'
import { z } from 'zod'
import type {} from '../box/world.ts'
import { method } from './backends.ts'
import type { Spec } from './spec.ts'
import { InputError } from './store.ts'

export const name = 'fleet-tau-children'
export const inject = ['fleetBox', 'fleetTau', 'fleetBackends', 'subagents', 'agents']

/** This module's provider among dsh's subagent providers. */
const PROVIDER = 'fleet-tau'

/**
 * A call's arguments: the agent directory, its arguments, the folder the
 * call was made in, which relative path arguments are resolved against, and
 * the caller's environment; paths are absolute, in the caller's container.
 */
const runArgs = z.tuple([z.string(), z.array(z.string()), z.string(), z.record(z.string(), z.string())])

/** A call's arguments, named. */
interface RunRequest {
  agent: string
  args: string[]
  callerCwd: string
  env: Record<string, string>
}

/** How a run ended, as fleet-image's apis/tau/ declares it. */
interface Result {
  ok: boolean
  message: string
  failure?: string
}

/** A run the backend has read, for the provider to start. */
interface Prepared {
  spec: Spec
  /** The copy of the agent directory, which the run's snapshot is taken from. */
  agent: string
}

/** Runs the backend has read, by their prompt, which dsh's subagent service passes on to the provider as it is. */
type Pending = WeakMap<readonly ContentBlock[], Prepared>

export function apply(ctx: Context): void {
  const home = resolveDshHome()
  const pending: Pending = new WeakMap()
  ctx.effect(() => ctx.subagents.registerProvider(new TauProvider(ctx, pending)), 'fleet-tau subagent provider')
  ctx.effect(() => ctx.fleetBackends.provide({
    name: 'tau',
    methods: {
      run: method(runArgs, ([agent, args, callerCwd, env], call) => runChild(ctx, home, pending, call.session, { agent, args, callerCwd, env }, call.signal)),
    },
  }), 'fleet-tau backend tau')
}

/**
 * Run a tau for a program in a session's container, and wait for it.
 * @param caller - the session whose container the call came from.
 * @returns how the run ended, its `out` paths in place in the caller's container when it succeeded.
 * @throws when the run cannot start.
 */
async function runChild(
  ctx: Context, home: string, pending: Pending, caller: SessionId,
  request: RunRequest, signal: AbortSignal,
): Promise<Result> {
  if (!posix.isAbsolute(request.agent) || !posix.isAbsolute(request.callerCwd)) {
    throw new Error('the agent directory and the folder the run is started from must be absolute paths in the container')
  }
  const parent = ctx.agents.get(caller)
  if (parent === undefined) throw new Error(`the session ${caller} has no agent here to start the run under`)
  const run = await start(ctx, home, pending, parent, caller, request, signal)
  try {
    const result = await run.result
    const message = text(result.output)
    if (result.stopReason !== 'completed') {
      return { ok: false, message, failure: `the run ended ${result.stopReason}${result.diagnostic === undefined ? '' : `: ${result.diagnostic}`}` }
    }
    const problems = await ctx.fleetTau.publish(run.id, 0)
    return problems.length === 0 ? { ok: true, message } : { ok: false, message, failure: `the run did not give back its outputs:\n  ${problems.join('\n  ')}` }
  } finally {
    await run.dispose().catch((error: unknown) => { ctx.logger.warn(`fleet-tau: could not release the run ${run.id}: ${message(error)}`) })
    await ctx.fleetBox.stopSession(run.id).catch((error: unknown) => {
      ctx.logger.warn(`fleet-tau: could not stop the container of the run ${run.id}: ${message(error)}`)
    })
  }
}

/**
 * Read the agent directory from a copy of it, and start the run, whose spec
 * then has a snapshot of its own, so the copy goes.
 * @throws when the run cannot start.
 */
async function start(
  ctx: Context, home: string, pending: Pending, parent: Agent, caller: SessionId,
  request: RunRequest, signal: AbortSignal,
): Promise<SubagentRun> {
  await mkdir(join(home, 'fleet', 'staging'), { recursive: true, mode: 0o700 })
  const staging = await mkdtemp(join(home, 'fleet', 'staging', 'run-'))
  try {
    const agent = join(staging, 'agent')
    const copied = await ctx.fleetBox.copyOut(caller, request.agent, agent, { links: true, signal })
    // A copy that is no folder is what an agent directory that led nowhere in the container left.
    const leaving = copied ? await linksLeaving(agent).catch(() => undefined) : undefined
    if (leaving === undefined) throw new Error(`there is no agent directory ${request.agent}`)
    if (leaving.length > 0) {
      throw cannotRun(request.agent, leaving.map(link => `${posix.join(request.agent, link)} is a symlink that leads out of the agent directory`))
    }
    const prepared = await ctx.fleetTau.prepare({
      agent, source: request.agent, caller, args: request.args, bind: true, callerCwd: request.callerCwd, env: request.env,
    })
    if (!prepared.ok) throw cannotRun(request.agent, prepared.problems)
    const prompt: ContentBlock[] = [{ type: 'text', text: prepared.spec.prompt }]
    pending.set(prompt, { spec: prepared.spec, agent })
    return await ctx.subagents.start(PROVIDER, { label: prepared.title, prompt, parent, signal }).catch((error: unknown) => {
      throw error instanceof InputError ? cannotRun(request.agent, error.problems) : error
    })
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
}

/**
 * Starts the runs the `tau` backend has read, each as a one-shot child of
 * the calling agent, with a spec of its own, and so a container of its own.
 * It offers none of dsh's options to start a child with, and no model-facing
 * tool names it.
 */
class TauProvider implements SubagentProvider {
  readonly name = PROVIDER
  readonly capabilities: SubagentCapabilities = { agentOptions: false, outputSchema: false, depthLimit: false, toolFilter: false, persona: false }
  readonly inheritsParentContext = false

  constructor(private readonly ctx: Context, private readonly pending: Pending) {}

  async start(request: ResolvedSubagentStartRequest): Promise<SubagentRun> {
    const prepared = this.pending.get(request.prompt)
    if (prepared === undefined) throw new Error('fleet-tau: its subagent provider starts only the runs its tau backend has read')
    this.pending.delete(request.prompt)
    request.signal.throwIfAborted()
    const parent = request.parent
    const depth = resolveChildDepth(parent, undefined)
    // Before the first await, as dsh's providers take it: a later change of the parent's is its own.
    const inherited = captureDelegatedPolicyOverrides(parent)
    const id = randomUUID() as SessionId
    await this.ctx.fleetTau.create(id, prepared.spec, request.signal, prepared.agent)
    let handle: AgentHandle
    try {
      handle = await parent.ctx.agents.create({
        sessionId: id,
        parentAgent: parent,
        meta: childSessionMeta(parent, depth, false),
        agentOptions: resolveChildAgentOptions(parent, undefined, depth),
        signal: request.signal,
        setup: (childCtx, child) => {
          appendDelegatedPolicyOverrides(child.session, inherited)
          // The parent's preset, as dsh composes a child, but without its statement that the child is a delegated
          // subagent: a tau runs as it would from the `fleet` command.
          childCtx.get('agentPresets')?.composeFrom(childCtx, parent.ctx)
          appendDescriptor(childCtx, request.descriptor)
        },
      })
    } catch (error) {
      await this.ctx.fleetTau.remove(id).catch((removeError: unknown) => {
        this.ctx.logger.warn(`fleet-tau: could not remove the spec of ${id}, which was never made: ${message(removeError)}`)
      })
      throw error
    }
    return drive(handle, request.signal, request.prompt)
  }
}

/** Write the child's descriptor, which dsh's catalog of children reads, into its first turn. */
function appendDescriptor(childCtx: Context, descriptor: SubagentDescriptorData): void {
  let appended = false
  childCtx.on('agent/pre-step', async ({ agent }, next) => {
    const decision = await next()
    if (!appended && decision.kind === 'enter') {
      appended = true
      agent.session.append('subagent/descriptor', descriptor)
    }
    return decision
  })
}

/** Give the child its prompt, and settle once it is idle, as dsh's one-shot children do; the signal cancels it. */
function drive(handle: AgentHandle, signal: AbortSignal, prompt: ContentBlock[]): SubagentRun {
  const child = handle.agent
  let cancelled = false
  const cancel = (): void => {
    cancelled = true
    child.cancel({ kind: 'parent' })
  }
  signal.addEventListener('abort', cancel, { once: true })
  if (signal.aborted) cancel()
  const result = (async (): Promise<SubagentResult> => {
    try {
      if (!cancelled) {
        child.followup(createUserMessage({ content: prompt, source: { kind: 'user' } }))
        await child.whenIdle()
      }
      return outcome(child, cancelled)
    } finally {
      signal.removeEventListener('abort', cancel)
    }
  })()
  return {
    id: child.id,
    localAgent: child,
    result,
    async dispose(): Promise<void> {
      signal.removeEventListener('abort', cancel)
      cancelled = true
      const [disposal] = await Promise.allSettled([handle.dispose(), result])
      if (disposal.status === 'rejected') throw disposal.reason
    },
  }
}

/** How a settled child ended: its final answer, and why it stopped. */
function outcome(child: Agent, cancelled: boolean): SubagentResult {
  // oxlint-disable-next-line typescript/no-deprecated -- the whole log of a child that has settled, as dsh's own providers read it.
  const events = child.session.snapshotEvents()
  const reason = foldConsumedWork(events).end?.data.reason
  const recorded = stopReason(reason)
  return {
    output: finalAssistantOutput(events) ?? [],
    stopReason: cancelled && recorded !== 'completed' ? 'aborted' : recorded,
    ...reason?.kind === 'error' ? { diagnostic: bytesOf(`${reason.error.code}: ${reason.error.message}`, MAX_DIAGNOSTIC_BYTES) } : {},
  }
}

function stopReason(reason: TurnEndReason | undefined): SubagentStopReason {
  switch (reason?.kind) {
    case 'completed': return 'completed'
    case 'max-tokens': return 'max-tokens'
    case 'aborted': return 'aborted'
    // A step's rejection discarded the prompt, so the task was declined.
    case 'blocked': return 'refusal'
    default: return 'error'
  }
}

/**
 * The symlinks in a copied agent directory that lead out of it, relative to
 * it: absolute ones, and relative ones that leave it, followed hop by hop as
 * tau's library checks a tau's links, a `..` taken from where the links
 * before it led. The links are the model's, so none is followed on the host
 * before it is known to stay inside: each step looks only at a path in the
 * copy, without following it.
 * @throws when the copy is not a folder, as when the agent directory led nowhere in the container.
 */
export async function linksLeaving(root: string): Promise<string[]> {
  if (!(await lstat(root)).isDirectory()) throw new Error('it is not a directory')
  const leaving: string[] = []
  const visit = async (path: string): Promise<void> => {
    const info = await lstat(path)
    if (info.isSymbolicLink()) {
      if (await reach(root, dirname(path), await readlink(path), 0) === undefined) leaving.push(relative(root, path).split(sep).join('/'))
      return
    }
    if (info.isDirectory()) for (const entry of (await readdir(path)).sort()) await visit(join(path, entry))
  }
  await visit(root)
  return leaving
}

/** Most symlinks one link may lead through, as the kernel allows. */
const MAX_HOPS = 40

/**
 * Where a symlink's target leads from the folder it is in, inside `root`,
 * the links on the way followed in turn; undefined when it leaves `root`, is
 * absolute, or goes through too many links. A part that is missing is taken
 * as written.
 * @param folder - a real folder inside `root`, never a link.
 */
async function reach(root: string, folder: string, target: string, hops: number): Promise<string | undefined> {
  if (isAbsolute(target) || hops > MAX_HOPS) return undefined
  let current = folder
  for (const part of target.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') {
      if (current === root) return undefined
      current = dirname(current)
      continue
    }
    const next = join(current, part)
    const info = await lstat(next).catch(() => undefined)
    if (info?.isSymbolicLink() !== true) {
      current = next
      continue
    }
    const reached = await reach(root, current, await readlink(next), hops + 1)
    if (reached === undefined) return undefined
    current = reached
  }
  return current
}

/** Most UTF-8 bytes of a child's diagnostic, as dsh's subagent results take it. */
const MAX_DIAGNOSTIC_BYTES = 4096

/** As much of a text as fits in so many UTF-8 bytes, a character cut in two left out. */
function bytesOf(text: string, bytes: number): string {
  return Buffer.from(text).subarray(0, bytes).toString('utf8').replace(/\uFFFD$/u, '')
}

function cannotRun(agent: string, problems: readonly string[]): Error {
  return new Error(`${agent} cannot run:\n  ${problems.join('\n  ')}`)
}

function text(output: readonly ContentBlock[]): string {
  return output.map(block => block.type === 'text' ? block.text : '').join('')
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
