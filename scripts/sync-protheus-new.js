#!/usr/bin/env node
// scripts/sync-protheus-new.js — CommonJS, roda direto com node
// Sync INCREMENTAL: busca do Supabase o maior código Protheus salvo,
// depois varre as últimas páginas do Protheus e adiciona só os códigos maiores.
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

const agent  = new https.Agent({ rejectUnauthorized: false });
const AUTH   = Buffer.from(`${USER}:${PASS}`).toString('base64');
const PAGE_SZ = 20;
const LOOKBACK = 3; // páginas antes do last_page para margem de segurança

// Compara códigos Protheus (zero-padded strings ou numéricos)
function codeGt(a, b) {
  if (!a) return false;
  if (!b) return true; // qualquer código > vazio
  const na = parseInt(a, 10), nb = parseInt(b, 10);
  if (!isNaN(na) && !isNaN(nb)) return na > nb;
  return a > b;
}

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

  const code = (item.code || item.id || '').trim();
  const addr = item.address || {};
  const comm = (item.listOfCommunicationInformation || [])[0] || {};
  const rg   = gov.find(g => g.name === 'RG');

  return {
    cpf_digits:    digits,
    nome:          (item.name || item.shortName || '').trim(),
    protheus_code: code,
    dados: {
      code,
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

async function getMeta() {
  const r = await fetch(`${SB_URL}/rest/v1/protheus_sync_meta?id=eq.main`, {
    headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` },
  });
  if (!r.ok) return { last_page: 1, last_code: '', total_customers: 0 };
  const rows = await r.json();
  return rows[0] || { last_page: 1, last_code: '', total_customers: 0 };
}

async function saveMeta(lastPage, lastCode, totalCustomers) {
  const r = await fetch(`${SB_URL}/rest/v1/protheus_sync_meta?id=eq.main`, {
    method:  'PATCH',
    headers: {
      apikey:         SB_KEY,
      Authorization:  `Bearer ${SB_KEY}`,
      'Content-Type': 'application/json',
      Prefer:         'return=minimal',
    },
    body: JSON.stringify({
      last_page:       lastPage,
      last_code:       lastCode,
      total_customers: totalCustomers,
      updated_at:      new Date().toISOString(),
    }),
  });
  if (!r.ok) console.warn('Aviso: nao foi possivel salvar metadata:', r.status);
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
  console.log('Iniciando sync INCREMENTAL Protheus -> Supabase...');

  // 1. Busca metadata: last_page e last_code (maior código já salvo)
  const meta     = await getMeta();
  const lastCode = meta.last_code || '';
  const startPage = Math.max(1, (meta.last_page || 1) - LOOKBACK);

  console.log(`Ultimo codigo salvo: "${lastCode || '(nenhum)'}" | Buscando a partir da pagina: ${startPage}`);

  // 2. Varre páginas a partir de startPage até o fim do Protheus
  let page = startPage, hasMore = true;
  let lastPageReached = startPage, newMaxCode = lastCode;
  const seenLocal = new Set();
  const newRows   = [];

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
    let novosNaPagina = 0;

    for (const item of items) {
      const row = compact(item);
      if (!row || seenLocal.has(row.cpf_digits)) continue;
      seenLocal.add(row.cpf_digits);

      // Só adiciona se o código for maior que o último salvo
      if (codeGt(row.protheus_code, lastCode)) {
        newRows.push(row);
        novosNaPagina++;
        // Atualiza o maior código visto
        if (codeGt(row.protheus_code, newMaxCode)) newMaxCode = row.protheus_code;
      }
    }

    const s = ((Date.now() - pt) / 1000).toFixed(1);
    console.log(`  Pag ${String(page).padStart(3)} | ${items.length} itens | ${novosNaPagina} novos | ${s}s`);

    lastPageReached = page;
    hasMore = data.hasNext === true && items.length >= PAGE_SZ;
    page++;
  }

  console.log(`\nEncontrados ${newRows.length} clientes novos (codigo > "${lastCode}")`);

  // 3. Upsert em batches de 50
  const BATCH = 50;
  let inseridos = 0;
  for (let i = 0; i < newRows.length; i += BATCH) {
    const chunk = newRows.slice(i, i + BATCH);
    await upsertBatch(chunk);
    inseridos += chunk.length;
    console.log(`  Inseridos ${inseridos}/${newRows.length}...`);
  }

  // 4. Salva metadata atualizado
  const novoTotal = (meta.total_customers || 0) + inseridos;
  await saveMeta(lastPageReached, newMaxCode, novoTotal);

  const total_s = ((Date.now() - t0) / 1000).toFixed(0);
  console.log(`\nSync incremental concluido em ${total_s}s`);
  console.log(`  Novos inseridos: ${inseridos} | Total estimado: ${novoTotal} | Ultimo codigo: ${newMaxCode}`);
}

main().catch(e => { console.error('Erro fatal:', e.message); process.exit(1); });
