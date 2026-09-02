/**
 * dsh-input.ts — pure logic for inserting text into dsh's chat input.
 *
 * WHY A STRING, NOT A FUNCTION CALL
 * ---------------------------------
 * The insert runs in the MAIN window's renderer (the dsh webview), via
 * `webContents.executeJavaScript(script)`. `executeJavaScript` is string-only
 * — there is no way to pass a function object across that boundary — and a
 * function with closure dependencies would not serialise anyway. So the
 * insert is shipped as a self-contained IIFE with its payload interpolated
 * via JSON.stringify, which is the only way to guarantee that quotes,
 * backslashes, newlines, and Unicode survive the trip.
 *
 * WHY A SEPARATE FILE
 * -------------------
 * Same reason as the other pure-logic modules: a `new vm.Script(text)` parse
 * check in the unit test proves the renderer-side code is at least syntactically
 * valid, and keeping it in its own file means the test for it is small and the
 * contract for what we send over executeJavaScript is in one place.
 */

/**
 * Shape of what the renderer script returns. Kept in sync with the IIFE's
 * own object literal so a TypeScript reader sees the same field names the
 * renderer actually produces.
 */
export interface ChatInsertResult {
  ok: boolean
  /** Which element received the text. Diagnostic only. */
  target?: 'textarea' | 'contenteditable'
  /** What the script actually wrote (with the leading space, if any). */
  inserted?: string
  /** Failure reason when ok is false. */
  error?: string
}

/**
 * The user-facing text to drop into dsh's chat input.
 *
 * dsh recognises `@<path>` references in the user message — see the chat
 * log where the agent is given `@/dwork/out/out_errornow.aspx`. Leading with
 * `@` makes the common case work without the user having to type it. A
 * leading space is prepended when the existing value does not already end
 * in whitespace, so the token sits in its own slot rather than gluing onto
 * the previous word.
 *
 * Backslashes read better than forward slashes in chat: the path is being
 * shown to a person, not parsed by a tool, and `D:\foo\bar` is what the
 * user already sees in their file manager.
 */
export function buildChatInsert(absolutePath: string): string {
  if (typeof absolutePath !== 'string' || absolutePath.length === 0) return ''
  const display = absolutePath.replace(/\//g, '\\')
  return `@${display}`
}

/**
 * Placeholder replaced by buildInsertScript() with a JSON-encoded payload.
 * Chosen as a sequence of characters that cannot appear in a JSON string
 * literal (`$` followed by `{}` is invalid JSON syntax), so a stray literal
 * cannot survive into the final script.
 */
const PAYLOAD = '${__PAYLOAD__}'

/**
 * Self-contained IIFE that runs inside dsh's renderer. See the file header
 * for why it is a string rather than a function. The script:
 *
 *   1. Finds the first visible, non-readonly <textarea> with non-trivial
 *      width. That is dsh's chat input on every layout we have seen.
 *   2. Falls back to the first [contenteditable=true] element if no
 *      textarea qualifies.
 *   3. Goes through the React/Preact-aware value setter so the framework
 *      actually sees the change as a user edit.
 *   4. Dispatches an `input` event so a controlled component updates.
 *   5. Focuses the input and parks the caret at the end of the insert.
 */
const INSERT_SCRIPT_TEMPLATE = `(function(text){
  var ta = null;
  var tas = document.querySelectorAll('textarea');
  for (var i = 0; i < tas.length; i++) {
    var t = tas[i];
    if (t.readOnly || t.disabled) continue;
    if (t.offsetParent === null) continue;
    if (t.offsetWidth < 50) continue;
    ta = t;
    break;
  }
  if (ta) {
    var start = (typeof ta.selectionStart === 'number') ? ta.selectionStart : ta.value.length;
    var end = (typeof ta.selectionEnd === 'number') ? ta.selectionEnd : ta.value.length;
    var before = ta.value.slice(0, start);
    var after = ta.value.slice(end);
    var insert = text;
    if (start > 0 && !/\\s$/.test(before)) insert = ' ' + insert;
    var setter = Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype, 'value').set;
    setter.call(ta, before + insert + after);
    var pos = start + insert.length;
    ta.selectionStart = ta.selectionEnd = pos;
    ta.focus();
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    return { ok: true, target: 'textarea', inserted: insert };
  }
  var ed = document.querySelector('[contenteditable="true"]');
  if (ed) {
    ed.focus();
    var ok = false;
    try { ok = document.execCommand('insertText', false, text); } catch (_) {}
    if (!ok) {
      var sel = window.getSelection();
      if (sel && sel.rangeCount > 0) {
        var range = sel.getRangeAt(0);
        range.deleteContents();
        var node = document.createTextNode(text);
        range.insertNode(node);
        range.setStartAfter(node);
        range.setEndAfter(node);
        sel.removeAllRanges();
        sel.addRange(range);
      }
    }
    ed.dispatchEvent(new Event('input', { bubbles: true }));
    return { ok: true, target: 'contenteditable' };
  }
  return { ok: false, error: '\\u672a\\u627e\\u5230 dsh \\u7684\\u8f93\\u5165\\u6846' };
})(${PAYLOAD});`

/**
 * Build the full script with the payload safely interpolated.
 *
 * JSON.stringify returns a syntactically valid JS string literal, with
 * quotes / backslashes / control characters / non-ASCII code points all
 * already escaped. Substituting it in place of the placeholder is therefore
 * always safe — there is no path-shaped input the user can type that would
 * produce a syntactically invalid script.
 */
export function buildInsertScript(text: string): string {
  // Defence in depth: refuse a payload that is not a string. The IPC handler
  // already validates, but the test exercises this path directly.
  if (typeof text !== 'string') return ''
  return INSERT_SCRIPT_TEMPLATE.replace(PAYLOAD, JSON.stringify(text))
}
