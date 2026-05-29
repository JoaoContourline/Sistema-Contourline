// api/protheus.js — Vercel serverless function
// Proxy server-side para a API do Protheus (sem CORS no browser)
// A API do Protheus ignora filtros, então busca pageSize=50 de uma vez (~3-4s)
// e filtra CPF/CNPJ em GovernmentalInformation[].id aqui mesmo.
//
// Variáveis de ambiente necessárias no Vercel:
//   PROTHEUS_BASE, PROTHEUS_USER, PROTHEUS_PASS

import https from 'https';

const agent = new https.Agent({ rejectUnauthorized: false });

function fetchPage(base, auth, page, pageSize) {
  const url = new URL(`${base}/api/crm/v1/customerVendor`);
  url.searchParams.set('pageSize', String(pageSize));
  url.searchParams.set('page',     String(page));

  return new Promise((resolve, reject) => {
    const options = {
      hostname: url.hostname,
      port:     url.port || 443,
      path:     url.pathname + url.search,
      method:   'GET',
      headers:  { 'Authorization': `Basic ${auth}`, 'Accept': 'application/json' },
      agent,
      timeout:  8000,
    };
    const r = https.request(options, (resp) => {
      let body = '';
      resp.on('data', chunk => body += chunk);
      resp.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch { reject(new Error('JSON inválido: ' + body.substring(0, 120))); }
      });
    });
    r.on('error',   reject);
    r.on('timeout', () => { r.destroy(); reject(new Error('timeout na página ' + page)); });
    r.end();
  });
}

// Verifica CPF/CNPJ em todos os campos e em GovernmentalInformation
function matchItem(item, digits) {
  for (const val of Object.values(item)) {
    if ((typeof val === 'string' || typeof val === 'number') &&
        String(val).replace(/\D/g, '') === digits) return true;
  }
  const govInfo = item.GovernmentalInformation || item.governmentalInformation || [];
  return govInfo.some(g => String(g.id || '').replace(/\D/g, '') === digits);
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

  if (!base || !user || !pass) {
    return res.status(500).json({ error: 'Variáveis de ambiente do Protheus não configuradas' });
  }

  const auth    = Buffer.from(`${user}:${pass}`).toString('base64');
  const PAGE_SZ = 50;  // ~3-4s por requisição — seguro para o limite de 10s do Vercel
  const MAX_PG  = 2;   // até 100 registros no total (2 páginas × 50)

  try {
    for (let page = 1; page <= MAX_PG; page++) {
      const data  = await fetchPage(base, auth, page, PAGE_SZ);
      const items = data.items || [];

      const found = items.find(item => matchItem(item, digits));
      if (found) {
        return res.status(200).json({ items: [found] });
      }

      // Sem mais páginas
      if (!data.hasNext || items.length < PAGE_SZ) {
        return res.status(200).json({ items: [], total: data.total || 0 });
      }
    }

    // Esgotou as 2 páginas sem achar
    return res.status(200).json({ items: [], total: null });

  } catch (err) {
    console.error('Protheus error:', err.message);
    return res.status(502).json({ error: err.message || 'Falha ao conectar com o Protheus' });
  }
}
