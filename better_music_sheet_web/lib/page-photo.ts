"use client";

// A photo of a page, flattened before upload (see lib/page-edges.ts for how):
// the browser side - reading the photo's pixels, and making the flattened page
// a JPEG to upload in its place.

import { FIND_SIZE, findPage, flatSize, evenLighting, squareCrop, warp, type Quad } from "./page-edges";

/** The most pixels read from a photo: a 12-megapixel phone photo whole, and
 * a 48-megapixel one at a quarter - still more than recognition reads. A
 * canvas much larger than this fails outright on some phones. */
const SOURCE_LONG_SIDE = 4032;
/** The flattened page's long side at most: A4 at the 300 DPI recognition
 * reads at, as photo-pages.ts sends a photo. */
const PAGE_LONG_SIDE = 3508;

/** What was done to a photo to make a page from it, so it can be done again
 * differently from the photo itself. Corners are in the photo's pixels, as
 * shown upright. */
export type PageFix = { quad: Quad; even: boolean };

/** A flattened page, by the photo it came from and how. */
const origins = new WeakMap<File, { photo: File; fix: PageFix }>();

export function originOf(page: File) {
  return origins.get(page) ?? null;
}

/** The photo upright (its orientation tag honoured), at most
 * SOURCE_LONG_SIDE across. */
export async function openPhoto(file: Blob) {
  const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  const scale = Math.min(1, SOURCE_LONG_SIDE / Math.max(bitmap.width, bitmap.height));
  return { bitmap, width: Math.round(bitmap.width * scale), height: Math.round(bitmap.height * scale) };
}

function canvas(width: number, height: number) {
  const c = document.createElement("canvas");
  c.width = width;
  c.height = height;
  return c;
}

/** Where the page's corners are in the photo, in `width` x `height`
 * pixels, or null if no page stands out. */
export function detectPage(bitmap: ImageBitmap, width: number, height: number): Quad | null {
  const scale = FIND_SIZE / Math.max(width, height);
  const w = Math.max(1, Math.round(width * scale)), h = Math.max(1, Math.round(height * scale));
  const small = canvas(w, h);
  const context = small.getContext("2d", { willReadFrequently: true })!;
  context.drawImage(bitmap, 0, 0, w, h);
  const { data } = context.getImageData(0, 0, w, h);
  const gray = new Uint8Array(w * h);
  for (let i = 0, j = 0; j < gray.length; i += 4, j++) gray[j] = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
  const quad = findPage({ data: gray, width: w, height: h });
  return quad && (quad.map((p) => ({ x: p.x * (width / w), y: p.y * (height / h) })) as Quad);
}

/** The page inside `fix.quad` as a JPEG of its own, standing in for
 * `photo` - remembered as made from it, so it can be fixed again. */
export async function flattenPhoto(photo: File, fix: PageFix): Promise<File> {
  const { bitmap, width, height } = await openPhoto(photo);
  try {
    let page: { data: Uint8ClampedArray<ArrayBuffer>; width: number; height: number };
    const crop = squareCrop(fix.quad, width, height);
    if (crop) {
      // Already straight: cut out as it is, every pixel where it was.
      const scale = bitmap.width / width;
      const cut = canvas(crop.width, crop.height).getContext("2d", { willReadFrequently: true })!;
      cut.drawImage(bitmap, crop.x * scale, crop.y * scale, crop.width * scale, crop.height * scale,
        0, 0, crop.width, crop.height);
      page = cut.getImageData(0, 0, crop.width, crop.height);
    } else {
      const source = canvas(width, height);
      const context = source.getContext("2d", { willReadFrequently: true })!;
      context.drawImage(bitmap, 0, 0, width, height);
      const pixels = context.getImageData(0, 0, width, height);
      const size = flatSize(fix.quad, PAGE_LONG_SIDE);
      page = { data: warp(pixels, fix.quad, size.width, size.height), ...size };
    }
    const size = { width: page.width, height: page.height };
    if (fix.even) evenLighting(page);
    const out = canvas(size.width, size.height);
    out.getContext("2d")!.putImageData(new ImageData(page.data, size.width, size.height), 0, 0);
    const blob = await new Promise<Blob | null>((resolve) => out.toBlob(resolve, "image/jpeg", 0.92));
    if (!blob) throw new Error("Couldn't straighten the photo.");
    const stem = photo.name.replace(/\.[^.]+$/, "") || "Page";
    const file = new File([blob], `${stem}.jpg`, { type: "image/jpeg" });
    origins.set(file, { photo, fix });
    return file;
  } finally {
    bitmap.close();
  }
}

/** The photo as a JPEG or PNG, which is all an upload takes: a camera that
 * saves HEIC or WebP is redrawn as a JPEG, as it is. */
export async function asUploadable(photo: File): Promise<File> {
  if (photo.type === "image/jpeg" || photo.type === "image/png") return photo;
  const { bitmap, width, height } = await openPhoto(photo);
  try {
    const out = canvas(width, height);
    out.getContext("2d")!.drawImage(bitmap, 0, 0, width, height);
    const blob = await new Promise<Blob | null>((resolve) => out.toBlob(resolve, "image/jpeg", 0.92));
    if (!blob) throw new Error("Couldn't read the photo.");
    return new File([blob], `${photo.name.replace(/\.[^.]+$/, "") || "Page"}.jpg`, { type: "image/jpeg" });
  } finally {
    bitmap.close();
  }
}
