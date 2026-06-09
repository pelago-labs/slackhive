/**
 * @fileoverview Back-compat shim. The workspace compiler is backend-neutral and
 * now lives in `compile-instructions.ts` (`compileAgentWorkspace` /
 * `getInstructionsPath`). This re-exports it under the old names so existing
 * imports and tests keep working. Prefer `./compile-instructions` in new code.
 *
 * @module runner/compile-claude-md
 */

export * from './compile-instructions';
export { compileAgentWorkspace as compileClaudeMd, getInstructionsPath as getClaudeMdPath } from './compile-instructions';
