/** Every agent runtime the board can drive, registered once.
 *
 * This is the file to edit to add a third. It is deliberately the ONLY place
 * that names them all: `getRuntime()` and `allRuntimes()` are how everything
 * else asks, so a new agent program is one implementation module and one line
 * here, rather than a search for every place `claude` or `codex` was assumed.
 *
 * Registration happens at import, and importing this module is a side effect —
 * so it is imported for effect from `extension.ts` and from any test that needs
 * a populated registry. That is on purpose rather than lazy: a registry that
 * fills itself when someone happens to import an implementation is a registry
 * whose contents depend on module-loading order, and the symptom would be a
 * settings page that lists one runtime on Tuesday and two on Wednesday.
 */
import { registerRuntime } from '../runtime.ts'
import { claudeRuntime } from './claude.ts'
import { codexRuntime } from './codex.ts'

registerRuntime(claudeRuntime)
registerRuntime(codexRuntime)

export { claudeRuntime, codexRuntime }
