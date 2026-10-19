import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Context, Service } from '@deepseek-ai/cordis'
import * as dshToolFs from '@deepseek-ai/dsh-tool-fs'
import * as TauToolFs from './tool-fs.ts'
import { withDeps } from './tool-fs.ts'

/** A one-pixel PNG's bytes. */
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64')

interface Tool {
  execute(args: unknown, exec: unknown): Promise<unknown>
}

class Tools extends Service {
  readonly tools = new Map<string, Tool>()
  constructor(ctx: Context) { super(ctx, 'tools') }
  register(tool: Tool & { name: string }): () => void {
    this.tools.set(tool.name, tool)
    return () => this.tools.delete(tool.name)
  }
}

class SystemPrompt extends Service {
  constructor(ctx: Context) { super(ctx, 'systemPrompt') }
  section(): () => void { return () => {} }
  getSectionOrder(): number { return 0 }
}

class Attachments extends Service {
  readonly imageLimits = {
    mediaTypes: ['image/png'], maxImageBytes: 1 << 20, maxMessageImageBytes: 1 << 20, maxImageDimension: 8000, maxImagePixels: 1 << 24,
  }

  constructor(ctx: Context) { super(ctx, 'attachments') }
  async saveImage({ data, mediaType }: { data: Uint8Array, mediaType: string }) {
    return { attachmentId: 'att-1', mediaType, bytes: data.length, width: 1, height: 1 }
  }
}

class Llm extends Service {
  constructor(ctx: Context) { super(ctx, 'llm') }
  async resolveModelInfo() { return { inputModalities: ['text', 'image'] } }
}

/** A file system with one image, `/tau/in/pic.png`, whose display path says whose it is. */
function fsOf(owner: string) {
  return class extends Service {
    constructor(ctx: Context) { super(ctx, 'fs') }
    async resolve(path: string) { return { key: `${owner}:${path}`, displayPath: `${owner}:${path}`, processPath: path } }
    async stat() { return { type: 'file', size: PNG.length, version: owner } }
    async readBytes() { return PNG }
  }
}

/** A context whose host fs is not the box's, the box's isolated in a group, as the tau preset's `box` group has it, with `plugin` in it. */
async function readImage(plugin: unknown): Promise<unknown> {
  const root = new Context()
  await root.plugin(Tools)
  await root.plugin(SystemPrompt)
  await root.plugin(Attachments)
  await root.plugin(Llm)
  await root.plugin(fsOf('host'))
  const box = root.isolate('fs')
  await box.plugin(fsOf('box'))
  await box.plugin(plugin as typeof TauToolFs, {})
  await new Promise(resolve => setTimeout(resolve, 20))
  const tool = (root as unknown as { tools: Tools }).tools.tools.get('read_image')
  assert.ok(tool, 'read_image is registered')
  const agent = { session: { header: { cwd: '/tau/workspace' }, requestHeader: () => undefined }, options: { provider: 'mock', model: 'mock-model' } }
  return tool.execute({ file_path: '/tau/in/pic.png' }, { agent, signal: new AbortController().signal })
}

test('dsh\'s tool-fs alone cannot read an image from an isolated fs, as cordis 4.0.4 looks it up', async () => {
  await assert.rejects(readImage(dshToolFs), /cannot get property "fs" without inject/)
})

test('in the box, read_image reads the box\'s image', async () => {
  assert.deepEqual(await readImage(TauToolFs), {
    path: 'box:/tau/in/pic.png',
    image: { attachmentId: 'att-1', mediaType: 'image/png', bytes: PNG.length, width: 1, height: 1 },
  })
})

test('a nested inject requires the extra services too, in either form', () => {
  assert.deepEqual(withDeps(['attachments'], ['tools', 'fs']), ['attachments', 'tools', 'fs'])
  assert.deepEqual(withDeps(['fs'], ['tools', 'fs']), ['fs', 'tools'])
  assert.deepEqual(withDeps({ attachments: { x: 1 }, fs: null }, ['tools', 'fs']), { attachments: { x: 1 }, fs: null, tools: null })
})
