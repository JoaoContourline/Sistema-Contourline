// api/protheus-sync.js — Sincroniza TODOS os clientes Protheus → Supabase
// Chamar uma vez por dia (ou manualmente quando precisar atualizar).
// Buscas no sistema vão direto no Supabase — instantâneas.
//
// Variáveis de ambiente necessárias no Vercel:
//   PROTHEUS_BASE, PROTHEUS_USER, PROTHEUS_PASS
//   SUPABASE_URL, SUPABASE_SERVICE_KEY  (service_role key — Settings > API no Supabase)

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
      resp.on('data', c => body += c);
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
  const gov      = item.GovernmentalInformation || item.governmentalInformation || [];
  const cpfEntry = gov.find(g => g.name === 'CPF|CNPJ');
  const digits   = cpfEntry ? String(cpfEntry.id || '').replace(/\D/g, '') : '';
  if (!digits) return null;

  const addr = item.address || {};
  const comm = (item.listOfCommunicationInformation || [])[0] || {};
  const rg   = gov.find(g => g.name === 'RG');

  return {
    cpf_digits: digits,
    nome:       (item.name || item.shortName || '').trim(),
    dados: {
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
      GovernmentalInformation: rg && rg.id && rg.id.trim()
        ? [{ id: rg.id.trim(), name: 'RG' }] : [],
    },
  };
}

async function upsertBatch(sbUrl, sbKey, rows) {
  const r = await fetch(`${sbUrl}/rest/v1/protheus_clientes`, {
    method:  'POST',
    headers: {
      apikey:         sbKey,
      Authorization:  `Bearer ${sbKey}`,
      'Content-Type': 'application/json',
      Prefer:         'resolution=merge-duplicates',
    },
    body: JSON.stringify(rows),
  });
  if (!r.ok) throw new Error(`Supabase ${r.status}: ${await r.text()}`);
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const base    = process.env.PROTHEUS_BASE;
  const user    = process.env.PROTHEUS_USER;
  const pass    = process.env.PROTHEUS_PASS;
  const sbUrl   = process.env.SUPABASE_URL;
  const sbKey   = process.env.SUPABASE_SERVICE_KEY;

  if (!base || !user || !pass || !sbUrl || !sbKey)
    return res.status(500).json({ error: 'Variáveis de ambiente incompletas' });

  const auth     = Buffer.from(`${user}:${pass}`).toString('base64');
  const PAGE_SZ  = 30;
  const BATCH_SZ = 25;

  try {
    // ── 1. Busca todos os clientes do Protheus ───────────────────────
    const allRaw = [];
    let nextPage = 1;
    let hasMore  = true;

    while (hasMore) {
      const batch = await Promise.all(
        Array.from({ length: BATCH_SZ }, (_, i) =>
          fetchPage(base, auth, nextPage + i, PAGE_SZ)
        )
      );
      for (const data of batch) {
        allRaw.push(...(data.items || []));
        if (!data.hasNext || (data.items || []).length < PAGE_SZ) {
          hasMore = false;
          break;
        }
      }
      nextPage += BATCH_SZ;
    }

    // ── 2. Compacta e filtra só quem tem CPF/CNPJ ───────────────────
    const rows = allRaw.map(compact).filter(Boolean);

    // Debug: mostra primeiro item bruto se não achou nada
    const debug = {
      rawTotal: allRaw.length,
      withCpf:  rows.length,
      sample:   allRaw[0] ? {
        keys:    Object.keys(allRaw[0]),
        govInfo: allRaw[0].GovernmentalInformation || allRaw[0].governmentalInformation || 'ausente',
      } : null,
    };

    if (!rows.length) {
      return res.status(200).json({ ok: false, total: 0, debug });
    }

    // ── 3. Upsert no Supabase em lotes de 500 ───────────────────────
    const UPSERT_SZ = 500;
    for (let i = 0; i < rows.length; i += UPSERT_SZ) {
      await upsertBatch(sbUrl, sbKey, rows.slice(i, i + UPSERT_SZ));
    }

    console.log(`protheus-sync: ${rows.length} clientes sincronizados`);
    return res.status(200).json({ ok: true, total: rows.length, debug });

  } catch (err) {
    console.error('protheus-sync error:', err.message);
    return res.status(502).json({ error: err.message });
  }
}
