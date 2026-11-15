const cache = new Map();
export async function loadData(name) {
  if (!cache.has(name)) {
    cache.set(name, fetch(`data/${name}`).then(async response => {
      if (!response.ok) throw new Error(`No se pudo cargar ${name} (${response.status}).`);
      return response.json();
    }).catch(error => { cache.delete(name); throw error; }));
  }
  return cache.get(name);
}
export async function loadAll() {
  const names = ['meta.json', 'series_monthly.json', 'cells_yearly.json', 'harmonized.json', 'health.json', 'geo/mx_states.geojson'];
  try { return Object.fromEntries(await Promise.all(names.map(async name => [name, await loadData(name)]))); }
  catch (error) { document.getElementById('load-error').textContent = `No se pudieron cargar los datos: ${error.message}`; throw error; }
}
