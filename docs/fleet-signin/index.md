# fleet-signin

A one-shot terminal sign-in to a model provider, booted as a dsh profile of
its own. It obtains the stored sign-in a profile's model route authenticates
with, such as `llm-pi-ai/openai-codex` for a ChatGPT subscription, and exits.

## Provides

`fleet-signin/app`, which the package's `cordis.patch.yml` mounts after
dsh-base:

```
dsh fleet-signin [provider]
                 sign in to the provider, openai-codex by default; a bare
                 provider means llm-pi-ai/<provider>, and <scope>/<id> names
                 any flow dsh registers
dsh fleet-signin --help
                 list the sign-ins dsh registers
```

- Exit codes:
  - `0` once signed in, or for `--help`;
  - `1` when the sign-in fails or is cancelled, or there is no such flow;
  - `2` on more than one provider.

## Design

- **One attempt.** The app waits for dsh's startup to commit, since flows
  register while the tree starts, runs one attempt of `ctx.authorization`,
  and asks dsh to exit. A long-running profile must not select the bundle.
- **The terminal.** A flow's notices, its page and code, go to stderr, with
  how to forward an OAuth loopback callback when the browser is on another
  machine. Its prompts are answered from stdin, in the terminal's own echo,
  so a secret is visible while typed. Ctrl-D at a prompt declines; Ctrl-C
  aborts.
- **The credential.** The flow writes it to the dsh home's
  `.credentials.yaml`. A dsh running on the same home picks it up without a
  restart, and the provider's adapter refreshes it from then on.

## Built on

- `@deepseek-ai/dsh-authorization`'s `ctx.authorization`, for the flows.
- `@deepseek-ai/dsh-credentials`, for credential keys.
- dsh's launcher: `ctx.cmdlineArgs`, `ctx.appReady` and `ctx.appExit`.

## How it runs

Once, after `pnpm build`, make the profile:

```
pnpm exec dsh plugin --profile fleet-signin add link:<checkout>/packages/fleet-signin
```

which lists `@deepseek-ai/dsh-base` and `fleet-signin` in its bundles. Then:

```
$ pnpm exec dsh fleet-signin
[signin] Signing in to OpenAI Codex (llm-pi-ai/openai-codex). Ctrl-D at a prompt declines; Ctrl-C aborts.
[signin] Select OpenAI Codex login method:
  1) Browser login (default)
  2) Device code login (headless)
Choice [1]:
```
