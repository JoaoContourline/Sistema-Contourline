// api/protheus.js — Vercel serverless function
// Busca CPF/CNPJ no Protheus em paralelo:
//   • Primeiras N_FIRST páginas (clientes antigos)
//   • Últimas páginas a partir do last_page salvo no Supabase (clientes novos)
// Tempo total ≈ duração de 1 página (~5-6s), independente de quantas páginas.

import https from 'https';
import { requireSectors, cors } from './_auth.js';

const agent   = new https.Agent({ rejectUnauthorized: false });
const N_FIRST = 12;   // primeiras páginas (clientes antigos)
const N_TAIL  = 6;    // páginas extras após last_page (novos ainda não no cache)
const PAGE_SZ = 20;

function fetchPage(base, auth, page) {
  const url = new URL(`${base}/api/crm/v1/customerVendor`);
  url.searchParams.set('pageSize', String(PAGE_SZ));
  url.searchParams.set('page',     String(page));

  return new Promise((resolve) => {
    const r = https.request({
      hostname: url.hostname,
      port:     url.port || 443,
      path:     url.pathname + url.search,
      method:   'GET',
      headers:  { Authorization: `Basic ${auth}`, Accept: 'application/json' },
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

function matchItem(item, digits) {
  const gov = item.GovernmentalInformation || item.governmentalInformation || [];
  return gov.some(g => String(g.id || '').replace(/\D/g, '') === digits);
}

async function getMeta(sbUrl, sbKey) {
  try {
    const r = await fetch(
      `${sbUrl}/rest/v1/protheus_sync_meta?id=eq.main&select=last_page,last_code`,
      { headers: { apikey: sbKey, Authorization: `Bearer ${sbKey}` } }
    );
    if (!r.ok) return { last_page: 0, last_code: '' };
    const rows = await r.json();
    return rows[0] || { last_page: 0, last_code: '' };
  } catch { return { last_page: 0, last_code: '' }; }
}

export default async function handler(req, res) {
  if (cors(req, res, 'GET, OPTIONS')) return;
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  // Busca cliente por CPF/CNPJ (PII) — restrito ao comercial/gestor.
  if (!await requireSectors(req, res, ['comercial', 'gestor', 'adm'])) return;

  const { cpfCnpj } = req.query;
  if (!cpfCnpj) return res.status(400).json({ error: 'Parâmetro cpfCnpj é obrigatório' });

  const digits = cpfCnpj.replace(/\D/g, '');
  if (digits.length < 11) return res.status(400).json({ error: 'CPF ou CNPJ inválido' });

  const base  = process.env.PROTHEUS_BASE;
  const user  = process.env.PROTHEUS_USER;
  const pass  = process.env.PROTHEUS_PASS;
  const sbUrl = process.env.SUPABASE_URL;
  const sbKey = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_SERVICE_KEY;

  if (!base || !user || !pass)
    return res.status(500).json({ error: 'Variáveis de ambiente do Protheus não configuradas' });

  const auth = Buffer.from(`${user}:${pass}`).toString('base64');

  // Descobre last_page e last_code do Supabase
  const meta     = (sbUrl && sbKey) ? await getMeta(sbUrl, sbKey) : { last_page: 0, last_code: '' };
  const lastPage = meta.last_page || 0;

  // Monta conjunto de páginas sem duplicatas:
  //   • 1..N_FIRST  → clientes antigos
  //   • (lastPage - 2)..(lastPage + N_TAIL) → clientes novos (após last_code)
  const pageSet = new Set();
  for (let p = 1; p <= N_FIRST; p++) pageSet.add(p);
  if (lastPage > 0) {
    const from = Math.max(N_FIRST + 1, lastPage - 2);
    for (let p = from; p <= lastPage + N_TAIL; p++) pageSet.add(p);
  }

  const pages = [...pageSet];
  // Não logar o CPF/CNPJ inteiro (PII em log retido) — só os 3 últimos dígitos.
  const digitsMask = digits.length > 3 ? '***' + digits.slice(-3) : '***';
  console.log(`Buscando ${digitsMask} em ${pages.length} páginas (last_page=${lastPage})`);

  try {
    const results  = await Promise.all(pages.map(p => fetchPage(base, auth, p)));
    const allItems = results.flatMap(d => d.items || []);
    const found    = allItems.find(item => matchItem(item, digits));

    return res.status(200).json({ items: found ? [found] : [] });
  } catch (err) {
    return res.status(502).json({ error: err.message });
  }
}
