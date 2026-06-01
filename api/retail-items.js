// api/retail-items.js — Equipamentos PA do Protheus para o seletor de Nova OP
// Cache-Control 4h no Vercel CDN — os itens raramente mudam
//
// Env vars: PROTHEUS_BASE, PROTHEUS_USER, PROTHEUS_PASS

import https from 'node:https';

const agent = new https.Agent({ rejectUnauthorized: false });

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET')    return res.status(405).json({ error: 'Method not allowed' });

  const base = process.env.PROTHEUS_BASE;
  const user = process.env.PROTHEUS_USER;
  const pass = process.env.PROTHEUS_PASS;
  if (!base || !user || !pass)
    return res.status(500).json({ error: 'Env vars não configuradas (PROTHEUS_BASE/USER/PASS)' });

  const auth   = Buffer.from(`${user}:${pass}`).toString('base64');
  const target = new URL(`${base}/api/retail/v1/retailItem`);
  target.searchParams.set('pageSize',    '500');
  target.searchParams.set('productType', 'PA');

  return new Promise((resolve) => {
    const r = https.request(
      {
        hostname: target.hostname,
        port:     target.port || 443,
        path:     target.pathname + target.search,
        method:   'GET',
        headers:  { Authorization: `Basic ${auth}`, Accept: 'application/json' },
        agent,
        timeout:  15000,
      },
      (resp) => {
        let body = '';
        resp.on('data', chunk => { body += chunk; });
        resp.on('end', () => {
          try {
            const d     = JSON.parse(body);
            const items = (d.items || [])
              .filter(i => i.Active?.trim() === 'S' && i.Code?.trim() && i.Description?.trim())
              .map(i => ({
                code:   i.Code.trim(),
                name:   i.Description.trim(),
                price:  i.SalesPrice || 0,
                tracking: i.Trail?.trim() === 'L' ? 'lote' : i.Trail?.trim() === 'S' ? 'serie' : null,
              }))
              .sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));

            res.setHeader('Cache-Control', 'public, max-age=14400, stale-while-revalidate=3600');
            resolve(res.status(200).json({ items, total: items.length }));
          } catch (err) {
            resolve(res.status(502).json({ error: 'Parse error: ' + err.message }));
          }
        });
      }
    );
    r.on('error',   (err) => resolve(res.status(502).json({ error: err.message })));
    r.on('timeout', ()    => { r.destroy(); resolve(res.status(504).json({ error: 'Timeout' })); });
    r.end();
  });
}
