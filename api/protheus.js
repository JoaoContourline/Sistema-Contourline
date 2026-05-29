// api/protheus.js — Vercel serverless function
// Estratégia: página 1 → descobre total → busca todas as páginas restantes em PARALELO
// Tempo total: ~3.5s (pág 1) + ~3.5s (todas as restantes simultâneas) = ~7s fixo
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
        catch { reject(new Error('JSON inválido p' + page)); }
      });
    });
    r.on('error',   reject);
    r.on('timeout', () => { r.destroy(); reject(new Error('timeout p' + page)); });
    r.end();
  });
}

// Verifica SOMENTE GovernmentalInformation[].id (campo CPF/CNPJ do Protheus)
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

  try {
    // ── 1. Página 1 — descobre total e já busca ──────────────────────
    const first = await fetchPage(base, auth, 1, PAGE_SZ);
    const firstItems = first.items || [];

    const foundFirst = firstItems.find(item => matchItem(item, digits));
    if (foundFirst) return res.status(200).json({ items: [foundFirst] });

    if (!first.hasNext) return res.status(200).json({ items: [] });

    // ── 2. Calcula páginas restantes ─────────────────────────────────
    let pageNums;
    if (first.total && first.total > PAGE_SZ) {
      const totalPages = Math.ceil(first.total / PAGE_SZ);
      pageNums = Array.from({ length: totalPages - 1 }, (_, i) => i + 2);
    } else {
      // Sem total: tenta até 20 páginas extras em paralelo (600 registros)
      pageNums = Array.from({ length: 20 }, (_, i) => i + 2);
    }

    // ── 3. Busca TODAS as páginas restantes simultaneamente ───────────
    const pages = await Promise.all(
      pageNums.map(p => fetchPage(base, auth, p, PAGE_SZ).catch(() => ({ items: [] })))
    );

    for (const data of pages) {
      const found = (data.items || []).find(item => matchItem(item, digits));
      if (found) return res.status(200).json({ items: [found] });
    }

    return res.status(200).json({ items: [] });

  } catch (err) {
    console.error('Protheus error:', err.message);
    return res.status(502).json({ error: err.message || 'Falha ao conectar com o Protheus' });
  }
}
