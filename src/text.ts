/**
 * Text-safety primitives shared by every render path (list_libraries, search, get_docs,
 * warm, project-store, config, the CLI, debug fields, resolved descriptions). A true leaf:
 * this module imports nothing, so it cannot itself create an import cycle, and every other
 * module reaches it directly rather than through doctor/warm/autowarm or config/project-deps
 * (A8 / PAR-721).
 *
 * The control/bidi character class below is the one place it is defined (D-48); a future
 * addition to it is an amendment here, never a second copy inlined elsewhere. It is the union
 * of what the three pre-A7 implementations matched between them (`project-deps.ts`'s old
 * `cleanText`, `debug.ts`'s `debugField`, `resolved-store.ts`'s `cleanDescription`), plus the
 * U+2028/U+2029 line/paragraph separators `debug.ts` alone used to catch (A7 / PAR-720).
 *
 * `stripControlBidi` is the ONE exported binding onto the class, parameterised by what to put
 * in a matched character's place, so the shared compiled `/g` RegExp is only ever driven
 * through `String.prototype.replace` (which resets `lastIndex` to 0 itself) and never through
 * a second, uncoordinated `test()`/`exec()` caller that could corrupt it. D-48 pins the
 * character SET, not the substitution — each call site's replacement choice is its own
 * decision, recorded where it is made: `cleanText` deletes (technical/structural text —
 * paths, names, debug fields — where a merged character is harmless); `resolved-store.ts`'s
 * `cleanDescription` substitutes a space (natural-language prose from an untrusted registry,
 * where a stripped control character may have been a real word separator and a visible extra
 * space is a smaller defect than two words running together).
 */

/** C0 / C1 control characters, zero-width / bidi code points and the line/paragraph
 *  separators, applied with /g: linear. */
const CONTROL_BIDI_CHARS = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069\ufeff]/g;

/** Replace every control/bidi character in `s` with `replacement` (default: delete). The one
 *  place the class from D-48 is applied — never inline a second copy of the pattern. The
 *  replacement is substituted through a function, not the string form of `replace`, so a
 *  `replacement` containing `$&`/`` $` ``/`$'` cannot re-insert the character it is supposed to
 *  remove (code-reviewer, A7 round 1: no current caller passes such a string, but this is a
 *  sanitization boundary — closing the hole permanently costs nothing). */
export function stripControlBidi(s: string, replacement = ""): string {
  return s.replace(CONTROL_BIDI_CHARS, () => replacement);
}

/** Strip control and bidi characters from text that is about to be rendered (notes, table
 *  cells, display paths). */
export function cleanText(s: string): string {
  return stripControlBidi(s);
}

/** `s` with control / bidi characters removed and clipped to `max`, ellipsis included. */
export function clipText(s: string, max: number): string {
  const clean = cleanText(s);
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}
