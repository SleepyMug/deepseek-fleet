/**
 * The tau model page's state: fleet-tau-model's config as dsh's settings
 * serve it, a draft of the model and effort a person chose, staged until
 * saved or discarded, and dsh's model catalog, loaded when the page first
 * shows and again when the host's models change. A save writes the three
 * fields at once, fenced by the revision the draft was made on, so it does
 * not overwrite a change made meanwhile; a change made meanwhile to what
 * the draft does not match marks it conflicted, to discard.
 * @module @sleepymug/fleet-core/client/controller
 */

import type { ModelCatalog, RemoteResult, SettingsPathOpView } from '@deepseek-ai/dsh-api-remotes/client'
import type { ConfigFormSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
import { choicesOf, effortsOf, routeKey, routeOf, sameRoute } from './catalog.ts'
import type { Choices, Efforts, Route, TauModelValue } from './catalog.ts'

/** fleet-tau-model's form, as `ctx.configForms.get` gives it. */
export interface TauModelForm {
  getSnapshot(): ConfigFormSnapshot<TauModelValue>
  subscribe(listener: () => void): () => void
  mutate(ops: readonly SettingsPathOpView[], expectedRevision?: number): Promise<boolean>
}

/** Where the catalog comes from, `ctx.remote.session`. */
export interface CatalogSource {
  modelCatalog(): Promise<RemoteResult<ModelCatalog>>
}

/** What the page shows. */
export interface TauModelState {
  /** Whether dsh's settings serve fleet-tau-model to this client. */
  readonly available: boolean
  /** Whether a save can write the profile. */
  readonly writable: boolean
  /** Whether the draft differs from what is saved. */
  readonly dirty: boolean
  /** Whether the draft cannot be saved: it conflicts with what was saved meanwhile. */
  readonly invalid: boolean
  readonly saving: boolean
  /** Whether the last save did not land. */
  readonly failed: boolean
  /** Whether what is saved changed, elsewhere, while the draft was made. */
  readonly conflicted: boolean
  readonly catalogStatus: 'idle' | 'loading' | 'ready' | 'error'
  /** Whether some provider's models could not be listed. */
  readonly catalogPartial: boolean
  /** The model shown, the draft's or the saved one; none for dsh's default. */
  readonly route: Route | null
  /** The effort shown; none for the model's own. */
  readonly effort: string | null
  readonly choices: Choices
  /** The efforts of the model shown. */
  readonly efforts: Efforts
}

/** An observable value, as dsh's slots take a page's state. */
export interface Store<T> {
  getSnapshot(): T
  subscribe(listener: () => void): () => void
}

interface Draft {
  route: Route | null
  effort: string | null
  revision: number | undefined
}

export class TauModelController {
  readonly store: Store<TauModelState>
  private state: TauModelState
  private readonly listeners = new Set<() => void>()
  private draft: Draft | undefined
  private saving = false
  private failed = false
  private conflicted = false
  private catalog: ModelCatalog | undefined
  private catalogStatus: TauModelState['catalogStatus'] = 'idle'
  /** A load carries the catalog's generation it began in, a save the saves'; one that settles after a refresh, a reset or a dispose is dropped. */
  private catalogGeneration = 0
  private saveGeneration = 0
  private disposed = false
  private readonly unsubscribe: () => void

  constructor(private readonly form: TauModelForm, private readonly source: CatalogSource) {
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
        if (this.matches(draft)) this.draft = undefined
        else this.conflicted = true
      }
      this.publish()
    })
  }

  /** Load the catalog, unless it is loaded or loading. */
  load(): void {
    if (this.catalogStatus === 'idle' || this.catalogStatus === 'error') void this.loadCatalog()
  }

  /** Choose a model by its option value, `''` for dsh's default; its effort becomes the model's own. */
  chooseModel(key: string): void {
    const route = key === '' ? null : this.routes().find(candidate => routeKey(candidate) === key)
    if (route === undefined || !this.editable()) return
    this.edit({ route, effort: null })
  }

  /** Choose an effort by its id, `''` for the model's own. */
  chooseEffort(id: string): void {
    if (!this.editable()) return
    this.edit({ effort: id === '' ? null : id })
  }

  async save(): Promise<void> {
    const snapshot = this.form.getSnapshot()
    const draft = this.draft
    if (draft === undefined || this.saving || this.conflicted || !snapshot.writable || this.matches(draft)) return
    const generation = this.saveGeneration
    this.saving = true
    this.failed = false
    this.publish()
    const set = (field: keyof TauModelValue, value: string | null): SettingsPathOpView =>
      value === null ? { op: 'unset', path: [field] } : { op: 'set', path: [field], value }
    let accepted = false
    try {
      accepted = await this.form.mutate([
        set('provider', draft.route?.provider ?? null),
        set('model', draft.route?.model ?? null),
        set('reasoningEffort', draft.effort),
      ], draft.revision)
    } catch {
      accepted = false
    }
    if (generation !== this.saveGeneration) return
    this.saving = false
    const landed = accepted && this.matches(draft)
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

  /** Load the catalog again, as after the host's models changed. */
  refreshCatalog(): void {
    if (this.disposed) return
    this.catalogGeneration += 1
    const wanted = this.catalogStatus !== 'idle'
    this.catalogStatus = 'idle'
    if (wanted) void this.loadCatalog()
    else this.publish()
  }

  /** Forget the host's state, after a reconnect, and reload what was loaded. */
  resetConnection(): void {
    if (this.disposed) return
    this.saveGeneration += 1
    this.saving = false
    this.draft = undefined
    this.failed = false
    this.conflicted = false
    this.catalog = undefined
    this.refreshCatalog()
  }

  dispose(): void {
    this.disposed = true
    this.catalogGeneration += 1
    this.saveGeneration += 1
    this.unsubscribe()
    this.listeners.clear()
  }

  private async loadCatalog(): Promise<void> {
    if (this.disposed) return
    const generation = this.catalogGeneration
    this.catalogStatus = 'loading'
    this.publish()
    let response: RemoteResult<ModelCatalog> | undefined
    try {
      response = await this.source.modelCatalog()
    } catch {
      response = undefined
    }
    if (generation !== this.catalogGeneration) return
    if (response?.ok === true) {
      this.catalog = response.value
      this.catalogStatus = 'ready'
    } else {
      this.catalogStatus = 'error'
    }
    this.publish()
  }

  private edit(change: Partial<Pick<Draft, 'route' | 'effort'>>): void {
    const saved = this.saved()
    const draft = this.draft ?? { ...saved, revision: this.form.getSnapshot().revision }
    this.draft = { ...draft, ...change }
    if (this.matches(this.draft)) {
      this.draft = undefined
      this.conflicted = false
    }
    this.failed = false
    this.publish()
  }

  private editable(): boolean {
    const snapshot = this.form.getSnapshot()
    return !this.disposed && snapshot.status === 'ready' && snapshot.writable && !this.saving
  }

  /** The route and effort saved now. */
  private saved(): Pick<Draft, 'route' | 'effort'> {
    const value = this.form.getSnapshot().value
    return { route: routeOf(value), effort: value?.reasoningEffort || null }
  }

  private matches(draft: Pick<Draft, 'route' | 'effort'>): boolean {
    const saved = this.saved()
    return sameRoute(saved.route, draft.route) && saved.effort === draft.effort
  }

  /** Every route offered now. */
  private routes(): Route[] {
    const choices = choicesOf(this.catalog, this.saved().route)
    return [...choices.groups.flatMap(group => group.models.map(model => model.route)), ...choices.unavailable === undefined ? [] : [choices.unavailable.route]]
  }

  private project(): TauModelState {
    const snapshot = this.form.getSnapshot()
    const saved = this.saved()
    const shown = this.draft ?? saved
    return {
      available: snapshot.status === 'ready',
      writable: snapshot.writable,
      dirty: this.draft !== undefined,
      invalid: this.conflicted,
      saving: this.saving,
      failed: this.failed,
      conflicted: this.conflicted,
      catalogStatus: this.catalogStatus,
      catalogPartial: (this.catalog?.failures.length ?? 0) > 0,
      route: shown.route,
      effort: shown.effort,
      choices: choicesOf(this.catalog, saved.route),
      efforts: effortsOf(this.catalog, shown.route),
    }
  }

  private publish(): void {
    if (this.disposed) return
    this.state = this.project()
    for (const listener of [...this.listeners]) listener()
  }
}
