// api/cliente.js — Vercel serverless function
// Busca UM cliente no Protheus (CRM customerVendor) pelo CÓDIGO e devolve o
// registro cru — mesmo formato que o front já sabe ler (fillClientFromProtheus).
// Usado após "Puxar Pedido": o pedido dá o código do cliente, aqui buscamos
// CPF/CNPJ, endereço, telefone, e-mail, etc.
//
// Env vars (mesma base do pedido):
//   PEDIDOS_BASE  — ex.: https://contourline200013.protheus.cloudtotvs.com.br:10573/rest
//   PEDIDOS_USER  — usuário do Protheus (fallback: PROTHEUS_USER)
//   PEDIDOS_PASS  — senha do Protheus   (fallback: PROTHEUS_PASS)

import https from 'node:https';
import { requireSectors, cors } from './_auth.js';

const agent = new https.Agent({ rejectUnauthorized: false });

function fetchByCode(base, auth, code) {
  const url = new URL(`${base}/api/crm/v1/customerVendor`);
  url.searchParams.set('code', code);

  return new Promise((resolve, reject) => {
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
          catch { reject(new Error('Resposta inválida do Protheus')); }
        });
      }
    );
    r.on('error',   err => reject(err));
    r.on('timeout', () => { r.destroy(); reject(new Error('Tempo esgotado ao consultar o Protheus')); });
    r.end();
  });
}

export default async function handler(req, res) {
  if (cors(req, res, 'GET, OPTIONS')) return;
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  // Dado pessoal de cliente: só quem cadastra/consulta comercialmente.
  if (!await requireSectors(req, res, ['comercial', 'gestor', 'adm'])) return;

  const code = String(req.query.code || '').trim();
  const loja = String(req.query.loja || '').trim();
  if (!code) return res.status(400).json({ error: 'Parâmetro "code" é obrigatório' });

  const base = process.env.PEDIDOS_BASE;
  const user = process.env.PEDIDOS_USER || process.env.PROTHEUS_USER;
  const pass = process.env.PEDIDOS_PASS || process.env.PROTHEUS_PASS;
  if (!base || !user || !pass)
    return res.status(500).json({ error: 'Serviço não configurado (PEDIDOS_BASE/USER/PASS)' });

  const auth = Buffer.from(`${user}:${pass}`).toString('base64');

  let json;
  try {
    json = await fetchByCode(base, auth, code);
  } catch (err) {
    return res.status(502).json({ error: err.message });
  }

  // customerVendor devolve { items: [...] } — o mesmo código pode trazer o
  // CLIENTE (type 1) e o FORNECEDOR (type 2). Aqui queremos o cliente.
  const items = Array.isArray(json.items) ? json.items
              : Array.isArray(json.data)  ? json.data
              : (json && (json.name || json.shortName)) ? [json] : [];

  const clientes = items.filter(i => i.type === 1 || i.type === '1');
  const pool = clientes.length ? clientes : items;

  let item = pool[0] || null;
  if (loja && pool.length > 1) {
    const byStore = pool.find(i => String(i.storeId || i.store || '').trim() === loja);
    if (byStore) item = byStore;
  }

  if (!item) return res.status(404).json({ error: `Cliente ${code} não encontrado` });
  return res.status(200).json(item);
}
