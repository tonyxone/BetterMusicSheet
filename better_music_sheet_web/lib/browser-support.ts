/** Whether a failure looks like the browser missing something the code needs,
 *  rather than the content being wrong.
 *
 * The PDF viewer depends on pdfjs-dist, which reaches for APIs as they land in
 * engines. Twice now a browser without one has failed in a way that told the
 * reader nothing: "toHex is not a function" on Safari before 18.2, and "Can't
 * find variable: Iterator" on Safari before 18.4. Each is polyfilled now, but
 * the next one is a question of when, not whether, so the viewer should say
 * something useful without waiting for a fix.
 *
 * Detection is by shape rather than by a list of APIs, because the point is to
 * catch the ones nobody has hit yet. A missing global raises a ReferenceError
 * in every engine; a missing method reads as one of a small set of phrasings
 * that differ per engine. The trade-off is that a genuine bug of our own in
 * this path could be mislabelled as an old browser - which is why the message
 * still shows the underlying error rather than hiding it.
 */
export function isMissingBrowserFeature(error: unknown): boolean {
  if (error instanceof ReferenceError) return true;
  const message = error instanceof Error ? error.message : String(error);
  return [
    /is not a function/i, //            V8, SpiderMonkey, JavaScriptCore
    /is not a constructor/i,
    /can't find variable/i, //          JavaScriptCore, for a missing global
    /undefined is not an object/i, //   JavaScriptCore
    /has no method/i,
  ].some((pattern) => pattern.test(message));
}
