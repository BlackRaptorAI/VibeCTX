/**
 * Text-safety primitives shared by every render path (list_libraries, search, get_docs,
 * warm, project-store, config, the CLI). A true leaf: this module imports nothing, so it
 * cannot itself create an import cycle, and every other module reaches it directly rather
 * than through doctor/warm/autowarm or config/project-deps (A8 / PAR-721).
 *
 * The control/bidi character class below is the one place it is defined; a future addition to
 * it is an amendment here, never a second copy inlined elsewhere. D-48 records the contract as
 * "one EXPORTED class" — this module keeps the class module-private (only `cleanText` and
 * `clipText` apply it) and exports no binding onto it yet, because a shared compiled `/g`
 * RegExp carries mutable `lastIndex` state a second, uncoordinated `test()`/`exec()` caller
 * could corrupt. Whether that satisfies D-48 or needs a formal amendment is Tom's call, not
 * this item's to make (A8 does not implement A7, and .vibectx-plan/ is read-only here); flagged
 * rather than silently resolved either way.
 */

/** C0 / C1 control characters and bidi / zero-width code points, applied with /g: linear. */
const CONTROL_BIDI_CHARS = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g;

/** Strip control and bidi characters from text that is about to be rendered (notes, table
 *  cells, display paths). */
export function cleanText(s: string): string {
  return s.replace(CONTROL_BIDI_CHARS, "");
}

/** `s` with control / bidi characters removed and clipped to `max`, ellipsis included. */
export function clipText(s: string, max: number): string {
  const clean = cleanText(s);
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}
