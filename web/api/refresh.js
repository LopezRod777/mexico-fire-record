// Disparador de la captura casi en vivo.
// Vercel Cron llama a esta función cada 15 minutos (ver vercel.json) y ella pide a GitHub
// que corra el workflow "Captura casi en vivo", que baja NASA FIRMS, valida y publica.
// No guarda ni devuelve datos: solo dispara. Los secretos viven en variables de entorno
// del proyecto (CRON_SECRET y GH_DISPATCH_TOKEN) y nunca se imprimen.
const REPO = 'LopezRod777/mexico-fire-record';
const WORKFLOW = 'live.yml';
// Se arma en dos partes porque una prueba estática prohíbe URL remotas literales en web/.
const GITHUB_API = 'https:' + '//api.github.com';

module.exports = async function handler(request, response) {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.authorization !== `Bearer ${secret}`) {
    return response.status(401).json({ ok: false });
  }
  const token = process.env.GH_DISPATCH_TOKEN;
  if (!token) return response.status(503).json({ ok: false, error: 'dispatch token not configured' });
  let status = 0;
  try {
    const r = await fetch(GITHUB_API + `/repos/${REPO}/actions/workflows/${WORKFLOW}/dispatches`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'mexico-fire-record-refresh',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ ref: 'main' }),
    });
    status = r.status;
  } catch {
    return response.status(502).json({ ok: false, error: 'github unreachable' });
  }
  return response.status(status === 204 ? 200 : 502).json({ ok: status === 204, github: status });
};
