/**
 * fleet-core's browser half, which dsh's web client loads while the bundle
 * is on (scripts/client-bundle.mjs builds it): the tau model page, on the
 * Plugins page, for the fleet-tau-model row (../tau/model-plugin.ts), while
 * dsh's settings serve it. It edits the row's config through dsh's settings
 * (`ctx.configForms`) and offers the models of the chat box's picker,
 * `remote.session.modelCatalog()`, loaded again as the host's models or
 * settings change, or the connection is reset. It imports nothing of
 * fleet-core's host half, which the browser has not.
 * @module @sleepymug/fleet-core/client
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type { TauModelValue } from './catalog.ts'
import { TauModelController } from './controller.ts'
import { NS, en, zh } from './locales.ts'
import type { TauModelKey } from './locales.ts'
import { addStyles } from './styles.ts'
import { TauModelPage } from './TauModelPage.tsx'
import type { TauModelFace } from './TauModelPage.tsx'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'fleet.tauModel': TauModelKey
  }
}

/** The row the page configures, as fleet-core's cordis.patch.yml names it, and its key on the Plugins page. */
const ROW = 'fleet-tau-model'
const KEY = `@sleepymug/fleet-core#${ROW}`

export const inject = ['slots', 'locale', 'remote', 'remote.session', 'configForms']

export function apply(ctx: Context): void {
  addStyles()
  ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'fleet-tau-model: dictionaries')
  const controller = new TauModelController(ctx.configForms.get<TauModelValue>(ROW), ctx.remote.session)
  ctx.effect(() => () => { controller.dispose() }, 'fleet-tau-model: page state')
  ctx.effect(() => ctx.remote.$on('llm/adapters-updated', () => { controller.refreshCatalog() }), 'fleet-tau-model: adapter changes')
  ctx.effect(() => ctx.remote.$on('settings/document-updated', () => { controller.refreshCatalog() }), 'fleet-tau-model: settings changes')
  ctx.effect(() => ctx.on('connection/reset', () => { controller.resetConnection() }), 'fleet-tau-model: connection resets')
  const face: TauModelFace & { hooks: { tauModel: typeof controller.store } } = {
    hooks: { tauModel: controller.store },
    load: () => { controller.load() },
    chooseModel: (key) => { controller.chooseModel(key) },
    chooseEffort: (id) => { controller.chooseEffort(id) },
    save: () => { void controller.save() },
    discard: () => { controller.discard() },
  }
  ctx.effect(() => ctx.configForms.whileServed([ROW], () => ctx.slots.inject('plugins.row.config', () => ctx.slots.register({
    name: 'plugins.row.config',
    key: KEY,
    locale: NS,
    inject: () => face,
  }, TauModelPage))), 'fleet-tau-model: page')
}
