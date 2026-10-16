/** The copy of fleet-core's pages, in the web client's built-in languages. */

/** The page's dictionary namespace. */
export const NS = 'fleet.tauModel'

/** English copy. */
export const en = {
  summary: 'The model every tau\'s session starts on.',
  hint: 'New tau sessions start on this model, in place of dsh\'s default. Switch one\'s model in its chat box, as any session\'s.',
  modelLabel: 'Model',
  modelDefault: 'dsh\'s default ({name})',
  modelDefaultUnnamed: 'dsh\'s default',
  unavailableGroup: 'Saved but currently unavailable',
  effortLabel: 'Reasoning effort',
  effortDefault: 'The model\'s default ({name})',
  effortDefaultUnnamed: 'The model\'s default',
  effortUnavailable: '{id} (not offered by this model)',
  loading: 'Loading models…',
  loadFailed: 'The models could not be loaded.',
  retry: 'Retry',
  partial: 'Some providers\' models could not be loaded.',
  conflict: 'This setting was changed elsewhere while you edited it. Discard your edits to see it.',
  unavailable: 'fleet-tau-model is not loaded, so it cannot be configured right now.',
  readOnly: 'This deployment stores settings read-only.',
  saveFailed: 'The deployment did not accept this choice; it was left for you to correct.',
  save: 'Save',
  saving: 'Saving…',
}

/** The page's dictionary keys. */
export type TauModelKey = keyof typeof en

/** Chinese copy. */
export const zh: Record<TauModelKey, string> = {
  summary: '每个 tau 会话起始使用的模型。',
  hint: '新的 tau 会话以此模型起始，取代 dsh 的默认模型。可像其他会话一样在其对话框中切换模型。',
  modelLabel: '模型',
  modelDefault: 'dsh 默认（{name}）',
  modelDefaultUnnamed: 'dsh 默认',
  unavailableGroup: '已保存但当前不可用',
  effortLabel: '推理等级',
  effortDefault: '模型默认（{name}）',
  effortDefaultUnnamed: '模型默认',
  effortUnavailable: '{id}（此模型不提供）',
  loading: '正在加载模型…',
  loadFailed: '模型加载失败。',
  retry: '重试',
  partial: '部分提供方的模型未能加载。',
  conflict: '编辑期间此设置已在别处更改。放弃编辑以查看。',
  unavailable: 'fleet-tau-model 未加载，暂时无法配置。',
  readOnly: '此部署的设置为只读。',
  saveFailed: '部署未接受此选择，已保留以便修改。',
  save: '保存',
  saving: '正在保存…',
}

/** The tau lanes page's dictionary namespace. */
export const LANES_NS = 'fleet.tauLanes'

/** The tau lanes page's English copy. */
export const lanesEn = {
  summary: 'How many of the taus\' model calls run at once.',
  hint: 'Every model call of a tau\'s session, whatever its provider, takes one of these lanes while it streams, and waits while all are taken. Other sessions are not counted. Leave it empty for no cap.',
  lanesLabel: 'Lanes',
  noCap: 'No cap',
  malformed: 'Enter a whole number from 1, or leave it empty for no cap.',
  conflict: 'This setting was changed elsewhere while you edited it. Discard your edits to see it.',
  unavailable: 'fleet-tau-lanes is not loaded, so it cannot be configured right now.',
  readOnly: 'This deployment stores settings read-only.',
  saveFailed: 'The deployment did not accept this value; it was left for you to correct.',
  save: 'Save',
  saving: 'Saving…',
}

/** The tau lanes page's dictionary keys. */
export type TauLanesKey = keyof typeof lanesEn

/** The tau lanes page's Chinese copy. */
export const lanesZh: Record<TauLanesKey, string> = {
  summary: 'tau 的模型调用同时进行的数量。',
  hint: '每个 tau 会话的模型调用，无论提供方，流式输出期间占用一个通道，通道全部占用时等待。其他会话不计入。留空表示不限。',
  lanesLabel: '通道数',
  noCap: '不限',
  malformed: '请输入不小于 1 的整数，或留空表示不限。',
  conflict: '编辑期间此设置已在别处更改。放弃编辑以查看。',
  unavailable: 'fleet-tau-lanes 未加载，暂时无法配置。',
  readOnly: '此部署的设置为只读。',
  saveFailed: '部署未接受此值，已保留以便修改。',
  save: '保存',
  saving: '正在保存…',
}
