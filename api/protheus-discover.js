// api/protheus-discover.js — testa paginação com pageSize pequeno
// Temporário — DELETE após identificar configuração correta

import https from 'https';

const agent = new https.Agent({ rejectUnauthorized: false });

function fetchTest(base, auth, pageSize, page) {
  const url = new URL(`${base}/api/crm/v1/customerVendor`);
  url.searchParams.set('pageSize', String(pageSize));
  url.searchParams.set('page',     String(page));
  const t0 = Date.now();

  return new Promise((resolve) => {
    const r = https.request({
      hostname: url.hostname,
      port:     url.port || 443,
      path:     url.pathname + url.search,
      method:   'GET',
      headers:  { 'Authorization': `Basic ${auth}`, 'Accept': 'application/json' },
      agent, timeout: 8000,
    }, (resp) => {
      let body = '';
      resp.on('data', c => body += c);
      resp.on('end', () => {
        try {
          const j = JSON.parse(body);
          resolve({ pageSize, page, ms: Date.now()-t0, status: resp.statusCode,
            count: (j.items||[]).length, hasNext: j.hasNext, total: j.total ?? '?' });
        } catch {
          resolve({ pageSize, page, ms: Date.now()-t0, status: resp.statusCode, error: body.substring(0,80) });
        }
      });
    });
    r.on('error',   e => resolve({ pageSize, page, error: e.message }));
    r.on('timeout', () => { r.destroy(); resolve({ pageSize, page, error: 'timeout' }); });
    r.end();
  });
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const base = process.env.PROTHEUS_BASE;
  const user = process.env.PROTHEUS_USER;
  const pass = process.env.PROTHEUS_PASS;
  if (!base || !user || !pass) return res.status(500).json({ error: 'Env vars faltando' });

  const auth = Buffer.from(`${user}:${pass}`).toString('base64');

  // Testa diferentes pageSizes e páginas para entender o comportamento
  const tests = [
    [5,  1], [5,  2], [5,  3], [5,  10], [5,  50],
    [10, 1], [10, 2], [10, 5], [10, 10],
    [20, 1], [20, 2], [20, 5],
    [25, 1], [25, 2],
  ];

  const results = await Promise.all(tests.map(([ps, pg]) => fetchTest(base, auth, ps, pg)));
  return res.status(200).json(results);
}
