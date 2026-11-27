import { describe, expect, it } from 'vitest';
import { readExif } from './exif';

type Tag = { tag: number; type: 3 | 4 | 5; value: number | [number, number] };

/** Builds a minimal JPEG: SOI, optional APP0, APP1 Exif with IFD0 (+ Exif IFD), SOS, EOI. */
function jpeg({ le, ifd0 = [], exif = [], app0 = false, scanFirst = false }: {
  le: boolean; ifd0?: Tag[]; exif?: Tag[]; app0?: boolean; scanFirst?: boolean;
}): Uint8Array {
  const out: number[] = [];
  const u16 = (v: number) => (le ? [v & 255, v >> 8] : [v >> 8, v & 255]);
  const u32 = (v: number) => (le ? [v & 255, (v >> 8) & 255, (v >> 16) & 255, v >>> 24] : [v >>> 24, (v >> 16) & 255, (v >> 8) & 255, v & 255]);
  // TIFF: header (8) + IFD0 + Exif IFD + rational data.
  const all0 = exif.length ? [...ifd0, { tag: 0x8769, type: 4 as const, value: 0 }] : ifd0;
  const ifd0Size = 2 + all0.length * 12 + 4;
  const exifAt = 8 + ifd0Size;
  const exifSize = exif.length ? 2 + exif.length * 12 + 4 : 0;
  let dataAt = exifAt + exifSize;
  const data: number[] = [];
  const ifd = (tags: Tag[]) => {
    const b: number[] = [...u16(tags.length)];
    for (const t of [...tags].sort((a, c) => a.tag - c.tag)) {
      b.push(...u16(t.tag), ...u16(t.type), ...u32(1));
      if (t.tag === 0x8769) b.push(...u32(exifAt));
      else if (t.type === 3) b.push(...u16(t.value as number), 0, 0);
      else if (t.type === 4) b.push(...u32(t.value as number));
      else { const [n, d] = t.value as [number, number]; b.push(...u32(dataAt)); data.push(...u32(n), ...u32(d)); dataAt += 8; }
    }
    b.push(...u32(0));
    return b;
  };
  const tiff = [...(le ? [0x49, 0x49] : [0x4d, 0x4d]), ...u16(42), ...u32(8), ...ifd(all0), ...(exif.length ? ifd(exif) : []), ...data];
  const app1 = [0x45, 0x78, 0x69, 0x66, 0, 0, ...tiff];
  out.push(0xff, 0xd8);
  if (app0) out.push(0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0);
  if (scanFirst) out.push(0xff, 0xda, 0, 2);
  out.push(0xff, 0xe1, (app1.length + 2) >> 8, (app1.length + 2) & 255, ...app1);
  out.push(0xff, 0xda, 0, 2, 0xff, 0xd9);
  return new Uint8Array(out);
}

const phone: Tag[] = [
  { tag: 0xa405, type: 3, value: 26 },
  { tag: 0xa404, type: 5, value: [3, 2] },
  { tag: 0x920a, type: 5, value: [686, 100] },
  { tag: 0xa002, type: 4, value: 4032 },
  { tag: 0xa003, type: 4, value: 3024 },
];

describe('readExif', () => {
  for (const le of [false, true]) {
    it(`reads the tags from ${le ? 'little' : 'big'}-endian EXIF`, () => {
      const info = readExif(jpeg({ le, ifd0: [{ tag: 0x0112, type: 3, value: 6 }], exif: phone }));
      expect(info).toEqual({ orientation: 6, focal35: 26, digitalZoom: 1.5, focalMm: 6.86, pixelW: 4032, pixelH: 3024 });
    });
  }
  it('portrait and landscape orientations are both just reported', () => {
    expect(readExif(jpeg({ le: true, ifd0: [{ tag: 0x0112, type: 3, value: 1 }], exif: phone }))?.orientation).toBe(1);
    expect(readExif(jpeg({ le: false, ifd0: [{ tag: 0x0112, type: 3, value: 8 }], exif: phone }))?.orientation).toBe(8);
  });
  it('accepts an ArrayBuffer and skips an APP0 segment first', () => {
    const b = jpeg({ le: false, app0: true, exif: [{ tag: 0xa405, type: 3, value: 77 }] });
    expect(readExif(b.buffer as ArrayBuffer)).toEqual({ focal35: 77 });
  });
  it('leaves out missing tags and a zero digital zoom ratio', () => {
    expect(readExif(jpeg({ le: true, exif: [{ tag: 0xa404, type: 5, value: [0, 100] }, { tag: 0x920a, type: 5, value: [4, 1] }] })))
      .toEqual({ focalMm: 4 });
    expect(readExif(jpeg({ le: true, ifd0: [{ tag: 0x0112, type: 3, value: 3 }] }))).toEqual({ orientation: 3 });
  });
  it('ignores an out-of-range orientation and a zero denominator', () => {
    expect(readExif(jpeg({ le: true, ifd0: [{ tag: 0x0112, type: 3, value: 9 }], exif: [{ tag: 0xa404, type: 5, value: [2, 0] }] })))
      .toEqual({});
  });
  it('accepts FocalLengthIn35mmFilm stored as LONG', () => {
    expect(readExif(jpeg({ le: false, exif: [{ tag: 0xa405, type: 4, value: 52 }] }))).toEqual({ focal35: 52 });
  });
  it('returns null for non-JPEG data, no APP1, and EXIF after the scan starts', () => {
    expect(readExif(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]))).toBeNull();
    expect(readExif(new Uint8Array([0xff, 0xd8, 0xff, 0xda, 0, 2, 0xff, 0xd9]))).toBeNull();
    expect(readExif(jpeg({ le: true, scanFirst: true, exif: phone }))).toBeNull();
    expect(readExif(new Uint8Array(0))).toBeNull();
  });
  it('survives truncation at every length without throwing', () => {
    const full = jpeg({ le: true, ifd0: [{ tag: 0x0112, type: 3, value: 6 }], exif: phone });
    for (let n = 0; n < full.length; n++) expect(() => readExif(full.slice(0, n))).not.toThrow();
  });
  it('returns null for a bad TIFF header', () => {
    const b = jpeg({ le: true, exif: phone });
    b[b.indexOf(0x49)] = 0x58;  // break the "II" byte order mark
    expect(readExif(b)).toBeNull();
  });
});
