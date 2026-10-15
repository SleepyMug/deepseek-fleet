// fleet-core's browser half, lib/client.js, as dsh's web client loads a
// plugin's `./client` (dsh-client-modules): one script that registers a
// factory with the page's module loader, which runs it with the loader's
// `require` the first time the plugin is used. What it requires is the
// shell's own module table, React and dsh's static UI libraries, which the
// bundle leaves to it; any other package fails the build, rather than being
// bundled, since the page has no copy of it to share.
import { readFileSync, writeFileSync } from 'node:fs'
import { build } from 'esbuild'

const PLATFORM = new Set([
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-dockkit',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-slots',
])

const { name } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

const platformOnly = {
  name: 'platform-only',
  setup(build) {
    build.onResolve({ filter: /^[^./]/ }, ({ path, importer }) => {
      if (PLATFORM.has(path)) return { path, external: true }
      return { errors: [{ text: `${path}, which ${importer} imports, is not in the web client's module table` }] }
    })
  },
}

const result = await build({
  entryPoints: [new URL('../src/client/index.ts', import.meta.url).pathname],
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  jsx: 'automatic',
  legalComments: 'none',
  write: false,
  plugins: [platformOnly],
})

const body = result.outputFiles[0].text
writeFileSync(new URL('../lib/client.js', import.meta.url), `window.__ModuleLoader__.load({
\tid: ${JSON.stringify(name)},
\tfactory: (require) => {
\t\tvar module = { exports: {} };
\t\tvar exports = module.exports;
${body}
\t\treturn module.exports;
\t}
});
`)
