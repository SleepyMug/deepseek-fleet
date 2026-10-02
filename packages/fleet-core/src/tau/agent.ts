/**
 * Gives each agent the TypeScript tools (./ts-tools.ts), whose programs
 * import its session's APIs (./apis.ts), and, for a session the `fleet`
 * command started from an agent directory, what the session's spec holds
 * (./store.ts): the agent's skills, with dsh's `skill` tool to load them. A
 * session with fleet's `tau` API, as any not started from an agent
 * directory has, such as those the web UI starts, is also told how to run
 * taus. Everything is registered in a scope of that agent alone, since each
 * session's APIs and skills are its own. It happens as dsh announces the
 * agent, for a new session and for every resume, so a session keeps its
 * skills across host restarts; agents already running when this plugin
 * loads get theirs before their next step.
 *
 * It never fails an agent: dsh awaits these listeners, and a throw would
 * keep the session from opening at all, in the web UI too. A spec that
 * cannot be read or applied is logged, and the agent goes on without it; the
 * `fleet` command refuses a broken agent directory before its session exists.
 * @module fleet-core/tau/agent
 */

import { posix } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import { createScope, type Scope } from '@deepseek-ai/dsh-scope'
import type {} from '@deepseek-ai/dsh-skill'
import * as ToolSkill from '@deepseek-ai/dsh-tool-skill'
import type {} from '../box/world.ts'
import { sessionApis } from './apis.ts'
import { AGENT_VIEW } from './paths.ts'
import type { Skill } from './spec.ts'
import type {} from './store.ts'
import { registerTsTools } from './ts-tools.ts'

export const name = 'fleet-tau-agent'
export const inject = ['fleetTau', 'fleetBox', 'agents', 'skills', 'tools', 'subprocess', 'systemPrompt']

const RUNNING_TAUS = `# Running taus

A tau is an agent packaged as a directory: its PROMPT.md, and a tau.json that declares the arguments it takes. Run one with \`tau run <agent-dir> [args...]\`, which waits for it, but only as long as your command's timeout; or from a \`ts_execute\` program with \`run\` from \`@api/tau\`, which waits as long as the run takes, so use a program for a long run, or to run several at once. Each run works in a container of its own: its \`in\` paths are copied from this container when it starts, and its \`out\` paths are copied back into this container once it succeeds.`

export function apply(ctx: Context): void {
  /** Each agent's install, once begun; it settles to the agent's scope, or undefined when it failed. */
  const installs = new Map<Agent, Promise<Scope | undefined>>()
  const install = (agent: Agent): Promise<Scope | undefined> => {
    let pending = installs.get(agent)
    if (pending === undefined) {
      pending = customize(ctx, agent).catch((error: unknown) => {
        ctx.logger.warn(`fleet-tau: session ${agent.id} goes on without its agent's customization: ${message(error)}`)
        return undefined
      })
      installs.set(agent, pending)
    }
    return pending
  }
  const uninstall = async (agent: Agent): Promise<void> => {
    const pending = installs.get(agent)
    installs.delete(agent)
    await (await pending)?.dispose()
  }

  // Agents that were running before this plugin loaded get their install before their next step.
  const early = new Set(ctx.agents.list())
  for (const agent of early) void install(agent)
  ctx.on('agent/pre-step', async ({ agent }, next): Promise<PreStepDecision> => {
    if (early.delete(agent)) await install(agent)
    return next()
  }, { prepend: true })
  ctx.on('agent/created', async ({ agent }) => {
    early.delete(agent)
    await install(agent)
  })
  ctx.on('agent/disposed', ({ agent }) => {
    early.delete(agent)
    uninstall(agent).catch((error: unknown) => { ctx.logger.warn(`fleet-tau: could not release session ${agent.id}'s customization: ${message(error)}`) })
  })
  ctx.effect(() => async () => {
    await Promise.all([...installs.keys()].map(agent => uninstall(agent)))
  }, 'fleet-tau agent customizations')
}

/**
 * Give an agent the APIs, and what the spec holds, of the session whose
 * container it uses.
 * @returns the agent's scope.
 */
async function customize(ctx: Context, agent: Agent): Promise<Scope> {
  const header = agent.session.header
  const owner = header.origin === 'subagent' ? await ctx.fleetBox.ownerHeaderOf(agent.id) : header
  const found = await ctx.fleetTau.specOf(owner)
  // A fork's container takes its source's snapshot; set before the fork's first step opens the container.
  if (found !== undefined && found.owner !== owner.id) await ctx.fleetTau.configureFork(owner.id, found)
  const skills = found?.spec.skills ?? []
  const apis = sessionApis(found?.spec)
  const scope = createScope(ctx, agent)
  try {
    if (skills.length > 0) {
      await scope.ctx.plugin(ToolSkill)
      for (const skill of skills) scope.ctx.skills.register(registration(skill))
    }
    registerTsTools(scope.ctx, apis)
    if (apis.some(api => api.name === 'tau')) {
      scope.ctx.systemPrompt.section({ name: 'fleet-tau:taus', order: scope.ctx.systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_SUFFIX') - 1, interpolate: false, text: RUNNING_TAUS })
    }
    return scope
  } catch (error) {
    await scope.dispose()
    throw error
  }
}

/** A skill as dsh registers one, its resources where the session's container sees the snapshot. */
function registration(skill: Skill): Parameters<Context['skills']['register']>[0] {
  return {
    name: skill.name,
    description: skill.description,
    ...skill.whenToUse === undefined ? {} : { whenToUse: skill.whenToUse },
    source: 'fleet',
    content: skill.content,
    invocation: { modelInvocable: skill.modelInvocable, userInvocable: skill.userInvocable },
    resourceBase: { kind: 'directory', path: posix.join(AGENT_VIEW, 'skills', skill.dir) },
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
