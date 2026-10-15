/**
 * The tau model page, on the Plugins page's fleet-tau-model row: the model
 * every tau's session starts on, a drop-down of the models the chat box's
 * picker offers, by provider, with dsh's default first, and its reasoning
 * efforts, with the model's own first; saved together, as dsh's settings
 * pages save, with the shared settings form.
 */

import { useEffect } from 'react'
import type { ReactNode } from 'react'
import { SettingsForm } from '@deepseek-ai/dsh-client-ui-primitives'
import type { Translate } from '@deepseek-ai/dsh-client-ui-slots'
import { routeKey } from './catalog.ts'
import type { TauModelState } from './controller.ts'
import type { TauModelKey } from './locales.ts'
import { classes } from './styles.ts'

/** What the page acts with, which the plugin injects (./index.ts). */
export interface TauModelFace {
  load(): void
  chooseModel(key: string): void
  chooseEffort(id: string): void
  save(): void
  discard(): void
}

export interface TauModelPageProps extends TauModelFace {
  readonly view: 'summary' | 'page'
  readonly t: Translate<TauModelKey>
  useTauModel<S>(selector: (state: TauModelState) => S): S
}

export function TauModelPage(props: TauModelPageProps): ReactNode {
  const { t, view } = props
  const state = props.useTauModel(snapshot => snapshot)
  useEffect(() => {
    if (view === 'page') props.load()
  }, [view])
  if (view === 'summary') return t('summary')
  const { choices, efforts } = state
  const disabled = !state.writable || state.saving
  const defaultEffort = efforts.efforts.find(effort => effort.id === efforts.defaultEffort)
  const effortOffered = state.effort === null || efforts.efforts.some(effort => effort.id === state.effort)
  return (
    <SettingsForm
      labels={{ unavailable: t('unavailable'), readOnly: t('readOnly'), saveFailed: t('saveFailed'), save: t('save'), saving: t('saving') }}
      state={state}
      onSave={props.save}
      onDiscard={props.discard}
    >
      <div className={classes.fields}>
        <p className={classes.hint}>{t('hint')}</p>
        <label className={classes.field}>
          <span className={classes.label}>{t('modelLabel')}</span>
          <select
            className={classes.select}
            value={state.route === null ? '' : routeKey(state.route)}
            disabled={disabled}
            onChange={(event) => { props.chooseModel(event.target.value) }}
          >
            <option value="">{choices.defaultModel === undefined ? t('modelDefaultUnnamed') : t('modelDefault', { name: choices.defaultModel.name })}</option>
            {choices.groups.map(group => (
              <optgroup key={group.provider} label={group.name}>
                {group.models.map(model => <option key={model.key} value={model.key}>{model.name}</option>)}
              </optgroup>
            ))}
            {choices.unavailable === undefined ? null : (
              <optgroup label={t('unavailableGroup')}>
                <option value={choices.unavailable.key}>{choices.unavailable.name}</option>
              </optgroup>
            )}
          </select>
        </label>
        {efforts.efforts.length === 0 && state.effort === null ? null : (
          <label className={classes.field}>
            <span className={classes.label}>{t('effortLabel')}</span>
            <select
              className={classes.select}
              value={state.effort ?? ''}
              disabled={disabled}
              onChange={(event) => { props.chooseEffort(event.target.value) }}
            >
              <option value="">{defaultEffort === undefined ? t('effortDefaultUnnamed') : t('effortDefault', { name: defaultEffort.name })}</option>
              {efforts.efforts.map(effort => <option key={effort.id} value={effort.id}>{effort.name}</option>)}
              {effortOffered || state.effort === null ? null : <option value={state.effort}>{t('effortUnavailable', { id: state.effort })}</option>}
            </select>
          </label>
        )}
        {state.catalogStatus === 'loading' ? <p className={classes.notice} role="status">{t('loading')}</p> : null}
        {state.catalogStatus === 'error'
          ? (
              <div className={classes.alert} role="alert">
                <span>{t('loadFailed')}</span>
                <button type="button" onClick={props.load}>{t('retry')}</button>
              </div>
            )
          : null}
        {state.catalogPartial ? <p className={classes.notice}>{t('partial')}</p> : null}
        {state.conflicted ? <p className={classes.notice} role="status">{t('conflict')}</p> : null}
      </div>
    </SettingsForm>
  )
}
