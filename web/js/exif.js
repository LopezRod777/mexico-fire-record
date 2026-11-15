// Lector mínimo de GPS en EXIF de un JPEG, sin librerías. Recibe un ArrayBuffer local (la foto
// nunca sale del navegador) y valida cada desplazamiento antes de leerlo.
export const PHOTO_MAX_BYTES = 40 * 1024 * 1024;
// Solo se leen los primeros 256 KB: el bloque APP1 (EXIF) va al inicio del archivo.
export const EXIF_READ_BYTES = 256 * 1024;

class Malformed extends Error {}
function view(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}
function need(dv, offset, length) { if (!Number.isInteger(offset) || offset < 0 || offset + length > dv.byteLength) throw new Malformed(); }

// Resultado: { status: 'ok', lat, lon } o { status: 'not-jpeg' | 'no-exif' | 'no-gps' | 'malformed' }.
export function readJpegGps(buffer) {
  let dv;
  try { dv = view(buffer); } catch { return { status: 'not-jpeg' }; }
  if (dv.byteLength < 4 || dv.getUint8(0) !== 0xFF || dv.getUint8(1) !== 0xD8) return { status: 'not-jpeg' };
  try {
    let offset = 2;
    for (let guard = 0; guard < 128; guard++) {
      if (offset + 4 > dv.byteLength) return { status: 'no-exif' };
      if (dv.getUint8(offset) !== 0xFF) throw new Malformed();
      const marker = dv.getUint8(offset + 1);
      if (marker === 0xFF) { offset++; continue; }
      if (marker === 0xD9 || marker === 0xDA) return { status: 'no-exif' };
      if ((marker >= 0xD0 && marker <= 0xD7) || marker === 0x01) { offset += 2; continue; }
      const length = dv.getUint16(offset + 2);
      if (length < 2) throw new Malformed();
      const start = offset + 4, size = length - 2;
      if (marker === 0xE1 && size >= 6) {
        need(dv, start, 6);
        const tag = [0, 1, 2, 3, 4, 5].map(i => dv.getUint8(start + i));
        if (tag.join() === '69,120,105,102,0,0') {
          need(dv, start, size);
          return readTiffGps(new DataView(dv.buffer, dv.byteOffset + start + 6, size - 6));
        }
      }
      offset = start + size;
    }
    return { status: 'no-exif' };
  } catch (error) {
    if (error instanceof Malformed || error instanceof RangeError) return { status: 'malformed' };
    throw error;
  }
}

const TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 };
function readTiffGps(dv) {
  need(dv, 0, 8);
  const order = String.fromCharCode(dv.getUint8(0), dv.getUint8(1));
  if (order !== 'II' && order !== 'MM') throw new Malformed();
  const le = order === 'II';
  const u16 = o => { need(dv, o, 2); return dv.getUint16(o, le); };
  const u32 = o => { need(dv, o, 4); return dv.getUint32(o, le); };
  if (u16(2) !== 42) throw new Malformed();
  function entries(ifd) {
    const count = u16(ifd);
    if (count > 512) throw new Malformed();
    need(dv, ifd + 2, count * 12);
    const out = new Map();
    for (let i = 0; i < count; i++) {
      const o = ifd + 2 + i * 12, type = u16(o + 2), n = u32(o + 4), bytes = (TYPE_SIZE[type] ?? 0) * n;
      out.set(u16(o), { type, n, at: bytes <= 4 ? o + 8 : u32(o + 8) });
    }
    return out;
  }
  const gpsPointer = entries(u32(4)).get(0x8825);
  if (!gpsPointer) return { status: 'no-gps' };
  const gps = entries(u32(gpsPointer.at));
  const ref = tag => { const e = gps.get(tag); if (!e) return null; if (e.type !== 2 || e.n < 1) throw new Malformed(); need(dv, e.at, 1); return String.fromCharCode(dv.getUint8(e.at)); };
  const dms = tag => {
    const e = gps.get(tag); if (!e) return null;
    if (e.type !== 5 || e.n !== 3) throw new Malformed();
    need(dv, e.at, 24);
    const parts = [0, 1, 2].map(i => { const num = u32(e.at + i * 8), den = u32(e.at + i * 8 + 4); if (den === 0) throw new Malformed(); return num / den; });
    return parts[0] + parts[1] / 60 + parts[2] / 3600;
  };
  const latRef = ref(1), lat = dms(2), lonRef = ref(3), lon = dms(4);
  if (lat == null || lon == null || latRef == null || lonRef == null) return { status: 'no-gps' };
  if (!'NS'.includes(latRef) || !'EW'.includes(lonRef)) throw new Malformed();
  if (lat > 90 || lon > 180) throw new Malformed();
  if (lat === 0 && lon === 0) return { status: 'no-gps' };
  return { status: 'ok', lat: latRef === 'S' ? -lat : lat, lon: lonRef === 'W' ? -lon : lon };
}
