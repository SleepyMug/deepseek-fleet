#!/usr/bin/env node
/**
 * `notes`, fleet-notes' command in a box: it keeps short notes, each with
 * tags to find them by later, in the box's notebook, which fleet-notes keeps
 * on the host, through the service's socket in the box (./wire.ts).
 * @module @sleepymug/fleet-notes-box/notes
 */

import { createConnection } from 'node:net'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { type Answer, type Request, SERVICE } from './wire.ts'

const USAGE = `Usage: notes <command>

Keep short notes, each with tags to find them by later, in this box's notebook,
which outlasts the box's processes, and is kept outside the box.

Commands:
  add <text> [--tag <tag>]...   keep a note, and print it as JSON
  tag <tag>                     print the notes with the tag, oldest first, as a JSON list
`

/** Send a request on the service's socket, and give back its answer's value. */
function ask(request: Request): Promise<unknown> {
  const folder = process.env.FLEET_SERVICES
  if (folder === undefined || folder === '') return Promise.reject(new Error('$FLEET_SERVICES is not set: this is no box of the fleet host\'s'))
  return new Promise((resolve, reject) => {
    const socket = createConnection(join(folder, `${SERVICE}.sock`))
    let text = ''
    socket.setEncoding('utf8')
    socket.on('data', (chunk: string) => { text += chunk })
    socket.on('error', (error) => { reject(new Error(`the notes service could not be reached: ${error.message}`)) })
    socket.on('end', () => {
      let answer: Answer
      try {
        answer = JSON.parse(text) as Answer
      } catch {
        reject(new Error('the notes service is not available'))
        return
      }
      if (answer.ok) resolve(answer.value)
      else reject(new Error(answer.error))
    })
    socket.end(`${JSON.stringify(request)}\n`)
  })
}

try {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { tag: { type: 'string', multiple: true }, help: { type: 'boolean', short: 'h' } } })
  const [command, ...rest] = positionals
  if (values.help === true || command === undefined) {
    process.stdout.write(USAGE)
    if (command === undefined && values.help !== true) process.exitCode = 2
  } else if (command === 'add' && rest.length === 1) {
    process.stdout.write(`${JSON.stringify(await ask({ op: 'add', text: rest[0] as string, tags: values.tag ?? [] }))}\n`)
  } else if (command === 'tag' && rest.length === 1 && values.tag === undefined) {
    process.stdout.write(`${JSON.stringify(await ask({ op: 'tag', tag: rest[0] as string }))}\n`)
  } else {
    process.stderr.write(`notes: not a command\n${USAGE}`)
    process.exitCode = 2
  }
} catch (error) {
  process.stderr.write(`notes: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
}
