// api/protheus-discover.js — testa endpoints alternativos do Protheus
// Temporário para descobrir qual endpoint retorna todos os clientes
// DELETE após identificar o endpoint correto

import https from 'https';

const agent = new https.Agent({ rejectUnauthorized: false });

function tryEndpoint(base, auth, path) {
  const url = `${base}${path}?pageSize=5&page=1`;
  const parsed = new URL(url);

  return new Promise((resolve) => {
    const r = https.request({
      hostname: parsed.hostname,
      port:     parsed.port || 443,
      path:     parsed.pathname + parsed.search,
      method:   'GET',
      headers:  { 'Authorization': `Basic ${auth}`, 'Accept': 'application/json' },
      agent,
      timeout:  6000,
    }, (resp) => {
      let body = '';
      resp.on('data', c => body += c);
      resp.on('end', () => {
        try {
          const json = JSON.parse(body);
          resolve({
            path,
            status:   resp.statusCode,
            total:    json.total ?? '?',
            hasNext:  json.hasNext ?? '?',
            count:    (json.items || []).length,
            sample:   (json.items || [])[0]?.name || (json.items || [])[0]?.shortName || null,
            error:    json.errorCode || json.message || null,
          });
        } catch {
          resolve({ path, status: resp.statusCode, raw: body.substring(0, 80) });
        }
      });
    });
    r.on('error',   (e) => resolve({ path, error: e.message }));
    r.on('timeout', () => { r.destroy(); resolve({ path, error: 'timeout' }); });
    r.end();
  });
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const base = process.env.PROTHEUS_BASE;
  const user = process.env.PROTHEUS_USER;
  const pass = process.env.PROTHEUS_PASS;
  if (!base || !user || !pass)
    return res.status(500).json({ error: 'Env vars faltando' });

  const auth = Buffer.from(`${user}:${pass}`).toString('base64');

  const paths = [
    '/api/crm/v1/customerVendor',
    '/api/framework/v1/customerVendor',
    '/api/erp/v1/customerVendor',
    '/totvsrestapi/api/erp/v1/customerVendor',
    '/api/framework/v1/customers',
    '/api/crm/v2/customerVendor',
  ];

  const results = await Promise.all(paths.map(p => tryEndpoint(base, auth, p)));
  return res.status(200).json(results);
}
