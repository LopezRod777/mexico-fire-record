export const VIEW = { width: 700, height: 440, west: -118.4, east: -86.7, south: 14.5, north: 32.7 };
export function project(lon, lat, view = VIEW) {
  const mid = (view.north + view.south) / 2, c = Math.cos(mid * Math.PI / 180);
  const w = (view.east - view.west) * c, h = view.north - view.south;
  const scale = Math.min((view.width - 20) / w, (view.height - 20) / h);
  return [(view.width - w * scale) / 2 + (lon - view.west) * c * scale, (view.height - h * scale) / 2 + (view.north - lat) * scale];
}
export function ringToPath(ring, view = VIEW) {
  return ring.map(([lon, lat], i) => { const [x, y] = project(lon, lat, view); return `${i ? 'L' : 'M'}${x.toFixed(2)},${y.toFixed(2)}`; }).join(' ') + 'Z';
}
export function geometryToPath(geometry, view = VIEW) {
  const polygons = geometry.type === 'MultiPolygon' ? geometry.coordinates : [geometry.coordinates];
  return polygons.map(poly => poly.map(ring => ringToPath(ring, view)).join(' ')).join(' ');
}
