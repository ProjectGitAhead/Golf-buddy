// Shared photo helper: shrink a picked photo before it is sent to Claude. Nothing is stored; the blob lives only
// as long as the caller keeps it.

/** The size that fits `w` x `h` inside a `max` px square, keeping the aspect ratio. Never upscales. */
export function fitWithin(w: number, h: number, max: number): { width: number; height: number } {
  const s = Math.min(1, max / Math.max(w, h, 1));
  return { width: Math.max(1, Math.round(w * s)), height: Math.max(1, Math.round(h * s)) };
}

/**
 * Re-encodes `file` as a JPEG no larger than `maxSide` px on its long side, applying the photo's orientation.
 * If the browser cannot decode or encode it, the original file is returned and the platform's own checks decide.
 */
export async function downscalePhoto(file: Blob, maxSide = 1280, quality = 0.85): Promise<Blob> {
  try {
    const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
    const { width, height } = fitWithin(bmp.width, bmp.height, maxSide);
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) { bmp.close(); return file; }
    ctx.drawImage(bmp, 0, 0, width, height);
    bmp.close();
    const out = await new Promise<Blob | null>((ok) => canvas.toBlob(ok, 'image/jpeg', quality));
    return out ?? file;
  } catch {
    return file;
  }
}
