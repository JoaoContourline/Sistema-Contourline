#!/usr/bin/env node
// scripts/sync-protheus.js — CommonJS, roda direto com node
// Sincroniza TODOS os clientes do Protheus → Supabase (sem limite de tempo)
//
// Env vars: PROTHEUS_BASE, PROTHEUS_USER, PROTHEUS_PASS, SUPABASE_URL, SUPABASE_SERVICE_KEY

'use strict';
const https = require('https');

const BASE   = process.env.PROTHEUS_BASE;
const USER   = process.env.PROTHEUS_USER;
const PASS   = process.env.PROTHEUS_PASS;
const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_KEY;

if (!BASE || !USER || !PASS || !SB_URL || !SB_KEY) {
  console.error('Variaveis de ambiente faltando:');
  ['PROTHEUS_BASE','PROTHEUS_USER','PROTHEUS_PASS','SUPABASE_URL','SUPABASE_SERVICE_KEY']
    .filter(k => !process.env[k]).forEach(k => console.error('  ' + k));
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
        catch (e) { reject(new Error(`JSON invalido p${page}: ${body.substring(0, 80)}`)); }
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
    nome: (item.name || item.shortName || '').trim(),
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
  if (!r.ok) {
    const txt = await r.text();
    throw new Error(`Supabase ${r.status}: ${txt}`);
  }
}

async function main() {
  const t0 = Date.now();
  console.log('Iniciando sync Protheus -> Supabase...');

  let page = 1, total = 0, synced = 0, hasMore = true;

  while (hasMore) {
    const pt = Date.now();
    let data;
    try {
      data = await fetchPage(page);
    } catch (e) {
      console.error(`  Pagina ${page} falhou: ${e.message}`);
      break;
    }

    const items = data.items || [];
    total += items.length;

    // Deduplica por cpf_digits (Protheus pode ter duplicatas)
    const seen = new Set();
    const rows = items.map(compact).filter(Boolean).filter(r => {
      if (seen.has(r.cpf_digits)) return false;
      seen.add(r.cpf_digits);
      return true;
    });
    if (rows.length) {
      await upsertBatch(rows);
      synced += rows.length;
    }

    const s = ((Date.now() - pt) / 1000).toFixed(1);
    console.log(`  Pag ${String(page).padStart(3)} | ${items.length} registros | ${rows.length} com CPF | ${s}s`);

    hasMore = data.hasNext === true && items.length >= PAGE_SZ;
    page++;
  }

  const total_s = ((Date.now() - t0) / 1000).toFixed(0);
  console.log(`\nSync concluido em ${total_s}s — total: ${total} | sincronizados: ${synced}`);
}

main().catch(e => { console.error('Erro fatal:', e.message); process.exit(1); });
