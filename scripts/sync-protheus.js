#!/usr/bin/env node
// scripts/sync-protheus.js
// Sincroniza TODOS os clientes do Protheus → Supabase
// Sem limite de tempo — roda via GitHub Actions ou localmente
// Usage: node scripts/sync-protheus.js
//
// Env vars: PROTHEUS_BASE, PROTHEUS_USER, PROTHEUS_PASS, SUPABASE_URL, SUPABASE_SERVICE_KEY

import https from 'https';
import { performance } from 'perf_hooks';

const BASE     = process.env.PROTHEUS_BASE;
const USER     = process.env.PROTHEUS_USER;
const PASS     = process.env.PROTHEUS_PASS;
const SB_URL   = process.env.SUPABASE_URL;
const SB_KEY   = process.env.SUPABASE_SERVICE_KEY;

if (!BASE || !USER || !PASS || !SB_URL || !SB_KEY) {
  console.error('❌ Variáveis de ambiente faltando:');
  if (!BASE)   console.error('  PROTHEUS_BASE');
  if (!USER)   console.error('  PROTHEUS_USER');
  if (!PASS)   console.error('  PROTHEUS_PASS');
  if (!SB_URL) console.error('  SUPABASE_URL');
  if (!SB_KEY) console.error('  SUPABASE_SERVICE_KEY');
  process.exit(1);
}

const agent = new https.Agent({ rejectUnauthorized: false });
const AUTH  = Buffer.from(`${USER}:${PASS}`).toString('base64');
const PAGE_SZ = 20;

function fetchPage(page) {
  const url = new URL(`${BASE}/api/crm/v1/customerVendor`);
  url.searchParams.set('pageSize', String(PAGE_SZ));
  url.searchParams.set('page',     String(page));

  return new Promise((resolve, reject) => {
    const r = https.request({
      hostname: url.hostname,
      port:     url.port || 443,
      path:     url.pathname + url.search,
      method:   'GET',
      headers:  { Authorization: `Basic ${AUTH}`, Accept: 'application/json' },
      agent,
      timeout:  15000,
    }, (resp) => {
      let body = '';
      resp.on('data', c => body += c);
      resp.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch { reject(new Error(`JSON inválido p${page}: ${body.substring(0, 80)}`)); }
      });
    });
    r.on('error',   reject);
    r.on('timeout', () => { r.destroy(); reject(new Error(`timeout p${page}`)); });
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

async function upsertBatch(rows) {
  const r = await fetch(`${SB_URL}/rest/v1/protheus_clientes`, {
    method:  'POST',
    headers: {
      apikey:         SB_KEY,
      Authorization:  `Bearer ${SB_KEY}`,
      'Content-Type': 'application/json',
      Prefer:         'resolution=merge-duplicates',
    },
    body: JSON.stringify(rows),
  });
  if (!r.ok) throw new Error(`Supabase ${r.status}: ${await r.text()}`);
}

async function main() {
  const t0 = performance.now();
  console.log('🔄 Iniciando sync Protheus → Supabase...');
  console.log(`   Endpoint: ${BASE}/api/crm/v1/customerVendor`);
  console.log(`   pageSize: ${PAGE_SZ}\n`);

  let page    = 1;
  let total   = 0;
  let synced  = 0;
  let hasMore = true;

  while (hasMore) {
    const pt = performance.now();
    let data;
    try {
      data = await fetchPage(page);
    } catch (e) {
      console.error(`  ❌ Página ${page} falhou: ${e.message}`);
      break;
    }

    const items = data.items || [];
    total += items.length;

    const rows = items.map(compact).filter(Boolean);
    if (rows.length) {
      await upsertBatch(rows);
      synced += rows.length;
    }

    const elapsed = ((performance.now() - pt) / 1000).toFixed(1);
    process.stdout.write(`  📄 Pág ${String(page).padStart(3)} | ${items.length} registros | ${rows.length} com CPF | ${elapsed}s\n`);

    hasMore = data.hasNext === true && items.length >= PAGE_SZ;
    page++;
  }

  const total_s = ((performance.now() - t0) / 1000).toFixed(0);
  console.log(`\n✅ Sync concluído em ${total_s}s`);
  console.log(`   Total bruto:    ${total}`);
  console.log(`   Sincronizados:  ${synced}`);
}

main().catch(e => { console.error('❌ Erro fatal:', e.message); process.exit(1); });
