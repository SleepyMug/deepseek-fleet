/**
 * fleet-core's browser half, which dsh's web client loads while the bundle
 * is on (scripts/client-bundle.mjs builds it): the tau model page, on the
 * Plugins page, for the fleet-tau-model row (../tau/model-plugin.ts), and
 * the tau lanes page, for the fleet-tau-lanes row (../tau/lanes-plugin.ts),
 * each while dsh's settings serve its row. The model page edits its row's config through dsh's settings
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
import { TauLanesController } from './lanes-controller.ts'
import type { TauLanesValue } from './lanes-controller.ts'
import { LANES_NS, NS, en, lanesEn, lanesZh, zh } from './locales.ts'
import type { TauLanesKey, TauModelKey } from './locales.ts'
import { addStyles } from './styles.ts'
import { TauModelPage } from './TauModelPage.tsx'
import type { TauModelFace } from './TauModelPage.tsx'
import { TauLanesPage } from './TauLanesPage.tsx'
import type { TauLanesFace } from './TauLanesPage.tsx'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'fleet.tauModel': TauModelKey
    'fleet.tauLanes': TauLanesKey
  }
}

/** The rows the pages configure, as fleet-core's cordis.patch.yml names them, and their keys on the Plugins page. */
const ROW = 'fleet-tau-model'
const KEY = `@sleepymug/fleet-core#${ROW}`
const LANES_ROW = 'fleet-tau-lanes'
const LANES_KEY = `@sleepymug/fleet-core#${LANES_ROW}`

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

  ctx.effect(() => ctx.locale.register(LANES_NS, { en: lanesEn, zh: lanesZh }), 'fleet-tau-lanes: dictionaries')
  const lanes = new TauLanesController(ctx.configForms.get<TauLanesValue>(LANES_ROW))
  ctx.effect(() => () => { lanes.dispose() }, 'fleet-tau-lanes: page state')
  ctx.effect(() => ctx.on('connection/reset', () => { lanes.resetConnection() }), 'fleet-tau-lanes: connection resets')
  const lanesFace: TauLanesFace & { hooks: { tauLanes: typeof lanes.store } } = {
    hooks: { tauLanes: lanes.store },
    type: (text) => { lanes.type(text) },
    save: () => { void lanes.save() },
    discard: () => { lanes.discard() },
  }
  ctx.effect(() => ctx.configForms.whileServed([LANES_ROW], () => ctx.slots.inject('plugins.row.config', () => ctx.slots.register({
    name: 'plugins.row.config',
    key: LANES_KEY,
    locale: LANES_NS,
    inject: () => lanesFace,
  }, TauLanesPage))), 'fleet-tau-lanes: page')
}
