import esbuild from 'esbuild'

const watch = process.argv.includes('--watch')

/** Externals, and why each one is external:
 *  - `vscode`   injected by the extension host at runtime; never bundled.
 *  - the Agent SDK: ESM-only and resolves a per-platform native `claude` binary at
 *    runtime, which bundling breaks. Loaded via dynamic import() (esbuild preserves
 *    it verbatim for externals in CJS output — verified).
 *  - `zod`: a PEER dependency of the Agent SDK. Bundling it inline would give us a
 *    second zod instance while the SDK resolves its own from node_modules, and the
 *    two disagree on instanceof checks during schema conversion. One instance only.
 *  All three ship inside the .vsix via node_modules. */
const ctx = await esbuild.context({
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'dist/extension.js',
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  sourcemap: true,
  minify: !watch,
  external: ['vscode', '@anthropic-ai/claude-agent-sdk', 'zod'],
  logLevel: 'info',
})

if (watch) await ctx.watch()
else { await ctx.rebuild(); await ctx.dispose() }
