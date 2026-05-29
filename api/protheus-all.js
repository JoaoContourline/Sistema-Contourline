// api/protheus-all.js — Retorna TODOS os clientes Protheus em formato compacto
// Loop sem limite até hasNext=false — lotes de 25 páginas paralelas por rodada
// maxDuration: 60s (configurado em vercel.json)
//
// Variáveis de ambiente: PROTHEUS_BASE, PROTHEUS_USER, PROTHEUS_PASS

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
  const BATCH_SZ  = 25; // páginas por lote paralelo (~3.5s por lote)

  try {
    const allItems = [];
    let nextPage   = 1;
    let hasMore    = true;

    // Loop até esgotar todos os registros
    while (hasMore) {
      const batch = await Promise.all(
        Array.from({ length: BATCH_SZ }, (_, i) =>
          fetchPage(base, auth, nextPage + i, PAGE_SZ)
        )
      );

      for (const data of batch) {
        const items = data.items || [];
        allItems.push(...items);
        if (!data.hasNext || items.length < PAGE_SZ) {
          hasMore = false;
          break;
        }
      }

      nextPage += BATCH_SZ;
    }

    const compact_items = allItems.map(compact).filter(Boolean);

    res.setHeader('Cache-Control', 'public, max-age=14400, stale-while-revalidate=3600');
    return res.status(200).json({ items: compact_items, total: compact_items.length });

  } catch (err) {
    console.error('protheus-all error:', err.message);
    return res.status(502).json({ error: err.message });
  }
}
