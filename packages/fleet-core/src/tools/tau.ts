/**
 * fleet-tau-tools, `tau_run`, as a dsh plugin that fleet-core's `fleet`
 * agent preset mounts (docs/fleet-core/tools/index.md): a session that works
 * on the host runs a tau as `fleet run` does, on the tau service,
 * `ctx.fleetTau`, as the run's caller. Its call is packed here, from the
 * session's files, relative paths its working directory's, and the run's
 * result put at its paths, once the run ends, and its session's history,
 * if asked for; the tool waits for it, so nothing outlives the call. A system-prompt section, where the session has
 * the tool, is tau's TAU.md: what a tau is, and what a run of one promises.
 * @module fleet-core/tools/tau
 */

import { readFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { applyResult, packCall } from '@sleepymug/tau/call'
import type { Caller } from '../tau/registry.ts'
import type {} from '../tau/plugin.ts'

export const name = 'fleet-tau-tools'
export const inject = ['tools', 'systemPrompt', 'fleetTau']

export function apply(ctx: Context): void {
  const primer = readFileSync(fileURLToPath(import.meta.resolve('@sleepymug/tau/TAU.md')), 'utf8')
  ctx.systemPrompt.section({
    name: 'tool:tau',
    order: ctx.systemPrompt.getSectionOrder('TOOL_SUBAGENT') + 50,
    interpolate: false,
    text: ({ scope }) => ctx.tools.get('tau_run', scope) === undefined ? '' : primer,
  })

  ctx.tools.register(defineTool({
    name: 'tau_run',
    description: 'Run a TAU: a folder with a PROMPT.md, the task, and a tau.json, which declares the files it takes, by name, '
      + 'each with its mode, in, out or inout, and its args, as a JSON Schema. An agent of its own does the task in a container of its own, '
      + 'with copies of what it is given, and what it leaves at its out and inout files is put at your paths once it ends. '
      + 'Read tau.json first. Waits until the run ends, and returns { sessionId, ok, text, failure? }: the run\'s session, '
      + 'whether it succeeded, its agent\'s final text, and why it failed, if it did. Cancelling the call cancels the run. '
      + 'Several calls run at once.',
    parameters: {
      tau: { type: 'string', required: true, description: 'The TAU\'s folder; a relative path is your working directory\'s.' },
      files: {
        type: 'json',
        description: 'A path for each file tau.json declares, by name; for an in file, a list of paths gives a folder holding each. '
          + 'A file tau.json does not declare, an extra file, which the args name, is given with its mode, '
          + 'as { "mode": "in", "path": "notes.md" }, or "out" or "inout", and optionally "kind", "file" or "dir". '
          + 'Relative paths are your working directory\'s. None for a TAU that takes no files.',
      },
      args: {
        type: 'json',
        description: 'The args, a JSON object that fits the schema tau.json declares. In any string of them, ${name}, naming a file, '
          + 'is where the TAU\'s agent sees that file, as in "${site}/index.html", and a $ before one escapes it once, so "$${site}" '
          + 'reaches the agent as "${site}", for a run it makes. None for a TAU that takes no args.',
      },
      history: {
        type: 'string',
        description: 'Where to write the run\'s session history, to see what its agent did: one JSON event per line, '
          + 'the prompts, tools, messages, tool calls and results, written whether the run succeeded or not. '
          + 'A relative path is your working directory\'s. None writes no history.',
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
      const session = exec.agent?.session.header
      const cwd = session?.cwd
      if (session === undefined || cwd === undefined) throw new Error('tau_run works only in a session with a working directory')
      const caller: Caller = { kind: 'session', sessionId: session.id }
      const call = packCall(resolve(cwd, args.tau), { files: args.files ?? {}, args: args.args ?? {} }, cwd)
      const { sessionId } = await ctx.fleetTau.start(caller, { title: basename(call.tauDir), project: cwd, targets: call.targets }, call.archive)
      const cancel = (): void => { ctx.fleetTau.cancel(caller, sessionId).catch(() => {}) }
      exec.signal.addEventListener('abort', cancel, { once: true })
      try {
        if (exec.signal.aborted) cancel()
        const { targets, archive, history } = await ctx.fleetTau.finish(caller, sessionId, exec.signal, { history: args.history !== undefined })
        if (args.history !== undefined) {
          const at = resolve(cwd, args.history)
          await mkdir(dirname(at), { recursive: true })
          await writeFile(at, (history ?? []).map(event => `${JSON.stringify(event)}\n`).join(''))
        }
        const { ok, text, failure } = await applyResult(archive, targets)
        return { sessionId, ok, text, ...failure === undefined ? {} : { failure } }
      } finally {
        exec.signal.removeEventListener('abort', cancel)
      }
    },
  }))
}
