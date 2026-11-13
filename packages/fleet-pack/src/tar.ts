/**
 * Tar archives, as fleet writes and reads them: POSIX.1-2001's pax format,
 * as far as fleet uses it. Regular files, directories and symlinks, a pax
 * extended header (`x`) for a name, a target or a size that does not fit
 * the ustar header, and the two zero blocks at the end, with nothing but
 * zeros after them. Written and read in one pass, so a large file is never
 * held whole. The reader takes GNU tar's archives too, its long names
 * among them, as far as they keep to these entries, so `tar -c` of a
 * folder reads as fleet's own.
 * @module @sleepymug/fleet-pack/tar
 */

/** What an entry is. */
export type EntryType = 'file' | 'dir' | 'symlink'

/** An entry's header. */
export interface TarHeader {
  /** Relative, `/`-separated, a directory's without its trailing `/`. */
  readonly name: string
  readonly type: EntryType
  /** The permission bits, `mode & 0o777`. */
  readonly mode: number
  /** A file's size in bytes; 0 for anything else. */
  readonly size: number
  /** A symlink's target. */
  readonly target?: string
}

/** An entry to write: a file's bytes are read as it is written, and must be `size` of them. */
export interface WriteEntry extends TarHeader {
  readonly body?: () => AsyncIterable<Uint8Array>
}

/** An entry read: a file's bytes are read once, before the next entry; those left unread are skipped. */
export interface TarEntry extends TarHeader {
  readonly body: AsyncIterable<Uint8Array>
}

/** An archive that is not one fleet reads, as opposed to one that could not be read. */
export class ArchiveError extends Error {}

const BLOCK = 512
/** The largest size the ustar header holds: 11 octal digits. */
const MAX_SIZE = 0o77777777777
const ZEROS = Buffer.alloc(BLOCK * 2)
const TYPES: Readonly<Record<string, EntryType>> = { 0: 'file', '\0': 'file', 5: 'dir', 2: 'symlink' }
const FLAGS: Readonly<Record<EntryType, string>> = { file: '0', dir: '5', symlink: '2' }
/** What each other type flag is, for a reader's refusal. */
const OTHERS: Readonly<Record<string, string>> = {
  1: 'a hard link',
  3: 'a character device',
  4: 'a block device',
  6: 'a FIFO',
  7: 'a contiguous file',
}
const utf8 = new TextDecoder('utf-8', { fatal: true })

/** The archive of `entries`, in their order, ended. */
export async function* writeTar(entries: AsyncIterable<WriteEntry> | Iterable<WriteEntry>): AsyncGenerator<Uint8Array> {
  for await (const entry of entries) {
    yield* headerOf(entry)
    if (entry.type !== 'file') continue
    let written = 0
    for await (const chunk of entry.body?.() ?? []) {
      written += chunk.length
      if (written > entry.size) throw new Error(`${entry.name}: grew while it was written`)
      yield chunk
    }
    if (written !== entry.size) throw new Error(`${entry.name}: shrank while it was written`)
    if (written % BLOCK !== 0) yield Buffer.alloc(BLOCK - (written % BLOCK))
  }
  yield ZEROS
}

/**
 * The entries of an archive, checked as they are read: each a regular
 * file, a directory or a symlink, with a relative name and no `.` or `..`
 * in it, and the archive ended by two zero blocks, and nothing but zeros
 * after; a pax global header is passed over.
 * @throws ArchiveError, naming `what`, for an archive that is not one.
 */
export async function* readTar(bytes: AsyncIterable<Uint8Array>, what = 'the archive'): AsyncGenerator<TarEntry> {
  const input = new Input(bytes)
  const refuse = (problem: string): never => {
    throw new ArchiveError(`${what} is not one fleet reads: ${problem}`)
  }
  let extended: Map<string, string> | undefined
  // GNU tar's long name and long link target, for the entry after them.
  let gnu: { name?: string; target?: string } = {}
  for (;;) {
    const head = await input.exactly(BLOCK)
    if (head === undefined) return refuse('it ends without the two zero blocks that end an archive')
    if (head.every(byte => byte === 0)) {
      const second = await input.exactly(BLOCK)
      if (second === undefined || !second.every(byte => byte === 0)) return refuse('a zero block is not followed by another')
      if (extended !== undefined) return refuse('it ends after a pax extended header')
      if (!(await input.onlyZeros())) return refuse('there are bytes other than zeros after its end')
      return
    }
    const problem = headerProblem(head)
    if (problem !== undefined) return refuse(problem)
    const flag = String.fromCharCode(head[156] as number)
    let size = octal(head, 124, 12)
    if (size === undefined) return refuse('a header\'s size is not a number')
    if (flag === 'L' || flag === 'K') {
      const data = await input.exactly(size)
      if (data === undefined) return refuse('it ends in a GNU long name')
      await input.exactly(padding(size))
      const end = data.indexOf(0)
      let value: string
      try {
        value = utf8.decode(end < 0 ? data : data.subarray(0, end))
      } catch {
        return refuse('a GNU long name is not UTF-8')
      }
      gnu = flag === 'L' ? { ...gnu, name: value } : { ...gnu, target: value }
      continue
    }
    if (flag === 'x' || flag === 'g') {
      const records = await input.exactly(size)
      if (records === undefined) return refuse('it ends in a pax header')
      await input.exactly(padding(size))
      if (flag === 'g') continue
      if (extended !== undefined) return refuse('a pax extended header follows another')
      extended = paxRecords(records) ?? refuse('a pax extended header is malformed')
      continue
    }
    const type = TYPES[flag]
    // The ustar fields only where no pax record takes their place, since a writer may cut them anywhere.
    let name = extended?.get('path') ?? gnu.name
    if (name === undefined) {
      const [short, prefix] = [text(head, 0, 100), text(head, 345, 155)]
      if (short === undefined || prefix === undefined) return refuse('a name is not UTF-8')
      name = prefix === '' || isGnu(head) ? short : `${prefix}/${short}`
    }
    const target = extended?.get('linkpath') ?? gnu.target ?? text(head, 157, 100)
    gnu = {}
    if (target === undefined) return refuse(`${name}: its symlink's target is not UTF-8`)
    if (extended !== undefined) {
      const paxSize = extended.get('size')
      if (paxSize !== undefined) {
        if (!/^[0-9]+$/u.test(paxSize)) return refuse(`${name}: its pax size is not a number`)
        size = Number(paxSize)
      }
      extended = undefined
    }
    if (type === undefined) return refuse(`${name}: is ${OTHERS[flag] ?? `of type ${JSON.stringify(flag)}`}, which fleet does not read`)
    // `tar -c` names the folder it packs `./`, and what is in it `./<name>`.
    const named = name.replace(/^(?:\.\/)+/u, '')
    if (named === '' || named === '.') {
      await input.exactly(size + padding(size))
      continue
    }
    const nameProblem = entryNameProblem(named, type)
    if (nameProblem !== undefined) return refuse(`${name}: ${nameProblem}`)
    if (type !== 'file' && size !== 0) return refuse(`${name}: a ${type === 'dir' ? 'directory' : 'symlink'} has a size`)
    if (type === 'symlink' && target === '') return refuse(`${name}: a symlink has no target`)
    const mode = (octal(head, 100, 8) ?? refuse(`${name}: its mode is not a number`)) & 0o777
    const header = { name: named.replace(/\/$/u, ''), type, mode, size: type === 'file' ? size : 0 }
    const body = input.take(size, () => refuse(`${name}: the archive ends in its bytes`))
    yield type === 'symlink' ? { ...header, target, body } : { ...header, body }
    await body.skip()
    await input.exactly(padding(size))
  }
}

/** The ustar header, and a pax one before it when the name, the target or the size does not fit. */
function* headerOf(entry: WriteEntry): Generator<Uint8Array> {
  const name = entry.type === 'dir' ? `${entry.name}/` : entry.name
  const target = entry.target ?? ''
  const size = entry.type === 'file' ? entry.size : 0
  const records: [string, string][] = []
  if (Buffer.byteLength(name) > 100) records.push(['path', name])
  if (Buffer.byteLength(target) > 100) records.push(['linkpath', target])
  if (size > MAX_SIZE) records.push(['size', String(size)])
  if (records.length > 0) {
    const data = Buffer.concat(records.map(([key, value]) => paxRecord(key, value)))
    yield block({ name: 'PaxHeader', flag: 'x', mode: 0o644, size: data.length, target: '' })
    yield data
    if (data.length % BLOCK !== 0) yield Buffer.alloc(BLOCK - (data.length % BLOCK))
  }
  yield block({ name, flag: FLAGS[entry.type], mode: entry.mode & 0o777, size: Math.min(size, MAX_SIZE), target })
}

/** A ustar header block; a name or a target too long for its field is cut, a pax header having it whole. */
function block(fields: { name: string; flag: string; mode: number; size: number; target: string }): Buffer {
  const head = Buffer.alloc(BLOCK)
  fit(head, fields.name, 0, 100)
  head.write(octalField(fields.mode, 8), 100, 'ascii')
  head.write(octalField(0, 8), 108, 'ascii')
  head.write(octalField(0, 8), 116, 'ascii')
  head.write(octalField(fields.size, 12), 124, 'ascii')
  head.write(octalField(0, 12), 136, 'ascii')
  head.write(' '.repeat(8), 148, 'ascii')
  head.write(fields.flag, 156, 'ascii')
  fit(head, fields.target, 157, 100)
  head.write('ustar\u000000', 257, 'ascii')
  head.write(octalField(0, 8), 329, 'ascii')
  head.write(octalField(0, 8), 337, 'ascii')
  head.write(`${octalField(checksum(head), 7)} `, 148, 'ascii')
  return head
}

/** Write as much of `value` as fits in the field, never part of a character. */
function fit(head: Buffer, value: string, offset: number, length: number): void {
  let bytes = Buffer.from(value)
  if (bytes.length > length) {
    let end = length
    // Back off continuation bytes, so that the cut falls between characters.
    while (end > 0 && ((bytes[end] as number) & 0xc0) === 0x80) end--
    bytes = bytes.subarray(0, end)
  }
  bytes.copy(head, offset)
}

/** `value` in octal, zero-padded, ended by a NUL, in a field of `length`. */
function octalField(value: number, length: number): string {
  return `${value.toString(8).padStart(length - 1, '0')}\0`
}

function checksum(head: Uint8Array): number {
  return head.reduce((sum, byte) => sum + byte, 0)
}

/** A pax record, `<length> <key>=<value>\n`, its length counting itself. */
function paxRecord(key: string, value: string): Buffer {
  const rest = Buffer.byteLength(` ${key}=${value}\n`)
  let length = rest + 1
  while (String(length).length + rest !== length) length = String(length).length + rest
  return Buffer.from(`${length} ${key}=${value}\n`)
}

/** The records of a pax extended header, or undefined when it is malformed. */
function paxRecords(data: Buffer): Map<string, string> | undefined {
  const records = new Map<string, string>()
  let at = 0
  while (at < data.length) {
    const space = data.indexOf(0x20, at)
    if (space < 0) return undefined
    const length = Number(data.subarray(at, space).toString('ascii'))
    if (!Number.isInteger(length) || length <= space - at + 1 || at + length > data.length || data[at + length - 1] !== 0x0a) return undefined
    let record: string
    try {
      record = utf8.decode(data.subarray(space + 1, at + length - 1))
    } catch {
      return undefined
    }
    const equals = record.indexOf('=')
    if (equals <= 0) return undefined
    records.set(record.slice(0, equals), record.slice(equals + 1))
    at += length
  }
  return records
}

/** GNU tar's own magic, whose header has no ustar prefix field. */
function isGnu(head: Buffer): boolean {
  return head.toString('latin1', 257, 265) === 'ustar  \0'
}

/** Why a header is not one this reader takes: its checksum, or its format. */
function headerProblem(head: Buffer): string | undefined {
  const stored = octal(head, 148, 8)
  const blank = Buffer.from(head)
  blank.write(' '.repeat(8), 148, 'ascii')
  if (stored === undefined || stored !== checksum(blank)) return 'a header\'s checksum does not match it'
  const ustar = head.toString('latin1', 257, 263) === 'ustar\0' && head.toString('latin1', 263, 265) === '00'
  if (!ustar && !isGnu(head)) return 'a header is of neither the ustar format, which pax extends, nor GNU tar\'s'
  return undefined
}

/** A NUL- or space-ended octal field, or undefined when it is not one. */
function octal(head: Buffer, offset: number, length: number): number | undefined {
  const field = head.toString('latin1', offset, offset + length).replace(/[\0 ]+$/u, '').replace(/^ +/u, '')
  return /^[0-7]+$/u.test(field) ? Number.parseInt(field, 8) : field === '' ? 0 : undefined
}

/** A NUL-ended text field, or undefined when it is not UTF-8. */
function text(head: Buffer, offset: number, length: number): string | undefined {
  const field = head.subarray(offset, offset + length)
  const end = field.indexOf(0)
  try {
    return utf8.decode(end < 0 ? field : field.subarray(0, end))
  } catch {
    return undefined
  }
}

/** Why a name is not an entry's: relative, with no empty, `.` or `..` component, and no NUL. */
function entryNameProblem(name: string, type: EntryType): string | undefined {
  const trimmed = type === 'dir' ? name.replace(/\/$/u, '') : name
  if (trimmed.startsWith('/')) return 'a name is relative'
  if (trimmed.includes('\0')) return 'a name holds no NUL'
  if (trimmed.split('/').some(part => part === '' || part === '.' || part === '..')) return 'a name has no empty, `.` or `..` component'
  return undefined
}

function padding(size: number): number {
  return (BLOCK - (size % BLOCK)) % BLOCK
}

/** Bytes, read in one pass, as many at a time as asked. */
class Input {
  private readonly iterator: AsyncIterator<Uint8Array>
  private buffered: Buffer = Buffer.alloc(0)
  private ended = false

  constructor(bytes: AsyncIterable<Uint8Array>) {
    this.iterator = bytes[Symbol.asyncIterator]()
  }

  /** The next `count` bytes, or undefined when fewer are left. */
  async exactly(count: number): Promise<Buffer | undefined> {
    while (this.buffered.length < count) if (!(await this.fill())) return undefined
    const taken = this.buffered.subarray(0, count)
    this.buffered = this.buffered.subarray(count)
    return taken
  }

  /** Whether every byte left, if any, is zero, reading them all. */
  async onlyZeros(): Promise<boolean> {
    for (;;) {
      if (!this.buffered.every(byte => byte === 0)) return false
      this.buffered = Buffer.alloc(0)
      if (!(await this.fill())) return true
    }
  }

  /** The next `count` bytes as they come, readable once; `short` throws when fewer are left. */
  take(count: number, short: () => never): AsyncIterable<Uint8Array> & { skip(): Promise<void> } {
    let left = count
    const next = async (): Promise<Buffer | undefined> => {
      if (left === 0) return undefined
      if (this.buffered.length === 0 && !(await this.fill())) short()
      const chunk = this.buffered.subarray(0, Math.min(left, this.buffered.length))
      this.buffered = this.buffered.subarray(chunk.length)
      left -= chunk.length
      return chunk
    }
    let read = false
    return {
      async *[Symbol.asyncIterator]() {
        if (read) throw new Error('an entry\'s bytes are read once')
        read = true
        for (let chunk = await next(); chunk !== undefined; chunk = await next()) yield chunk
      },
      async skip() {
        while ((await next()) !== undefined);
      },
    }
  }

  private async fill(): Promise<boolean> {
    if (this.ended) return false
    const { done, value } = await this.iterator.next()
    if (done === true) {
      this.ended = true
      return false
    }
    this.buffered = this.buffered.length === 0 ? Buffer.from(value) : Buffer.concat([this.buffered, value])
    return true
  }
}
