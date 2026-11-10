// Defines the term without the agent when the glossary has it, leaves the term to the agent when it
// does not, and fails, the agent then told why, when the glossary cannot be read, as when it is not
// JSON.
import { readFileSync, writeFileSync } from 'node:fs'

/** Init's exit code when the agent is to run on the prompt, as it would without init. */
const TAU_RUN = 100

// The run's context: where this run has each file, and its args.
const { files, args } = JSON.parse(readFileSync(process.env.TAU_CONTEXT as string, 'utf8')) as {
  files: { glossary: string; definition: string }
  args: { term: string }
}
const { glossary, definition } = files
const { term } = args
const entries = JSON.parse(readFileSync(glossary, 'utf8')) as Record<string, string>
const known = entries[term.toLowerCase()]
if (known === undefined) process.exit(TAU_RUN)
writeFileSync(definition, `${known}\n`)
// Ending normally exits 0, TAU_SKIP: the agent does not run, and this is the run's final text.
console.log(known)
