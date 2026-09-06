/**
 * D-23 — the one tokenizer VibeCTX uses for queries, headings, section bodies and
 * code blocks. Retrieval quality lives or dies here: `useEffect` has to match "use
 * effect", `policies` has to match `policy`, and none of it may open a
 * pathological-input hole, so every scan below is a single linear pass over the
 * characters — no regex, no backtracking.
 */

/** Longest token kept. A real identifier is far shorter; a 1 MB run of `x` is not a
 *  token, it is a denial-of-service payload, and dropping it keeps ranking linear. */
export const MAX_TOKEN_CHARS = 64;

/** D-23's stopword list. Small and closed on purpose: these are the words a vibe
 *  coder types around the terms that matter ("how do I use the router"), never the
 *  terms themselves. Removed BEFORE stemming, so `does` cannot survive as `doe`. */
export const STOPWORDS: ReadonlySet<string> = new Set([
  "the", "a", "an", "of", "to", "in", "for", "and", "or", "is", "are", "with",
  "how", "what", "my", "i", "it", "this", "that", "be", "can", "do", "does",
  "when", "from", "by", "on", "at", "as", "into", "using",
]);

const isUpper = (c: number) => c >= 65 && c <= 90;
const isLower = (c: number) => c >= 97 && c <= 122;
const isDigit = (c: number) => c >= 48 && c <= 57;
const isAlnum = (c: number) => isLower(c) || isUpper(c) || isDigit(c);

const MIN_TOKEN_CHARS = 2;

function keepable(len: number): boolean {
  return len >= MIN_TOKEN_CHARS && len <= MAX_TOKEN_CHARS;
}

/**
 * Split one alphanumeric run into its camelCase / PascalCase subwords, appending
 * each keepable one (lowercased) to `out`, and return how many subwords the run
 * has. Boundaries, in one forward pass:
 *   lower|digit → UPPER   (`useEffect`, `s3Client`)
 *   UPPER → UPPER lower   (`HTTPServer` → HTTP | Server)
 * Digits never start a subword of their own, so `utf8` stays one token.
 */
function splitRun(text: string, start: number, end: number, out: string[]): number {
  let subwords = 0;
  let from = start;
  for (let i = start + 1; i < end; i++) {
    const c = text.charCodeAt(i);
    if (!isUpper(c)) continue;
    const prev = text.charCodeAt(i - 1);
    const boundary =
      isLower(prev) || isDigit(prev) || (isUpper(prev) && i + 1 < end && isLower(text.charCodeAt(i + 1)));
    if (!boundary) continue;
    subwords += 1;
    if (keepable(i - from)) out.push(text.slice(from, i).toLowerCase());
    from = i;
  }
  subwords += 1;
  if (keepable(end - from)) out.push(text.slice(from, end).toLowerCase());
  return subwords;
}

/** Raw tokens: subwords plus, when a run had more than one, the whole lowercased
 *  compound — so `useEffect` scores for "use effect" AND for a literal `useEffect`. */
function rawTokens(text: string): string[] {
  const out: string[] = [];
  const n = text.length;
  let i = 0;
  while (i < n) {
    if (!isAlnum(text.charCodeAt(i))) {
      i += 1;
      continue;
    }
    let end = i + 1;
    while (end < n && isAlnum(text.charCodeAt(end))) end += 1;
    const subwords = splitRun(text, i, end, out);
    if (subwords > 1 && keepable(end - i)) out.push(text.slice(i, end).toLowerCase());
    i = end;
  }
  return out;
}

function hasDigit(token: string): boolean {
  for (let i = 0; i < token.length; i++) if (isDigit(token.charCodeAt(i))) return true;
  return false;
}

const MIN_STEM_INPUT = 4;
const MIN_STEM_RESULT = 3;
/** Shorter than this, a trailing `e` is load-bearing: `note` and `type` keep theirs. */
const MIN_E_STRIP_INPUT = 5;

/** Apply one suffix rule if the result stays at least MIN_STEM_RESULT long. */
function chop(token: string, suffix: string, replacement: string): string | undefined {
  if (!token.endsWith(suffix)) return undefined;
  const stemmed = token.slice(0, token.length - suffix.length) + replacement;
  return stemmed.length >= MIN_STEM_RESULT ? stemmed : undefined;
}

/** Consonants a suffix may have doubled. `l`, `s` and `z` are excluded because a
 *  double there is usually the word's own spelling: `call`, `pass`, `fizz` — cutting
 *  those would push `calling` onto `cal` and away from `call`. */
const DEDOUBLE = new Set("bcdfghjkmnpqrtvwxy".split(""));

/**
 * Repair (a) — Porter step 1b's de-doubling. `running` loses `ing` and leaves `runn`;
 * the second `n` was the suffix's doing, so drop it. Undefined when the token does not
 * end in a doubled consonant, or when the cut would fall under the floor (`added` →
 * `add` stays `add`, since `ad` is too short).
 */
function dedouble(t: string): string | undefined {
  const n = t.length;
  if (n < 2 || t[n - 1] !== t[n - 2] || !DEDOUBLE.has(t[n - 1])) return undefined;
  const out = t.slice(0, n - 1);
  return out.length >= MIN_STEM_RESULT ? out : undefined;
}

/**
 * Repair (b) — the silent-e cut. English drops the `e` before `ing`/`ed`, so `parse`
 * and `parsing` can only meet at `pars`, `create` and `created` at `creat`. Applied to
 * the token that survives the suffix passes, which is what also carries `parses` →
 * `parse` → `pars` home. Only from five characters up: below that the `e` is usually
 * the word (`note`, `type`, `use`), and a 3-char stem collides with too much.
 */
function stripSilentE(t: string): string | undefined {
  if (t.length < MIN_E_STRIP_INPUT || !t.endsWith("e")) return undefined;
  const out = t.slice(0, t.length - 1);
  return out.length >= MIN_STEM_RESULT ? out : undefined;
}

/**
 * D-23's light deterministic stemmer. Three ordered passes, every rule refusing to cut
 * below three characters (c), and nothing at all applied to a token under four
 * characters or containing a digit (`utf8s`, version numbers):
 *
 *   1. plural — `ies→y`, `sses→ss`, trailing `s` but never `ss`
 *   2. verb   — `ing`, `ed`, then repair (a), the de-doubling: `running` → `run`.
 *               When `ed` alone would go under the floor the `e` belongs to the stem
 *               (`use` + `ed` is spelled `used`), so the `d` is cut instead.
 *   3. repair (b) — the silent `e`, unless (a) already fired. (A de-doubled stem ends
 *      in a consonant, so this exclusion is belt-and-braces, not a live branch.)
 *
 * Two passes for suffixes rather than one so `settings` → `setting` → `set` converges
 * with `set`. What this buys, MEASURED by test/tokenize.test.ts "stems inflections of
 * the same word to one token": parse/parsing/parsed/parses, create/creating/created,
 * use/uses/used, run/running, handle/handling, cache/caching/cached,
 * route/routes/routing, policy/policies, query/queries/querying all converge.
 *
 * Two deliberate non-convergences, and the reason for each:
 *   - `using` ≠ `use`. It is a stopword, so no real query reaches the stemmer with it;
 *     standing alone, `ing` → `us` is under the floor and it keeps its own form.
 *   - `handler` ≠ `handle`. There is no agent-noun rule: an `er` rule would also merge
 *     `router` into `route` and `parser` into `parse`, which loses more than it gains.
 *
 * The silent-e cut over-stems a few nouns that merely end in `e` — `stripe` → `strip`,
 * `middleware` → `middlewar`. Queries and documents go through the same function, so a
 * collision costs precision, never a match.
 */
export function stem(token: string): string {
  if (hasDigit(token)) return token;
  let t = token;
  if (t.length >= MIN_STEM_INPUT) {
    const plural =
      chop(t, "ies", "y") ??
      chop(t, "sses", "ss") ??
      (t.endsWith("ss") ? undefined : chop(t, "s", ""));
    if (plural !== undefined) t = plural;
  }
  let dedoubled = false;
  if (t.length >= MIN_STEM_INPUT) {
    const verb =
      chop(t, "ing", "") ??
      chop(t, "ed", "") ??
      (t.endsWith("ed") ? chop(t, "d", "") : undefined);
    if (verb !== undefined) {
      t = verb;
      const single = dedouble(t);
      if (single !== undefined) {
        t = single;
        dedoubled = true;
      }
    }
  }
  if (!dedoubled) {
    const bare = stripSilentE(t);
    if (bare !== undefined) t = bare;
  }
  return t;
}

/**
 * Tokenize any text — query, heading, body or code — the same way.
 * Order matters: split → drop 1-char → stopwords → stem. Stopwords come first
 * because stemming would otherwise smuggle `does` through as `doe`; the
 * all-stopword fallback keeps a query like "how to do this" from tokenizing to
 * nothing at all.
 */
export function tokenize(text: string): string[] {
  const raw = rawTokens(text);
  if (raw.length === 0) return [];
  let kept = raw.filter((t) => !STOPWORDS.has(t));
  if (kept.length === 0) kept = raw; // an all-stopword input keeps its stopwords
  return kept.map(stem);
}
