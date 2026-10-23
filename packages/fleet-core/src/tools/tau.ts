/**
 * fleet-tau-tools, `tau_run`, as a dsh plugin that fleet-core's
 * cordis.patch.yml mounts for every session (docs/fleet-core/tools/index.md):
 * a session that works on the host runs a tau as `tau run --adaptor fleet`
 * does, with tau's client and its fleet adaptor, on the tau service,
 * `ctx.fleetTau`, in this process, as the run's caller. Its call is packed
 * here, from the session's files, relative paths its working directory's,
 * and the run's result put at its paths, once the run ends, and its trace,
 * if asked for, as `tau trace` prints it; then the run is released. The tool waits
 * for it, so nothing outlives the call. tau's primers are skills of every
 * session (./primers.ts): `tau`, its TAU.md, what a tau takes and what a
 * run of one promises, and `tau-dev`, its TAU_DEV.md, how to make one; a
 * system-prompt section, where the session has the tool, points to them.
 *
 * What it writes, the session's sandbox lets it write, as dsh's sandbox
 * policy has it for the session, before the run starts and again as its
 * result is put: under `read-only`, nothing; under `workspace-write`, under
 * its writable roots, each path as far as it is there resolved, links and
 * all, as tau puts a result there. It asks for no wider access; what it
 * reads, every mode reads. A tau's session, whose files are its box's, has
 * its tau API in its place, and the `tau` preset hides the tool from it.
 * @module @sleepymug/fleet-core/tools/tau
 */

import { realpathSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve, sep } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { writableRoots } from '@deepseek-ai/dsh-sandbox'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import type { Session } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-skill'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { createClient, traceLines } from '@sleepymug/tau'
import { createFleetAdaptor, fleetLoopback } from '@sleepymug/tau/adaptors'
import type { TauBoxes } from '../tau/ports.ts'
import type { Caller } from '../tau/registry.ts'
import type {} from '../services.ts'
import { PRIMERS, pathOf, textOf } from './primers.ts'

export const name = 'fleet-tau-tools'
export const inject = ['tools', 'systemPrompt', 'skills', 'fleetTau', 'fleetTauRuns']

/** What the system prompt says of TAUs, where the session has tau_run. */
export const SECTION = 'You can run TAUs, agents packaged as directories, each in a container of its own, with tau_run. '
  + 'Load the `tau` skill before you run one, and the `tau-dev` skill before you make or change one.'

export function apply(ctx: Context): void {
  const runs: Pick<TauBoxes, 'isTau'> = ctx.fleetTauRuns
  for (const primer of PRIMERS) {
    ctx.skills.register({ name: primer.name, description: primer.description, source: 'bundled', path: pathOf(primer), content: textOf(primer) })
  }
  ctx.systemPrompt.section({
    name: 'tool:tau',
    order: ctx.systemPrompt.getSectionOrder('TOOL_SUBAGENT') + 50,
    text: ({ scope }) => ctx.tools.get('tau_run', scope) === undefined ? '' : SECTION,
  })

  ctx.tools.register(defineTool({
    name: 'tau_run',
    description: 'Run a TAU, as its caller, with a call: its files and its args (the `tau` skill). Its agent does the task in a container '
      + 'of its own, with copies of the files you give, and cannot ask you anything; a run may take minutes. Waits until the run ends, '
      + 'and returns { sessionId, ok, text, failure? }: its archived session, which you cannot continue, whether it succeeded, '
      + 'its agent\'s final text, and why it failed. If it succeeded, what its agent left at each out and inout file is put at your path: '
      + 'a file replaces one there, and a directory merges into one there, so what the agent removed from it stays. '
      + 'A failed run changes none of your paths, whatever its text says, but what its API calls did stands. '
      + 'Calls in one message run at once: give each its own out and inout paths.',
    parameters: {
      tau: {
        type: 'string',
        required: true,
        description: 'The TAU\'s directory, relative to your working directory. Read its PROMPT.md and its tau.json, if it has one, '
          + 'first: they say what it does with which files and args.',
      },
      files: {
        type: 'json',
        description: 'The call\'s files: for each file tau.json declares, by its name, a path of yours, relative to your working directory '
          + 'or absolute. An in file may be given a list of paths, which its agent sees as one directory. An out file\'s directory must exist. '
          + 'An extra file, one tau.json does not declare, for the args to name, is given with its mode: { "mode": "in", "path": "notes.md" }, '
          + '"out" or "inout", with "kind", "file" or "dir", if it must be one. None for a TAU that takes no files.',
      },
      args: {
        type: 'json',
        description: 'The call\'s args: a JSON object that fits the JSON Schema of tau.json\'s args. Its agent sees none of your paths, '
          + 'so a string names a file only by its placeholder, the file\'s name in ${}, which becomes where its agent sees it, '
          + 'as in "${site}/index.html"; and ${ meant as text is written $${. None for a TAU that takes no args.',
      },
      trace: {
        type: 'string',
        description: 'Where to write the run\'s trace, to see what its agent did: a line of JSON naming its format, then each event '
          + 'of its session, a line each, written whether the run succeeded or not. A relative path is your working directory\'s. '
          + 'None writes no trace.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          sessionId: { type: 'string', required: true },
          ok: { type: 'boolean', required: true },
          text: { type: 'string', required: true },
          failure: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    // Each run has a box of its own, and its outputs go where the model said.
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const session = exec.agent?.session
      const cwd = session?.header.cwd
      if (session === undefined || cwd === undefined) throw new Error('tau_run works only in a session with a working directory')
      if (runs.isTau(session.header.id)) throw new Error('a TAU\'s session runs TAUs with its tau API, not tau_run')
      const caller: Caller = { kind: 'session', sessionId: session.header.id }
      const fleet = createFleetAdaptor({ transport: fleetLoopback(ctx.fleetTau.handlerFor(caller)), project: cwd })
      const client = createClient({ adaptors: { fleet } })
      const tauDir = resolve(cwd, args.tau)
      const call = { files: args.files ?? {}, args: args.args ?? {} }
      const { call: resolved } = client.check(tauDir, call, cwd)
      const targets = Object.entries(resolved.files).flatMap(([name, { mode }]) => mode === 'in' ? [] : [resolved.paths[name] as string])
      const written = [...targets, ...args.trace === undefined ? [] : [resolve(cwd, args.trace)]]
      checkWritable(ctx, session, written)
      const run = await client.start(tauDir, call, { cwd, signal: exec.signal })
      const sessionId = run.slice('fleet:'.length)
      try {
        await ctx.fleetTau.untilEnded(caller, sessionId, exec.signal)
        // Its sandbox, or what is at its paths, may have changed while the run ran.
        checkWritable(ctx, session, written)
        if (args.trace !== undefined) {
          const at = resolve(cwd, args.trace)
          await mkdir(dirname(at), { recursive: true })
          await writeFile(at, traceLines(await client.trace(run, { signal: exec.signal })))
        }
        const { ok, text, failure } = await client.finish(run, { signal: exec.signal })
        return { sessionId, ok, text, ...failure === undefined ? {} : { failure } }
      } finally {
        await client.release(run).catch(() => {})
      }
    },
  }))
}

/**
 * Refuse to write a path the session's sandbox does not let it write, as
 * dsh's sandbox policy has it for the session; with no sandbox policy,
 * dsh confines nothing.
 */
function checkWritable(ctx: Context, session: Session, paths: readonly string[]): void {
  const policy = ctx.get('sandboxPolicy')?.resolve({ session })
  if (policy === undefined || policy.mode === 'danger-full-access') return
  const roots = writableRoots(policy)
  for (const path of paths) {
    const at = resolved(path)
    if (roots.some(root => at === root || at.startsWith(root.endsWith(sep) ? root : `${root}${sep}`))) continue
    throw new Error(roots.length === 0
      ? `tau_run cannot write ${path}: this session's sandbox, ${policy.mode}, lets it write nothing`
      : `tau_run cannot write ${path}: this session's sandbox, ${policy.mode}, lets it write only under ${roots.join(', ')}`)
  }
}

/** A path as far as it is there with its links resolved, as dsh's sandbox compares paths, and the rest of it as it is. */
function resolved(path: string): string {
  const rest: string[] = []
  for (let at = path; ; at = dirname(at)) {
    try {
      return join(realpathSync.native(at), ...rest)
    } catch {
      if (dirname(at) === at) return path
      rest.unshift(basename(at))
    }
  }
}
