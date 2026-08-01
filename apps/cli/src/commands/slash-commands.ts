/**
 * @deprecated Import from `./slash-helpers.js` instead.
 *
 * Historical REPL slash registry has been removed. Interactive TUI uses
 * daemon command catalog + resource APIs + client-local UI.
 * This file only re-exports shared helpers for a short compatibility window.
 */

export {
  buildOutputStyleResult,
  coerceConfigValue,
  formatPersonalPromptDiagnostics,
  formatPromptLayersReport,
} from "./slash-helpers.js";
