// Defines the term without the agent when the glossary has it (exit 0), leaves the term to the
// agent when it does not (exit 100), and fails, the agent then told why, when the glossary cannot
// be read, as when it is not JSON.
import { readFileSync, writeFileSync } from 'node:fs'
import { values } from '@api/tau'

const { glossary, term, definition } = values() as { glossary: { $in: string }; term: string; definition: { $out: string } }
const entries = JSON.parse(readFileSync(glossary.$in, 'utf8')) as Record<string, string>
const known = entries[term.toLowerCase()]
if (known === undefined) process.exit(100)
writeFileSync(definition.$out, `${known}\n`)
console.log(known)
