import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { ScriptedModel } from './model.ts'
import { render } from './render.ts'

async function folder(t: { after(fn: () => Promise<void>): void }): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'fleet-trace-test-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return dir
}

/** The model's streamed answer, as one object: its text, or its tool call. */
async function ask(port: number, messages: object[]): Promise<{ text: string; call?: { name: string; arguments: string } }> {
  const response = await fetch(`http://127.0.0.1:${String(port)}/v1/chat/completions`, { method: 'POST', body: JSON.stringify({ messages }) })
  let text = ''
  let call: { name: string; arguments: string } | undefined
  for (const line of (await response.text()).split('\n')) {
    if (!line.startsWith('data: {')) continue
    const delta = (JSON.parse(line.slice(6)) as { choices: { delta: { content?: string; tool_calls?: { function: { name: string; arguments: string } }[] } }[] }).choices[0]?.delta
    text += delta?.content ?? ''
    call ??= delta?.tool_calls?.[0]?.function
  }
  return { text, ...call === undefined ? {} : { call } }
}

test('the scripted model holds requests until it knows the prompt, answers the run with its steps, then its final text, anything else with a word, and keeps each request', async (t) => {
  const dir = await folder(t)
  const model = await ScriptedModel.start([{ tool: 'read', args: { file_path: '/tau/in/a.txt' } }], 'Done.', dir)
  t.after(() => model.close())
  // Held until the model knows the prompt.
  const title = ask(model.port, [{ role: 'user', content: 'Give a title.' }])
  await new Promise(resolve => setTimeout(resolve, 50))
  assert.deepEqual(await readdir(dir), [])
  model.prompt = 'Read the notes.'
  assert.deepEqual(await title, { text: 'Title' })
  const first = await ask(model.port, [{ role: 'system', content: 'You are…' }, { role: 'user', content: [{ type: 'text', text: 'Read the notes.\n' }] }])
  assert.deepEqual(first, { text: '', call: { name: 'read', arguments: '{"file_path":"/tau/in/a.txt"}' } })
  assert.deepEqual(await ask(model.port, [{ role: 'user', content: 'Read the notes.' }, { role: 'assistant' }, { role: 'tool', content: 'a' }]), { text: 'Done.' })
  assert.deepEqual(await readdir(dir), ['001.json', '002-run.json', '003-run.json'])
  assert.deepEqual(model.requests.map(request => request.run), [false, true, true])
})

test('the scripted model answers a run the run starts with the script whose phrase its prompt holds', async (t) => {
  const dir = await folder(t)
  const shout = { match: 'in capital letters', steps: [{ tool: 'write', args: { file_path: '/tau/out/r.txt', content: 'HI\n' } }], final: 'Shouted.' }
  const model = await ScriptedModel.start([], 'Relayed.', dir, [shout])
  t.after(() => model.close())
  model.prompt = 'Run shout.'
  const child = [{ role: 'user', content: 'Write hi in capital letters to /tau/out/r.txt.' }]
  assert.deepEqual(await ask(model.port, child), { text: '', call: { name: 'write', arguments: '{"file_path":"/tau/out/r.txt","content":"HI\\n"}' } })
  assert.deepEqual(await ask(model.port, [...child, { role: 'assistant' }, { role: 'tool', content: 'ok' }]), { text: 'Shouted.' })
  assert.deepEqual(await ask(model.port, [{ role: 'user', content: 'Run shout.' }]), { text: 'Relayed.' })
  assert.deepEqual(await readdir(dir), ['001-child.json', '002-child.json', '003-run.json'])
})

test('a request renders as its system prompt, its tools, and its conversation', async (t) => {
  const out = await folder(t)
  render({
    messages: [
      { role: 'system', content: 'You are an agent.' },
      { role: 'user', content: 'Count the words.' },
      { role: 'assistant', content: '', tool_calls: [{ id: 'call_1', function: { name: 'ts_execute', arguments: JSON.stringify({ source: 'export function main() { return 1 }\n', input: { a: 1 } }) } }] },
      { role: 'tool', tool_call_id: 'call_1', content: '{"value":1}' },
      { role: 'tool', tool_call_id: 'call_2', content: 'Error: {"name":"TypeCheckError"}' },
    ],
    tools: [{ function: { name: 'ts_execute' } }],
  }, out)
  assert.equal(await readFile(join(out, 'system-prompt.md'), 'utf8'), 'You are an agent.\n')
  assert.deepEqual(JSON.parse(await readFile(join(out, 'tools', 'ts_execute.json'), 'utf8')), { function: { name: 'ts_execute' } })
  const conversation = await readFile(join(out, 'conversation.md'), 'utf8')
  assert.match(conversation, /## user\n\nCount the words\./u)
  assert.match(conversation, /## assistant calls ts_execute \(call_1\)\n\n```json\n\{\n {2}"input": \{\n {4}"a": 1\n {2}\}\n\}\n```\n\n```ts\nexport function main\(\) \{ return 1 \}\n```/u)
  assert.match(conversation, /## tool result \(call_2\), an error/u)
})
