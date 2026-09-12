// pdfjs-dist 6.x uses the Uint8Array base64/hex methods, which Safari only
// shipped in 18.2 and older Chrome lacks too. Without them the viewer dies on
// `hashOriginal.toHex()` while computing a document fingerprint, and the page
// reports "toHex is not a function" instead of rendering the sheet.
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
})();

// Marks this as an ES module so it can be side-effect imported from TS, and
// harmless where it is prepended to the worker, which is already a module.
export {};
