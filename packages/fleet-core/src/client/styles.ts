/**
 * The tau model page's styles, as dsh's own settings pages style their
 * fields, in one style element the page adds to the document once, which
 * the web client's module loader removes with the plugin, by its
 * `data-plugin`.
 */

const PLUGIN = '@sleepymug/fleet-core'
const TAG = `${PLUGIN}/tau-model.css`

/** The page's class names. */
export const classes = {
  fields: 'fleet-tau-model-fields',
  field: 'fleet-tau-model-field',
  label: 'fleet-tau-model-label',
  select: 'fleet-tau-model-select',
  hint: 'fleet-tau-model-hint',
  notice: 'fleet-tau-model-notice',
  alert: 'fleet-tau-model-alert',
}

const CSS = `
.${classes.fields}{display:flex;flex-direction:column;gap:16px}
.${classes.field}{display:flex;flex-direction:column;gap:6px}
.${classes.label}{color:var(--dsw-alias-label-secondary);font-size:12px;font-weight:500;line-height:18px}
.${classes.select}{box-sizing:border-box;border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-md);width:100%;max-width:360px;height:32px;font:inherit;font-size:14px;line-height:22px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);cursor:pointer;appearance:none;padding:0 32px 0 10px;background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12' fill='none'%3E%3Cpath d='M3 4.5L6 7.5L9 4.5' stroke='%2381858C' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");background-position:right 12px center;background-repeat:no-repeat;background-size:12px 12px}
.${classes.select}:focus{border-color:var(--dsw-alias-state-business-primary);outline:none}
.${classes.select}:disabled{opacity:.6;cursor:default}
.${classes.hint}{color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px;margin:0}
.${classes.notice}{color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px;margin:0}
.${classes.alert}{display:flex;align-items:center;gap:8px;color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px}
`

/** Add the page's style element, unless the document has it. */
export function addStyles(): void {
  if (typeof document === 'undefined' || document.querySelector(`style[data-plugin-css=${JSON.stringify(TAG)}]`) !== null) return
  const tag = document.createElement('style')
  tag.dataset['plugin'] = PLUGIN
  tag.dataset['pluginCss'] = TAG
  tag.textContent = CSS
  document.head.appendChild(tag)
}
