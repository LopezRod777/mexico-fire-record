export function median(values) {
  const a = values.filter(Number.isFinite).sort((x, y) => x - y);
  if (!a.length) return null;
  return a.length % 2 ? a[(a.length - 1) / 2] : (a[a.length / 2 - 1] + a[a.length / 2]) / 2;
}
export function anomalies(months, values) {
  const medians = Array.from({ length: 12 }, (_, m) => median(values.filter((_, i) => Number(months[i].slice(5)) === m + 1)));
  return values.map((v, i) => {
    const med = medians[Number(months[i].slice(5)) - 1];
    return v == null || med == null || med === 0 ? null : v / med * 100;
  });
}
