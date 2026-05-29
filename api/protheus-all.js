// api/protheus-all.js — Retorna TODOS os clientes Protheus em formato compacto
// O cliente armazena em localStorage (TTL 4h) — buscas subsequentes são instantâneas
// 25 páginas × 30 registros em paralelo = até 750 clientes em ~3.5s

import https from 'https';

const agent = new https.Agent({ rejectUnauthorized: false });

function fetchPage(base, auth, page, pageSize) {
  const url = new URL(`${base}/api/crm/v1/customerVendor`);
  url.searchParams.set('pageSize', String(pageSize));
  url.searchParams.set('page',     String(page));

  return new Promise((resolve) => {
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

// Retorna só o que o cliente precisa — sem os campos de padding gigantes
function compact(item) {
  const gov = item.GovernmentalInformation || item.governmentalInformation || [];
  const cpfEntry = gov.find(g => g.name === 'CPF|CNPJ');
  const cpfDigits = cpfEntry ? String(cpfEntry.id || '').replace(/\D/g, '') : '';
  if (!cpfDigits) return null;

  const addr = item.address || {};
  const comm = (item.listOfCommunicationInformation || [])[0] || {};
  const rgEntry = gov.find(g => g.name === 'RG');

  return {
    cpfDigits,
    name:       (item.name      || '').trim(),
    shortName:  (item.shortName || '').trim(),
    entityType: item.entityType || 'F',
    address: {
      address:    (addr.address    || '').trim(),
      number:     (addr.number     || '').trim(),
      complement: (addr.complement || '').trim(),
      district:   (addr.district   || '').trim(),
      zipCode:    (addr.zipCode    || '').trim(),
      city:  { cityDescription: ((addr.city  || {}).cityDescription || '').trim() },
      state: { stateId:         ((addr.state || {}).stateId         || '').trim() },
    },
    listOfCommunicationInformation: [{
      diallingCode: (comm.diallingCode || '').trim(),
      phoneNumber:  (comm.phoneNumber  || '').trim(),
      email:        (comm.email        || '').trim(),
    }],
    GovernmentalInformation: rgEntry && rgEntry.id && rgEntry.id.trim()
      ? [{ id: rgEntry.id.trim(), name: 'RG' }]
      : [],
  };
}

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
    return res.status(500).json({ error: 'Variáveis de ambiente do Protheus não configuradas' });

  const auth      = Buffer.from(`${user}:${pass}`).toString('base64');
  const PAGE_SZ   = 30;
  const BATCH_SZ  = 25; // páginas por lote
  const N_BATCHES = 2;  // 2 lotes × 25 × 30 = 1.500 clientes, ~7s total

  try {
    const allPages = [];
    for (let b = 0; b < N_BATCHES; b++) {
      const batch = await Promise.all(
        Array.from({ length: BATCH_SZ }, (_, i) =>
          fetchPage(base, auth, b * BATCH_SZ + i + 1, PAGE_SZ)
        )
      );
      allPages.push(...batch);
      // Se nenhuma página do lote tinha hasNext, não há mais dados
      if (batch.every(d => !d.hasNext && (d.items || []).length < PAGE_SZ)) break;
    }

    const items = allPages
      .flatMap(d => d.items || [])
      .map(compact)
      .filter(Boolean);

    // Cache-Control: 4h no CDN do Vercel
    res.setHeader('Cache-Control', 'public, max-age=14400, stale-while-revalidate=3600');
    return res.status(200).json({ items, cachedAt: Date.now() });

  } catch (err) {
    console.error('protheus-all error:', err.message);
    return res.status(502).json({ error: err.message });
  }
}
