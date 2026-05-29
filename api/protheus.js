// api/protheus.js — Vercel serverless function
// Dispara TODAS as páginas simultaneamente (Promise.all), sem aguardar page 1.
// Páginas além do total retornam vazio — ignoradas. Tempo fixo ≈ duração de 1 página.
//
// Variáveis de ambiente: PROTHEUS_BASE, PROTHEUS_USER, PROTHEUS_PASS

import https from 'https';

const agent = new https.Agent({ rejectUnauthorized: false });

function fetchPage(base, auth, page, pageSize) {
  const url = new URL(`${base}/api/crm/v1/customerVendor`);
  url.searchParams.set('pageSize', String(pageSize));
  url.searchParams.set('page',     String(page));

  return new Promise((resolve, reject) => {
    const r = https.request({
      hostname: url.hostname,
      port:     url.port || 443,
      path:     url.pathname + url.search,
      method:   'GET',
      headers:  { 'Authorization': `Basic ${auth}`, 'Accept': 'application/json' },
      agent,
      timeout:  8000,
    }, (resp) => {
      let body = '';
      resp.on('data', chunk => body += chunk);
      resp.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch { resolve({ items: [] }); }
      });
    });
    r.on('error',   () => resolve({ items: [] }));
    r.on('timeout', () => { r.destroy(); resolve({ items: [] }); });
    r.end();
  });
}

// Verifica SOMENTE GovernmentalInformation[].id — campo de CPF/CNPJ no Protheus
function matchItem(item, digits) {
  const gov = item.GovernmentalInformation || item.governmentalInformation || [];
  return gov.some(g => String(g.id || '').replace(/\D/g, '') === digits);
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET')    return res.status(405).json({ error: 'Method not allowed' });

  const { cpfCnpj } = req.query;
  if (!cpfCnpj) return res.status(400).json({ error: 'Parâmetro cpfCnpj é obrigatório' });

  const digits = cpfCnpj.replace(/\D/g, '');
  if (digits.length < 11) return res.status(400).json({ error: 'CPF ou CNPJ inválido' });

  const base = process.env.PROTHEUS_BASE;
  const user = process.env.PROTHEUS_USER;
  const pass = process.env.PROTHEUS_PASS;
  if (!base || !user || !pass)
    return res.status(500).json({ error: 'Variáveis de ambiente do Protheus não configuradas' });

  const auth    = Buffer.from(`${user}:${pass}`).toString('base64');
  const PAGE_SZ = 30;
  const N_PAGES = 15; // 15 páginas × 30 = 450 clientes — disparadas todas ao mesmo tempo

  try {
    const results = await Promise.all(
      Array.from({ length: N_PAGES }, (_, i) =>
        fetchPage(base, auth, i + 1, PAGE_SZ)
      )
    );

    const allItems = results.flatMap(d => d.items || []);
    const found    = allItems.find(item => matchItem(item, digits));

    return res.status(200).json({ items: found ? [found] : [] });

  } catch (err) {
    console.error('Protheus error:', err.message);
    return res.status(502).json({ error: err.message || 'Falha ao conectar com o Protheus' });
  }
}
