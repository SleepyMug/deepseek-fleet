# fleet-core/client

fleet-core's browser half: what dsh's web client loads of fleet. It has
one page, the tau model page, which sets the model every tau's session
starts on, `fleet-tau-model`'s config (docs/fleet-core/tau/index.md), from
the models the chat box's model picker offers.

## Provides

- `@sleepymug/fleet-core/client`, `lib/client.js`, the bundle dsh's web
  client loads for the package (`dsh.client` in its `package.json`), whose
  plugin puts the page on the Plugins page.
- `fleet-client` (`@sleepymug/fleet-core`), the row the bundle is loaded
  for, which does nothing on the host: dsh loads a package's `./client`
  only for a row that names the package itself, and every other row of
  fleet-core's names one of its modules.

The tau model page is the `fleet-tau-model` row's, on fleet-core's page in
the Plugins page, titled "Tau model" (`locale/tau/model-plugin/`, the
row's display metadata), which the row opens:

| Field | What it offers |
|---|---|
| Model | dsh's default, named as it is now, then each provider's models, as the chat box's picker offers them; a saved model the catalog no longer has, under "Saved but currently unavailable". |
| Reasoning effort | The model's own, then each effort the model offers, or, for dsh's default, the default model's; a saved effort the model does not offer, as such. Shown only for a model that has efforts, or an effort saved. |

Choosing a model makes its effort the model's own. A save writes the
three fields at once, `provider` and `model` set, or both unset for dsh's
default, and `reasoningEffort` set or unset, into the profile's patch, as
dsh's settings write it, and the next tau's session to start starts on
them.

## Design

- **The catalog is the chat box's**: `remote.session.modelCatalog()`, the
  host's providers, each with its models and their efforts, and dsh's
  default, the one `ui-model-selection`'s picker and dsh's Subagent page
  read. The picker itself is not reused: it is a session's, and choosing
  a model there makes it that session's and dsh's default.
- **The page's state** (`controller.ts`) is fleet-tau-model's form,
  `ctx.configForms.get('fleet-tau-model')`, what dsh's settings serve of
  the row's volatile fields, and a draft of what a person chose, staged
  until saved or discarded, which the shared settings form,
  `SettingsForm` of `dsh-client-ui-primitives`, saves and discards. A save
  is fenced by the revision the draft was made on, so it does not
  overwrite a change made meanwhile; a change made meanwhile that the
  draft does not match makes it conflicted, which blocks its save until
  it is discarded; one the draft matches ends it.
- **The catalog loads when the page first shows**, not as the plugin
  loads, and again when the host's models (`llm/adapters-updated`) or its
  settings (`settings/document-updated`) change, or the connection resets,
  which also drops the draft.
- **What the page offers** (`catalog.ts`) is the catalog's, by provider,
  with what is saved among it whether the catalog has it or not, so the
  page always shows what a tau's session starts on.
- **The page is there while dsh serves the row** (`configForms.whileServed`),
  so a profile whose fleet-tau-model row is off shows none.
- **Drop-downs are the browser's own** `<select>`, as dsh's Models page
  has them, styled as dsh's settings fields, with dsh's colors, in one
  style element the plugin adds (`styles.ts`), which dsh's module loader
  removes with the plugin.
- **Copy** is English and Chinese (`locales.ts`), dsh's web client's
  languages.
- **The bundle** (`scripts/client-bundle.mjs`) is the client sources,
  bundled by esbuild as CommonJS, in the wrapper dsh's module loader
  takes: `window.__ModuleLoader__.load({ id, factory })`. It leaves to the
  page only what the shell's module table has, React, cordis and dsh's
  static UI libraries; any other import fails the build, since the page
  has no copy to share. Another plugin's services, such as
  `ctx.configForms`, are reached through cordis, as `inject` names them,
  and their types alone imported.
- **The client sources** (`src/client/`) import nothing of fleet-core's
  host half, which the browser has not, and have a TypeScript project of
  their own, `tsconfig.client.json`, with the DOM and JSX, whose output in
  `lib/client/` holds their tests and is not published.

## Built on

- `dsh-client-modules`, which serves the bundle, and the shell's module
  table: `react`, `react/jsx-runtime`, `dsh-client-ui-primitives`.
- `ctx.configForms` (`dsh-client-ui-settings`), `ctx.slots`
  (`dsh-client-ui-renderer`, `dsh-client-ui-slots`) and the Plugins page's
  `plugins.row.config` (`dsh-client-ui-plugin-manager`), `ctx.locale`
  (`dsh-client-locale`) and `ctx.remote` (`dsh-api-remotes`), whose types
  are fleet-core's dev dependencies.
- esbuild, to bundle.
