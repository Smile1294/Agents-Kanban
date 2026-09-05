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

/** The board's MCP server, as its own program.
 *
 * A SECOND bundle rather than a second entry point in the first one, because it
 * is a different kind of thing: `dist/extension.js` is loaded by VS Code and
 * may never run on its own; this is spawned by a Codex session as
 * `node dist/board-mcp.js` and must therefore be self-contained.
 *
 * It is bundled with NO externals on purpose. `dist/extension.js` can leave the
 * SDK and zod in `node_modules` because the extension host resolves them from
 * beside itself; a process spawned with an arbitrary cwd cannot rely on that,
 * and a missing `require` there is a Codex session with no board tools and a
 * message in a log nobody reads. It imports neither, so the bundle stays tiny.
 *
 * `vscode` is deliberately NOT listed as an external, and that is the guard.
 * It is not a Node builtin, so with `bundle: true` esbuild cannot resolve it
 * and the build FAILS — which is exactly what should happen if this file ever
 * reaches an API that does not exist outside the extension host. Listing it as
 * an external did the opposite of what its own comment claimed: it told esbuild
 * to leave the import alone, so the build succeeded and the failure moved to
 * runtime, inside a process spawned by Codex, as a `require` that cannot
 * resolve and a message in a log nobody reads.
 */
const mcp = await esbuild.context({
  entryPoints: ['src/board-mcp.ts'],
  bundle: true,
  outfile: 'dist/board-mcp.js',
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  sourcemap: true,
  minify: !watch,
  // Empty on purpose — see above. An accidental `vscode` import must be a BUILD
  // error, and an external is an instruction not to raise one.
  external: [],
  logLevel: 'info',
})

if (watch) { await ctx.watch(); await mcp.watch() }
else {
  await ctx.rebuild(); await ctx.dispose()
  await mcp.rebuild(); await mcp.dispose()
}
