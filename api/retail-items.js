// api/retail-items.js — Todos os itens ativos do Protheus para o seletor de Nova OP
// Busca todas as páginas em paralelo (lotes de 5) — sem filtro de productType
// Cache-Control 4h no Vercel CDN
//
// Env vars: PROTHEUS_BASE, PROTHEUS_USER, PROTHEUS_PASS

import https from 'node:https';
import { requireSectors, cors } from './_auth.js';

const agent = new https.Agent({ rejectUnauthorized: false });
const PAGE_SIZE = 500;

function fetchPage(base, auth, page) {
  const url = new URL(`${base}/api/retail/v1/retailItem`);
  url.searchParams.set('pageSize', String(PAGE_SIZE));
  url.searchParams.set('page',     String(page));

  return new Promise((resolve) => {
    const r = https.request(
      {
        hostname: url.hostname,
        port:     url.port || 443,
        path:     url.pathname + url.search,
        method:   'GET',
        headers:  { Authorization: `Basic ${auth}`, Accept: 'application/json' },
        agent,
        timeout:  15000,
      },
      (resp) => {
        let body = '';
        resp.on('data', chunk => { body += chunk; });
        resp.on('end', () => {
          try   { resolve(JSON.parse(body)); }
          catch { resolve({ items: [], hasNext: false }); }
        });
      }
    );
    r.on('error',   () => resolve({ items: [], hasNext: false }));
    r.on('timeout', () => { r.destroy(); resolve({ items: [], hasNext: false }); });
    r.end();
  });
}

export default async function handler(req, res) {
  if (cors(req, res, 'GET, OPTIONS')) return;
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  // Catálogo de produtos (usado na criação da OP) = informação comercial.
  if (!await requireSectors(req, res, ['comercial', 'gestor'])) return;

  const base = process.env.PROTHEUS_BASE;
  const user = process.env.PROTHEUS_USER;
  const pass = process.env.PROTHEUS_PASS;
  if (!base || !user || !pass)
    return res.status(500).json({ error: 'Env vars não configuradas (PROTHEUS_BASE/USER/PASS)' });

  const auth      = Buffer.from(`${user}:${pass}`).toString('base64');
  const BATCH_SZ  = 5; // páginas por rodada paralela

  try {
    const allRaw = [];
    let nextPage = 1;
    let hasMore  = true;

    while (hasMore) {
      const batch = await Promise.all(
        Array.from({ length: BATCH_SZ }, (_, i) => fetchPage(base, auth, nextPage + i))
      );

      for (const data of batch) {
        const items = data.items || [];
        allRaw.push(...items);
        if (!data.hasNext || items.length < PAGE_SIZE) {
          hasMore = false;
          break;
        }
      }
      nextPage += BATCH_SZ;
    }

    const items = allRaw
      .filter(i => i.Active?.trim() === 'S' && i.Code?.trim() && i.Description?.trim())
      .map(i => ({
        code: i.Code.trim(),
        name: i.Description.trim(),
        // AddressingControl='S' (B1_LOCALIZ) → endereça por série
        // Trail='L' (B1_RASTRO)              → controla por lote
        // ambos 'N'                           → sem rastreio
        tracking: i.AddressingControl?.trim() === 'S' ? 'serie'
                : i.Trail?.trim()           === 'L' ? 'lote'
                : null,
      }))
      .sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));

    res.setHeader('Cache-Control', 'public, max-age=14400, stale-while-revalidate=3600');
    return res.status(200).json({ items, total: items.length });

  } catch (err) {
    console.error('retail-items error:', err.message);
    return res.status(502).json({ error: err.message });
  }
}
