/** Tag applied to editor.update() calls that originate from imperative
 * EditorIO methods (setPlainText, clear). ChangeRelayPlugin filters these
 * out so listeners only see real user-driven changes — without this,
 * programmatic writes (typewriter drip, draft restore, prompt-history nav)
 * would race against handlers like cancelTypewriter(). */
export const PROGRAMMATIC_UPDATE_TAG = "m-programmatic";
