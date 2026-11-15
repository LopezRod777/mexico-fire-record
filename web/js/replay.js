// Funciones puras de la capa "Hoy": agrupamiento de llamas, pases, reloj de la reproducción
// y la estimación "con los ojos de MODIS". Sin DOM, para poder probarlas con node --test.

// Cortes de color por FRP (MW): naranja < 5, ámbar 5–15, amarillo >= 15.
export const FRP_CUTS = [5, 15];
export function frpClass(frp) {
  const v = Number.isFinite(frp) ? frp : 0;
  return v < FRP_CUTS[0] ? 'flame-low' : v < FRP_CUTS[1] ? 'flame-mid' : 'flame-high';
}

// Altura en px de la llama de un grupo: escala raíz del número de detecciones, con tope.
export function clusterHeight(n) { return Math.min(40, 14 + 7 * (Math.sqrt(Math.max(1, n)) - 1)); }

// Agrupa puntos {x, y, frp} (unidades del viewBox) hasta que ninguna pareja de llamas quede
// encimada a su tamaño final. k convierte px de pantalla a unidades del viewBox, así que el
// agrupamiento depende del ancho real del mapa. Cada grupo lleva los índices de sus puntos.
export function clusterDetections(points, k = 1) {
  const clusters = points.map((p, i) => ({ x: p.x, y: p.y, n: 1, frpMax: Number.isFinite(p.frp) ? p.frp : 0, members: [i] }));
  for (;;) {
    let best = null, bestRatio = 1;
    for (let i = 0; i < clusters.length; i++) for (let j = i + 1; j < clusters.length; j++) {
      const a = clusters[i], b = clusters[j];
      const ratio = Math.hypot(a.x - b.x, a.y - b.y) / (0.55 * (clusterHeight(a.n) + clusterHeight(b.n)) * k);
      if (ratio < bestRatio) { bestRatio = ratio; best = [i, j]; }
    }
    if (!best) break;
    const [i, j] = best, a = clusters[i], b = clusters[j], n = a.n + b.n;
    clusters[i] = { x: (a.x * a.n + b.x * b.n) / n, y: (a.y * a.n + b.y * b.n) / n, n, frpMax: Math.max(a.frpMax, b.frpMax), members: a.members.concat(b.members) };
    clusters.splice(j, 1);
  }
  return clusters.sort((a, b) => a.n - b.n || a.frpMax - b.frpMax);
}

// Atributos SVG de un grupo. La posición vive en el <g> exterior; el <g> que se anima
// (clase live-ignite) no lleva transform, para que una animación CSS de transform no
// borre la posición; la llama solo lleva su escala y el ajuste del dibujo (-10 -28).
export function clusterAttrs(cluster, heightPx, k) {
  const h = heightPx * k;
  return {
    position: { transform: `translate(${cluster.x} ${cluster.y})` },
    ignite: { class: 'live-ignite' },
    flame: { transform: `scale(${h / 28}) translate(-10 -28)` },
    count: { transform: `translate(${h * 0.38 + 3 * k} ${-h * 0.3})` }
  };
}

export function detectionTime(d) { return Date.parse(`${d.fecha}T${d.hora_utc}:00Z`); }

// Pases: detecciones del mismo satélite separadas por menos de 30 min.
export function satellitePasses(detections, gapMinutes = 30) {
  const rows = detections.map(d => ({ sat: d.sat, time: detectionTime(d) })).sort((a, b) => a.time - b.time);
  const passes = [];
  for (const row of rows) {
    const open = passes.findLast(p => p.sat === row.sat);
    if (open && row.time - open.end <= gapMinutes * 60000) { open.end = row.time; open.n++; }
    else passes.push({ sat: row.sat, start: row.time, end: row.time, n: 1 });
  }
  return passes.sort((a, b) => a.start - b.start);
}

// Reloj de la reproducción: progreso 0..1 a un instante entre la primera y la última detección.
export function replayTime(progress, first, last) { return first + Math.max(0, Math.min(1, progress)) * (last - first); }
export function passAt(passes, time) { return passes.findLast(p => p.start <= time) ?? null; }

// Día o noche por hora solar local (UTC + longitud/15): el snapshot no trae la bandera daynight.
export function dayNight(d) {
  const [h, m] = d.hora_utc.split(':').map(Number);
  const solar = (((h + m / 60 + d.lon / 15) % 24) + 24) % 24;
  return solar >= 6 && solar < 18 ? 'D' : 'N';
}
export function frpBin(frpSum) { return frpSum < 3 ? '<3' : frpSum < 10 ? '3-10' : frpSum < 30 ? '10-30' : '30+'; }

// Probabilidad, por detección, de que Aqua (MODIS) vea fuego el mismo día en la misma celda
// de 0.02°, con la tabla health.json → mx.overlap_probability. Igual que en el pipeline,
// el FRP se suma por celda, día, sensor y día/noche antes de elegir el rango.
export function modisProbabilities(detections, overlapRows) {
  const table = new Map(overlapRows.map(r => [`${r.daynight}|${r.bin}`, r.p_mismo_dia]));
  const key = d => [d.sat, d.fecha, dayNight(d), Math.floor(d.lat / 0.02), Math.floor(d.lon / 0.02)].join('|');
  const sums = new Map();
  for (const d of detections) sums.set(key(d), (sums.get(key(d)) ?? 0) + (Number.isFinite(d.frp) ? d.frp : 0));
  return detections.map(d => {
    const p = table.get(`${dayNight(d)}|${frpBin(sums.get(key(d)))}`);
    return Number.isFinite(p) ? p : null;
  });
}
export function modisExpected(probabilities) {
  if (!probabilities.length || probabilities.some(p => p == null)) return null;
  return Math.round(probabilities.reduce((sum, p) => sum + p, 0));
}

// Detecciones con mayor probabilidad hasta completar n (por omisión, la suma redondeada).
// Determinista: probabilidad descendente y, si empatan, el índice original.
export function modisSelection(probabilities, n = modisExpected(probabilities)) {
  if (n == null) return [];
  return probabilities.map((p, i) => i).sort((a, b) => probabilities[b] - probabilities[a] || a - b).slice(0, n).sort((a, b) => a - b);
}

// Línea de tiempo: el eje va del inicio del bloque de 15 min de la primera detección al final
// del bloque de la última; cada barra cuenta detecciones por satélite en su bloque.
export const BIN_MS = 15 * 60000;
export function timelineBins(detections, binMs = BIN_MS) {
  const times = detections.map(detectionTime);
  if (!times.length) return null;
  const start = Math.floor(Math.min(...times) / binMs) * binMs;
  const end = Math.floor(Math.max(...times) / binMs) * binMs + binMs;
  const bins = Array.from({ length: Math.round((end - start) / binMs) }, (_, i) => ({ t0: start + i * binMs, n20: 0, n21: 0 }));
  detections.forEach((d, i) => { const bin = bins[Math.floor((times[i] - start) / binMs)]; if (d.sat === 'N21') bin.n21++; else bin.n20++; });
  return { start, end, bins, max: Math.max(...bins.map(b => b.n20 + b.n21)) };
}
// Fracción 0..1 del eje para un instante, y el instante para una fracción (clic o arrastre).
export function timelineFraction(time, start, end) { return end > start ? Math.max(0, Math.min(1, (time - start) / (end - start))) : 0; }
export function timelineSeek(fraction, start, end) { return start + Math.max(0, Math.min(1, fraction)) * (end - start); }
// Teclado: flechas = 15 min, RePág/AvPág = 1 h, Inicio/Fin = extremos.
export function timelineKey(key, time, start, end) {
  if (key === 'Home') return start;
  if (key === 'End') return end;
  const step = { ArrowRight: BIN_MS, ArrowUp: BIN_MS, ArrowLeft: -BIN_MS, ArrowDown: -BIN_MS, PageUp: 4 * BIN_MS, PageDown: -4 * BIN_MS }[key];
  return step == null ? null : Math.max(start, Math.min(end, time + step));
}

// Ritmo de la reproducción: el eje es lineal, pero el cabezal va lento durante cada pase
// (± pad) y rápido en las horas sin satélite. Devuelve tramos [t0, t1] con su fracción p0..p1.
export function replaySchedule(passes, start, end, padMs = 10 * 60000, gapWeight = 0.08) {
  const windows = [];
  for (const p of passes) {
    const a = Math.max(start, p.start - padMs), b = Math.min(end, p.end + padMs);
    const last = windows.at(-1);
    if (last && a <= last.t1) last.t1 = Math.max(last.t1, b); else windows.push({ t0: a, t1: b });
  }
  const segments = [];
  let cursor = start;
  for (const w of windows) {
    if (w.t0 > cursor) segments.push({ t0: cursor, t1: w.t0, weight: (w.t0 - cursor) * gapWeight, pass: false });
    segments.push({ t0: cursor > w.t0 ? cursor : w.t0, t1: w.t1, weight: w.t1 - Math.max(cursor, w.t0), pass: true });
    cursor = w.t1;
  }
  if (end > cursor) segments.push({ t0: cursor, t1: end, weight: (end - cursor) * gapWeight, pass: false });
  const total = segments.reduce((sum, s) => sum + s.weight, 0) || 1;
  let acc = 0;
  for (const s of segments) { s.p0 = acc / total; acc += s.weight; s.p1 = acc / total; }
  return segments;
}
export function scheduleTime(progress, segments) {
  if (!segments.length) return 0;
  const p = Math.max(0, Math.min(1, progress));
  const s = segments.find(seg => p <= seg.p1) ?? segments.at(-1);
  return s.p1 > s.p0 ? s.t0 + (p - s.p0) / (s.p1 - s.p0) * (s.t1 - s.t0) : s.t1;
}
export function scheduleProgress(time, segments) {
  if (!segments.length || time <= segments[0].t0) return 0;
  const s = segments.find(seg => time <= seg.t1);
  if (!s) return 1;
  return s.t1 > s.t0 ? s.p0 + (time - s.t0) / (s.t1 - s.t0) * (s.p1 - s.p0) : s.p1;
}
// Pase que se está viendo: el instante cae dentro de su ventana ± pad.
export function passNow(passes, time, padMs = 10 * 60000) {
  return passes.findLast(p => time >= p.start - padMs && time <= p.end + padMs) ?? null;
}
