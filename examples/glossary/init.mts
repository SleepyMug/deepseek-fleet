// Defines the term without the agent when the glossary has it, leaves the term to the agent when it
// does not, and fails, the agent then told why, when the glossary cannot be read, as when it is not
// JSON.
import { readFileSync, writeFileSync } from 'node:fs'
import { TAU_RUN, values } from '@api/tau'

const { glossary, term, definition } = values() as { glossary: { $in: string }; term: string; definition: { $out: string } }
const entries = JSON.parse(readFileSync(glossary.$in, 'utf8')) as Record<string, string>
const known = entries[term.toLowerCase()]
if (known === undefined) process.exit(TAU_RUN)
writeFileSync(definition.$out, `${known}\n`)
// Ending normally exits 0, TAU_SKIP: the agent does not run, and this is the run's final text.
console.log(known)
