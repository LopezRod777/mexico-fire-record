import { t } from './i18n.js';

const NS = 'http:' + '//www.w3.org/2000/svg';

// Tamaño original de img/aqua-yucatan-2005-03-22.jpg.
export const HERO_IMAGE = { width: 1920, height: 1683 };

// Tres puntos rojos reales de esa imagen (detecciones de fuego de MODIS, 22 mar 2005), en
// coordenadas relativas (x / 1920, y / 1683). Se obtuvieron una sola vez así: `sips -s format bmp`
// convirtió el JPEG a BMP; un script de Python (solo biblioteca estándar) marcó los píxeles con
// R >= 170, R - G >= 90 y R - B >= 90, los agrupó por vecindad (8 vecinos), tomó el centroide de
// cada grupo y se quedaron los grupos de 8 a 9 píxeles sin otro punto rojo a menos de 32 px,
// dentro de la península de Yucatán. Centroide y color del píxel central medidos:
//   A (816.5, 443.5) rgb(198, 19, 47) · B (1065.7, 576.7) rgb(173, 27, 36) · C (925.5, 672.5) rgb(209, 20, 38)
export const HERO_DOTS = [
  [0.4253, 0.2635],
  [0.5551, 0.3427],
  [0.4820, 0.3996]
];

// "50% 45%" (o palabras clave) -> [0.5, 0.45], como lo resuelve object-position.
export function parseObjectPosition(value = '50% 50%') {
  const words = { left: 0, top: 0, center: 0.5, right: 1, bottom: 1 };
  const parts = String(value).trim().split(/\s+/).map(v => v in words ? words[v] : v.endsWith('%') ? Number.parseFloat(v) / 100 : NaN);
  const [x = 0.5, y = 0.5] = parts;
  return [Number.isFinite(x) ? x : 0.5, Number.isFinite(y) ? y : 0.5];
}

// Posición en px, dentro de una caja, de un punto relativo de la imagen con object-fit: cover.
export function coverPoint(rel, box, image = HERO_IMAGE, position = [0.5, 0.5]) {
  const scale = Math.max(box.width / image.width, box.height / image.height);
  const w = image.width * scale, h = image.height * scale;
  return { x: (box.width - w) * position[0] + rel[0] * w, y: (box.height - h) * position[1] + rel[1] * h };
}

function svgNode(tag, attrs) { const e = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v)); return e; }

// Anillo fino que pulsa + rótulo "1 detección" sobre cada punto. La posición vive en el <g>
// padre (translate); solo se anima el círculo hijo, que no lleva atributo transform.
export function setupHeroMarks() {
  const viewport = document.querySelector('.photo-viewport'), image = viewport?.querySelector('img');
  if (!viewport || !image) return;
  const svg = svgNode('svg', { class: 'hero-marks', 'aria-hidden': 'true' });
  viewport.append(svg);
  function draw() {
    const box = viewport.getBoundingClientRect();
    if (!box.width || !box.height) return;
    svg.setAttribute('viewBox', `0 0 ${box.width.toFixed(1)} ${box.height.toFixed(1)}`);
    const position = parseObjectPosition(getComputedStyle(image).objectPosition);
    const marks = HERO_DOTS.map((rel, i) => {
      const p = coverPoint(rel, box, HERO_IMAGE, position);
      const g = svgNode('g', { class: 'hero-mark', transform: `translate(${p.x.toFixed(1)} ${p.y.toFixed(1)})` });
      g.append(svgNode('circle', { class: 'hero-pulse', r: 11 }), svgNode('circle', { class: 'hero-ring', r: 11 }));
      const label = svgNode('text', { class: `hero-dot-label${i ? ' hero-dot-label-extra' : ''}`, x: 17, y: 5, 'data-i18n': 'heroDotLabel' });
      label.textContent = t('heroDotLabel');
      g.append(label);
      return g;
    });
    svg.replaceChildren(...marks);
  }
  new ResizeObserver(draw).observe(viewport);
  if (!image.complete) image.addEventListener('load', draw, { once: true });
  draw();
}
