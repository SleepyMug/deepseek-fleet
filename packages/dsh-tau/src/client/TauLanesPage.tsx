/**
 * The tau lanes page, on the Plugins page's fleet-tau-lanes row: how many
 * of the taus' model calls stream at once, a number, empty for no cap;
 * saved as dsh's settings pages save, with the shared settings form.
 */

import type { ReactNode } from 'react'
import { SettingsForm } from '@deepseek-ai/dsh-client-ui-primitives'
import type { Translate } from '@deepseek-ai/dsh-client-ui-slots'
import type { TauLanesState } from './lanes-controller.ts'
import type { TauLanesKey } from './locales.ts'
import { classes } from './styles.ts'

/** What the page acts with, which the plugin injects (./index.ts). */
export interface TauLanesFace {
  type(text: string): void
  save(): void
  discard(): void
}

export interface TauLanesPageProps extends TauLanesFace {
  readonly view: 'summary' | 'page'
  readonly t: Translate<TauLanesKey>
  useTauLanes<S>(selector: (state: TauLanesState) => S): S
}

export function TauLanesPage(props: TauLanesPageProps): ReactNode {
  const { t, view } = props
  const state = props.useTauLanes(snapshot => snapshot)
  if (view === 'summary') return t('summary')
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
          <span className={classes.label}>{t('lanesLabel')}</span>
          <input
            className={classes.input}
            type="number"
            min={1}
            step={1}
            inputMode="numeric"
            placeholder={t('noCap')}
            value={state.text}
            disabled={!state.writable || state.saving}
            onChange={(event) => { props.type(event.target.value) }}
          />
        </label>
        {state.malformed ? <p className={classes.notice} role="alert">{t('malformed')}</p> : null}
        {state.conflicted ? <p className={classes.notice} role="status">{t('conflict')}</p> : null}
      </div>
    </SettingsForm>
  )
}
