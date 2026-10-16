/**
 * The tau lanes page's state: fleet-tau-lanes' config as dsh's settings
 * serve it, and a draft of the number of lanes a person typed, staged until
 * saved or discarded. A draft that is not a whole number from 1 cannot be
 * saved; an empty one is no cap. A save is fenced by the revision the
 * draft was made on, as the tau model page's (./controller.ts).
 * @module @sleepymug/fleet-core/client/lanes-controller
 */

import type { SettingsPathOpView } from '@deepseek-ai/dsh-api-remotes/client'
import type { ConfigFormSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { Store } from './controller.ts'

/** fleet-tau-lanes' config, as dsh's settings serve it. */
export interface TauLanesValue {
  readonly lanes?: number | undefined
}

/** fleet-tau-lanes' form, as `ctx.configForms.get` gives it. */
export interface TauLanesForm {
  getSnapshot(): ConfigFormSnapshot<TauLanesValue>
  subscribe(listener: () => void): () => void
  mutate(ops: readonly SettingsPathOpView[], expectedRevision?: number): Promise<boolean>
}

/** What the page shows. */
export interface TauLanesState {
  readonly available: boolean
  readonly writable: boolean
  readonly dirty: boolean
  /** Whether the draft cannot be saved: not a number of lanes, or in conflict with what was saved meanwhile. */
  readonly invalid: boolean
  /** Whether the draft is not a whole number from 1. */
  readonly malformed: boolean
  readonly saving: boolean
  readonly failed: boolean
  readonly conflicted: boolean
  /** The number of lanes shown, as typed, or as saved; empty for no cap. */
  readonly text: string
}

interface Draft {
  text: string
  revision: number | undefined
}

/** The lanes `text` names: none for empty, a whole number from 1, or undefined for neither. */
export function lanesOf(text: string): number | null | undefined {
  const trimmed = text.trim()
  if (trimmed === '') return null
  return /^[1-9][0-9]*$/u.test(trimmed) && Number.isSafeInteger(Number(trimmed)) ? Number(trimmed) : undefined
}

export class TauLanesController {
  readonly store: Store<TauLanesState>
  private state: TauLanesState
  private readonly listeners = new Set<() => void>()
  private draft: Draft | undefined
  private saving = false
  private failed = false
  private conflicted = false
  /** A save carries the saves' generation it began in; one that settles after a reset or a dispose is dropped. */
  private generation = 0
  private disposed = false
  private readonly unsubscribe: () => void

  constructor(private readonly form: TauLanesForm) {
    this.state = this.project()
    this.store = {
      getSnapshot: () => this.state,
      subscribe: (listener) => {
        this.listeners.add(listener)
        return () => { this.listeners.delete(listener) }
      },
    }
    this.unsubscribe = form.subscribe(() => {
      const draft = this.draft
      if (!this.saving && draft !== undefined && form.getSnapshot().revision !== draft.revision) {
        if (this.matches(draft.text)) this.draft = undefined
        else this.conflicted = true
      }
      this.publish()
    })
  }

  /** Type the number of lanes; empty for no cap. */
  type(text: string): void {
    const snapshot = this.form.getSnapshot()
    if (this.disposed || snapshot.status !== 'ready' || !snapshot.writable || this.saving) return
    this.draft = { text, revision: this.draft?.revision ?? snapshot.revision }
    if (this.matches(text)) {
      this.draft = undefined
      this.conflicted = false
    }
    this.failed = false
    this.publish()
  }

  async save(): Promise<void> {
    const draft = this.draft
    const lanes = draft === undefined ? undefined : lanesOf(draft.text)
    if (draft === undefined || lanes === undefined || this.saving || this.conflicted || !this.form.getSnapshot().writable) return
    const generation = this.generation
    this.saving = true
    this.failed = false
    this.publish()
    let accepted = false
    try {
      accepted = await this.form.mutate([lanes === null ? { op: 'unset', path: ['lanes'] } : { op: 'set', path: ['lanes'], value: lanes }], draft.revision)
    } catch {
      accepted = false
    }
    if (generation !== this.generation) return
    this.saving = false
    const landed = accepted && this.matches(draft.text)
    this.failed = !landed
    if (landed) this.draft = undefined
    this.publish()
  }

  discard(): void {
    if (this.saving) return
    this.draft = undefined
    this.failed = false
    this.conflicted = false
    this.publish()
  }

  /** Forget the host's state, after a reconnect. */
  resetConnection(): void {
    if (this.disposed) return
    this.generation += 1
    this.saving = false
    this.discard()
  }

  dispose(): void {
    this.disposed = true
    this.generation += 1
    this.unsubscribe()
    this.listeners.clear()
  }

  /** The lanes saved now; none for no cap. */
  private saved(): number | null {
    return this.form.getSnapshot().value?.lanes ?? null
  }

  private matches(text: string): boolean {
    return lanesOf(text) === this.saved()
  }

  private project(): TauLanesState {
    const snapshot = this.form.getSnapshot()
    const saved = this.saved()
    const text = this.draft?.text ?? (saved === null ? '' : String(saved))
    const malformed = lanesOf(text) === undefined
    return {
      available: snapshot.status === 'ready',
      writable: snapshot.writable,
      dirty: this.draft !== undefined,
      invalid: malformed || this.conflicted,
      malformed,
      saving: this.saving,
      failed: this.failed,
      conflicted: this.conflicted,
      text,
    }
  }

  private publish(): void {
    if (this.disposed) return
    this.state = this.project()
    for (const listener of [...this.listeners]) listener()
  }
}
