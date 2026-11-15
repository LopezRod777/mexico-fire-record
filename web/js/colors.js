export const PALETTE = ['#2A1712', '#5C2314', '#9C3A12', '#D4571A', '#F28A1F', '#FFC24A', '#FFF0B8'];
function channel(hex, i) { return parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16); }
export function colorFor(t) {
  const x = Math.max(0, Math.min(1, t)) * (PALETTE.length - 1);
  const lo = Math.floor(x), hi = Math.min(PALETTE.length - 1, lo + 1), f = x - lo;
  return '#' + [0, 1, 2].map(i => Math.round(channel(PALETTE[lo], i) * (1 - f) + channel(PALETTE[hi], i) * f).toString(16).padStart(2, '0')).join('').toUpperCase();
}
export function luminance(hex) {
  const rgb = [0, 1, 2].map(i => channel(hex, i) / 255).map(v => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
}
export function contrast(a, b) { const [l, d] = [luminance(a), luminance(b)].sort((x, y) => y - x); return (l + 0.05) / (d + 0.05); }
export function quantile(values, q) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return 0;
  const pos = (sorted.length - 1) * q, i = Math.floor(pos);
  return sorted[i] + (sorted[Math.min(i + 1, sorted.length - 1)] - sorted[i]) * (pos - i);
}
