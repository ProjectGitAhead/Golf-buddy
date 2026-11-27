// A small EXIF reader for the rangefinder (plan section 12.1): JPEG APP1 only, no library. Reads just the tags the
// distance needs. Anything malformed, truncated or not a JPEG gives null or leaves the tag out; it never throws.

export interface ExifInfo {
  /** 0x0112, 1-8. Browsers apply it when decoding, so the app measures in decoded pixels and only reports it. */
  orientation?: number;
  /** 0xA405 FocalLengthIn35mmFilm, mm. */
  focal35?: number;
  /** 0xA404 DigitalZoomRatio. Left out when 0 (the EXIF value for "not used"). */
  digitalZoom?: number;
  /** 0x920A FocalLength (real lens), mm. */
  focalMm?: number;
  /** 0xA002 / 0xA003 PixelXDimension / PixelYDimension, as stored (before orientation). */
  pixelW?: number;
  pixelH?: number;
}

const TAG = { orientation: 0x0112, exifIfd: 0x8769, focal35: 0xa405, digitalZoom: 0xa404, focalMm: 0x920a, pixelW: 0xa002, pixelH: 0xa003 };

/** Reads the EXIF block of a JPEG (the first few hundred KB are enough). */
export function readExif(input: ArrayBuffer | Uint8Array): ExifInfo | null {
  const b = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
  let p = 2;
  while (p + 4 <= b.length) {
    if (b[p] !== 0xff) return null;
    const marker = b[p + 1];
    if (marker === 0xff) { p++; continue; }                          // fill byte
    if (marker === 0xd9 || marker === 0xda) return null;               // end of image / start of scan: no more metadata
    if ((marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) { p += 2; continue; }
    const len = (b[p + 2] << 8) | b[p + 3];
    if (len < 2) return null;
    const start = p + 4;
    const end = Math.min(b.length, p + 2 + len);
    if (marker === 0xe1 && end - start >= 14 && isExifHeader(b, start)) {
      const info = parseTiff(b, start + 6, end);
      if (info) return info;
    }
    p += 2 + len;
  }
  return null;
}

function isExifHeader(b: Uint8Array, at: number): boolean {
  return b[at] === 0x45 && b[at + 1] === 0x78 && b[at + 2] === 0x69 && b[at + 3] === 0x66 && b[at + 4] === 0 && b[at + 5] === 0;
}

function parseTiff(b: Uint8Array, t0: number, end: number): ExifInfo | null {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const le = b[t0] === 0x49 && b[t0 + 1] === 0x49;
  const be = b[t0] === 0x4d && b[t0 + 1] === 0x4d;
  if (!le && !be) return null;
  const inside = (off: number, n: number) => off >= t0 && off + n <= end;
  const u16 = (off: number) => (inside(off, 2) ? dv.getUint16(off, le) : NaN);
  const u32 = (off: number) => (inside(off, 4) ? dv.getUint32(off, le) : NaN);
  if (u16(t0 + 2) !== 42) return null;

  type Entry = { type: number; count: number; at: number };
  const readIfd = (rel: number): Map<number, Entry> => {
    const out = new Map<number, Entry>();
    const at = t0 + rel;
    const n = u16(at);
    if (!Number.isFinite(n)) return out;
    for (let i = 0; i < n; i++) {
      const e = at + 2 + i * 12;
      if (!inside(e, 12)) break;
      out.set(u16(e), { type: u16(e + 2), count: u32(e + 4), at: e + 8 });
    }
    return out;
  };
  /** A single numeric value: SHORT, LONG, RATIONAL or SRATIONAL. NaN when absent or unreadable. */
  const value = (ifd: Map<number, Entry>, tag: number): number => {
    const e = ifd.get(tag);
    if (!e || e.count < 1) return NaN;
    if (e.type === 3) return u16(e.at);
    if (e.type === 4) return u32(e.at);
    if (e.type === 5 || e.type === 10) {
      const off = t0 + u32(e.at);
      if (!inside(off, 8)) return NaN;
      const num = e.type === 5 ? dv.getUint32(off, le) : dv.getInt32(off, le);
      const den = e.type === 5 ? dv.getUint32(off + 4, le) : dv.getInt32(off + 4, le);
      return den === 0 ? NaN : num / den;
    }
    return NaN;
  };

  const ifd0Rel = u32(t0 + 4);
  if (!Number.isFinite(ifd0Rel)) return null;
  const ifd0 = readIfd(ifd0Rel);
  const info: ExifInfo = {};
  const o = value(ifd0, TAG.orientation);
  if (o >= 1 && o <= 8) info.orientation = o;
  const exifRel = value(ifd0, TAG.exifIfd);
  if (Number.isFinite(exifRel) && exifRel > 0) {
    const ex = readIfd(exifRel);
    const put = (k: 'focal35' | 'digitalZoom' | 'focalMm' | 'pixelW' | 'pixelH') => {
      const v = value(ex, TAG[k]);
      if (Number.isFinite(v) && v > 0) info[k] = v;
    };
    put('focal35'); put('digitalZoom'); put('focalMm'); put('pixelW'); put('pixelH');
  }
  return info;
}
