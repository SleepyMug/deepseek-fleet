/**
 * The processes of the terminals the host runs in this container. The host
 * starts a terminal's shell with `docker exec`, outside the helper, so the
 * helper finds the terminal's processes by the marker in their environment
 * ({@link TERMINAL_MARKER}): the shell carries it, and everything the shell
 * starts inherits it. Not every process shows it: one may clear its
 * environment, and without CAP_SYS_PTRACE the helper may not read another
 * user's or a non-dumpable one's. So a process is the terminal's too when it
 * is in the shell's session, which `docker exec --tty` makes the shell lead,
 * or a child of one of the terminal's processes, as `su -c` starts its
 * command in a session of its own. The shell is the marked process whose
 * parent is outside the container. Between lookups the helper remembers the
 * shell's session and the processes it found, by pid and start time, so
 * leftovers are still found after the shell or their parent has exited. Only
 * a process that hides the marker, starts a session of its own and outlives
 * its parent between two lookups is not the terminal's; it runs until it ends
 * or the container stops.
 * @module fleet-box/helper/terminals
 */

import { readdir, readFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import { TERMINAL_MARKER, type TerminalState } from './protocol.ts'

/** How often a terminal's processes are looked up while it is being ended. */
const END_POLL_MS = 100
/** How often they are looked up while waiting for them to end, which can take hours. */
const WAIT_POLL_MS = 1000

/** The fields of /proc/<pid>/stat a terminal is judged by. */
export interface ProcessStat {
  pid: number
  /** One-letter state, such as R for running, S for sleeping and Z for a zombie. */
  state: string
  /** 0 for a process started from outside the container, such as by `docker exec`. */
  ppid: number
  pgrp: number
  session: number
  /** Foreground process group of the process's controlling terminal; -1 without one. */
  tpgid: number
  /** When the process started, in clock ticks after boot; with the pid, it tells a process from a later one. */
  start: number
}

/** What the helper remembers of a terminal while any of its processes is left. */
interface Known {
  /** The shell's session. */
  session: number | undefined
  /** The processes last found, by pid and start time. */
  members: Set<string>
}

const known = new Map<string, Known>()

/**
 * Read the fields of a /proc/<pid>/stat line. The command name between
 * parentheses may hold spaces and parentheses itself, so the fields after it
 * count from its last closing parenthesis.
 * @returns the fields, or undefined for a line that does not parse.
 */
export function parseStat(line: string): ProcessStat | undefined {
  const end = line.lastIndexOf(')')
  if (end === -1) return undefined
  // The fields after the name start with the stat's third, so its 22nd, the start time, is the 20th here.
  const fields = line.slice(end + 2).split(' ')
  const [state = '', ppid, pgrp, session, , tpgid] = fields
  const numbers = [Number.parseInt(line, 10), Number(ppid), Number(pgrp), Number(session), Number(tpgid), Number(fields[19])]
  if (state === '' || !numbers.every(Number.isSafeInteger)) return undefined
  const [pid = 0, parent = 0, group = 0, leader = 0, foreground = 0, start = 0] = numbers
  return { pid, state, ppid: parent, pgrp: group, session: leader, tpgid: foreground, start }
}

/** Every live process of the terminal: marked, in its shell's session, found before, or a child of one of these. */
async function members(terminal: string): Promise<ProcessStat[]> {
  const entry = `${TERMINAL_MARKER}=${terminal}`
  const before = known.get(terminal)
  const live: { stat: ProcessStat; marked: boolean }[] = []
  for (const name of await readdir('/proc')) {
    if (!/^\d+$/u.test(name)) continue
    let stat: ProcessStat | undefined
    try {
      stat = parseStat(await readFile(`/proc/${name}/stat`, 'latin1'))
    } catch {
      // The process ended while it was read.
    }
    if (stat === undefined || stat.state === 'Z' || stat.state === 'X') continue
    let marked = false
    try {
      marked = (await readFile(`/proc/${name}/environ`, 'latin1')).split('\0').includes(entry)
    } catch {
      // It ended, or its environment is not the helper's to read; how it relates to the terminal still tells.
    }
    live.push({ stat, marked })
  }
  const shell = live.find(({ stat, marked }) => marked && stat.ppid === 0 && stat.session === stat.pid)
  const session = shell?.stat.session ?? before?.session
  const found = new Map<number, ProcessStat>()
  for (const { stat, marked } of live) {
    if (marked || stat.session === session || before?.members.has(identity(stat)) === true) found.set(stat.pid, stat)
  }
  // Children of the terminal's processes, down to the last generation.
  for (let grown = true; grown;) {
    grown = false
    for (const { stat } of live) {
      if (found.has(stat.pid) || !found.has(stat.ppid)) continue
      found.set(stat.pid, stat)
      grown = true
    }
  }
  const members = [...found.values()]
  if (members.length === 0) known.delete(terminal)
  else known.set(terminal, { session, members: new Set(members.map(identity)) })
  return members
}

function identity(stat: ProcessStat): string {
  return `${stat.pid}:${stat.start}`
}

/** @returns the terminal's shell and processes, as the process table has them now. */
export async function terminalState(terminal: string): Promise<TerminalState> {
  const found = await members(terminal)
  const shell = found.find(member => member.ppid === 0 && member.session === member.pid)
  return {
    shell: shell !== undefined,
    members: found.length,
    prompt: shell !== undefined && found.length === 1 && shell.tpgid === shell.pgrp && shell.state === 'S',
  }
}

/**
 * End a terminal as a closed terminal window does: hang up every process,
 * continue stopped ones so they see it, and kill whatever remains after the
 * grace, including processes started meanwhile. An interactive shell ignores
 * SIGTERM, so the hangup is what ends it.
 * @returns once no process of the terminal is left.
 */
export async function endTerminal(terminal: string, graceMs: number, signal: AbortSignal): Promise<void> {
  let found = await members(terminal)
  send(found, 'SIGHUP')
  send(found, 'SIGCONT')
  const deadline = Date.now() + graceMs
  while (found.length > 0 && Date.now() < deadline) {
    await delay(Math.min(END_POLL_MS, Math.max(1, deadline - Date.now())), undefined, { signal })
    found = await members(terminal)
  }
  while (found.length > 0) {
    send(found, 'SIGKILL')
    await delay(END_POLL_MS, undefined, { signal })
    found = await members(terminal)
  }
}

/** @returns once no process of the terminal is left. */
export async function waitTerminal(terminal: string, signal: AbortSignal): Promise<void> {
  while ((await members(terminal)).length > 0) await delay(WAIT_POLL_MS, undefined, { signal })
}

function send(found: readonly ProcessStat[], signal: NodeJS.Signals): void {
  for (const member of found) {
    try {
      process.kill(member.pid, signal)
    } catch {
      // It has ended.
    }
  }
}
