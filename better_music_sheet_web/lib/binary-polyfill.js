// Modern globals pdfjs-dist 6.x assumes, for browsers that do not have them.
//
// Uint8Array's base64/hex methods arrived in Safari 18.2; without them the
// viewer dies on `hashOriginal.toHex()` while computing a document
// fingerprint. The `Iterator` global arrived later still, in Safari 18.4, and
// pdf.js reaches for it unguarded while installing its own helper:
//
//     "function" != typeof Iterator.prototype.join && (Iterator.prototype.join = ...)
//
// That tests whether the METHOD exists, not whether `Iterator` does, so on an
// older WebKit it throws "Can't find variable: Iterator" before any page
// renders. iPadOS and iOS ship different Safari versions, which is why an
// iPhone can be fine while an iPad on the same account is not.
//
// Two of the three calls are inside pdf.js's Web Worker, which shares nothing
// with the page, so this file is BOTH imported by sheet-canvas.tsx and
// prepended to the copied worker by scripts/copy-pdf-worker.mjs. Keep it plain
// script syntax - no import/export - so it stays valid in either position.
//
// pdf.js calls all three with no arguments, so the alphabet/padding options in
// the real proposal are deliberately not implemented; a partial polyfill that
// covers the actual calls beats a wrong one that looks complete.
(() => {
  const proto = typeof Uint8Array === "function" ? Uint8Array.prototype : null;
  if (!proto) return;

  if (typeof proto.toHex !== "function") {
    proto.toHex = function toHex() {
      let out = "";
      for (let i = 0; i < this.length; i++) {
        out += this[i].toString(16).padStart(2, "0");
      }
      return out;
    };
  }

  if (typeof proto.toBase64 !== "function") {
    proto.toBase64 = function toBase64() {
      // Built in 32k slices: String.fromCharCode(...bytes) on a whole PDF
      // overflows the argument limit and throws before it can return.
      let binary = "";
      for (let i = 0; i < this.length; i += 0x8000) {
        binary += String.fromCharCode.apply(null, this.subarray(i, i + 0x8000));
      }
      return btoa(binary);
    };
  }

  if (typeof Uint8Array.fromBase64 !== "function") {
    Uint8Array.fromBase64 = function fromBase64(text) {
      const binary = atob(text);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      return bytes;
    };
  }

  if (typeof globalThis.Iterator === "undefined") {
    // %IteratorPrototype% is the object every built-in iterator inherits from.
    // It has no global name of its own, but it is two links up the chain from
    // any array iterator, so it can be reached without the global that is
    // missing. Handing pdf.js the real prototype rather than a stand-in means
    // the helper it installs works for Map and Set iterators too, exactly as
    // it would on a browser that ships Iterator natively.
    const prototype = Object.getPrototypeOf(Object.getPrototypeOf([][Symbol.iterator]()));
    const Iterator = function Iterator() {
      throw new TypeError("Iterator is abstract and cannot be constructed");
    };
    Iterator.prototype = prototype;
    globalThis.Iterator = Iterator;
  }
})();

// Marks this as an ES module so it can be side-effect imported from TS, and
// harmless where it is prepended to the worker, which is already a module.
export {};
