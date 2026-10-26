// Text safety rules shared by the server (chief plans, lessons) and the cloud coordinator (FREE-07 cloud lessons).
// Pure and browser-safe. Moved unchanged from src/server/chief.ts, which re-exports them.

/**
 * Review fix 1: text a worker reads but the CEO cannot see. Format characters (zero-width, bidi overrides and isolates,
 * soft hyphen, Unicode tags U+E0000–E007F), line/paragraph separators, unassigned or private-use code points, and every
 * control character except newline and tab are refused in model-written titles, prompts and summaries.
 */
export const CONTROL = /[\p{Cf}\p{Zl}\p{Zp}\p{Co}\p{Cn}\u{E0000}-\u{E007F}]|[^\P{Cc}\n\t]/u;
/** FREE-10: the same invisible/control-character test, for lesson text. */
export const hasHiddenChars = (text: string) => CONTROL.test(text);

/** Review fix 6: secrets (a bare `.env`, not `.env.example`) and the verbs that move them, on lower-cased text. */
const SECRET = String.raw`(?:\b(?:api[ _-]?keys?|passwords?|secrets?|(?:auth|access|api|bearer|session|refresh|oauth|npm|gh)[ _-]?tokens?|credentials?|ssh keys?|private keys?)\b|(?<![\w.])\.env(?![\w.]))`;
const LEAK_VERB = String.raw`\b(?:send|post|upload|email|share|paste|exfiltrat\w*|leak|print|reveal|transmit|include|commit|cat|echo|expose|copy|log(?=\s+(?:the|it|them|all)\b))\b`;

/**
 * A heuristic screen for prompts that would make an approved worker do something consequential outside its branch. It
 * is a pattern list, not a guarantee: the CEO still reads every prompt before approving. Returns the reason, or undefined.
 */
export function unsafeReason(text: string): string | undefined {
  const t = text.toLowerCase();
  const rules: [RegExp, string][] = [
    [/\b(curl|wget|iwr|invoke-webrequest)\b[^\n]*\|\s*(sudo\s+)?(ba|z|da)?sh\b/, 'pipes a download into a shell'],
    [/\brm\s+-[a-z]*r[a-z]*f?\s+(\/|~|\$home)(\s|$)/, 'deletes a home or root directory'],
    [/\bgit\s+push\b[^\n]*(--force|-f\b|--mirror)/, 'force-pushes'],
    [new RegExp(`${LEAK_VERB}[^\\n]{0,80}${SECRET}`), 'moves credentials or secrets'],
    [new RegExp(`${SECRET}[^\\n]{0,80}${LEAK_VERB}`), 'moves credentials or secrets'],
    [/\b(auto-?approve|approve (the|this|all|every)\b[^\n.]{0,40}\b(plan|budget|spend|payment|send))/, 'tries to approve on the CEO’s behalf'],
    [/\b(raise|increase|set)\b[^\n.]{0,30}\bbudget\b/, 'tries to change a budget'],
    [/\b(wire|transfer|pay|send)\b[^\n.]{0,30}(\$|usd|eur|£|€)\s?\d/, 'moves money'],
    [/\b(email|message|dm|text|call)\b[^\n.]{0,40}\b(all (customers|clients|users|leads)|mailing list|everyone)\b/, 'contacts people outside the Empire'],
    [/\b(deploy|release|publish)\b[^\n.]{0,30}\b(to )?(production|prod|app store|play store|npm)\b/, 'deploys or publishes'],
    [/\bdisable\b[^\n.]{0,30}\b(tests?|ci|checks?|security|auth(entication)?|2fa|mfa)\b/, 'disables tests or security'],
  ];
  for (const [re, why] of rules) if (re.test(t)) return why;
  return undefined;
}
/** Always refused: bidi embeddings, overrides and isolates, tag characters, lone surrogates, and C0/C1 controls (not \n or \t). */
const DECEPTIVE = /[‪-‮⁦-⁩\u{E0000}-\u{E007F}\p{Cs}]|[^\P{Cc}\n\t]/u;
/** Other invisible format characters and separators (zero-width space, word joiner, BOM, LRM/RLM…), and private use. */
const INVISIBLE = /[\p{Cf}\p{Zl}\p{Zp}\p{Co}]/u;
/** What a ZWJ or ZWNJ may join: letters, digits, marks (incl. variation selectors), emoji, and unassigned code points. */
const JOINABLE = /[\p{L}\p{N}\p{M}\p{Extended_Pictographic}\p{Emoji_Modifier}\p{Emoji_Component}\p{Cn}]/u;

/**
 * FREE-07 re-review: the screen for worker-written research reports (server and cloud). Narrower than hasHiddenChars,
 * which still guards model-written plans and lessons: it accepts real-world text (emoji ZWJ sequences, the soft hyphen,
 * Persian/Indic ZWNJ, emoji newer than this runtime's Unicode data) and refuses what can hide or reorder text.
 */
export function hasDeceptiveChars(text: string): boolean {
  const cps = Array.from(text);
  for (let i = 0; i < cps.length; i++) {
    const c = cps[i];
    if (DECEPTIVE.test(c)) return true;
    if (c === '­') continue; // soft hyphen: a line-break hint
    if (c === '‌' || c === '‍') {
      if (i > 0 && i < cps.length - 1 && JOINABLE.test(cps[i - 1]) && JOINABLE.test(cps[i + 1])) continue;
      return true;
    }
    if (INVISIBLE.test(c)) return true;
  }
  return false;
}
