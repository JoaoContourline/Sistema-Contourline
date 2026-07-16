// api/qrcode.js — Vercel serverless function
// Cadastra equipamentos no Sistema QR (Body Health Brasil) quando a logística
// aprova o despacho da NF. O QR vem do adesivo físico colado na máquina
// (op.pedidoVenda.equipamentos[].qrcode — origem: C6_XQRCODE do Protheus).
//
// API alvo: Cloudflare Worker https://www.bodyhealthbrasil.com/sistema-qr
// Doc: "API — Sistema QR" (16/07/2026)
//
// Env vars (definir também no painel da Vercel, não só no .env local):
//   QR_EMAIL — conta de serviço do portal (ex.: qr@contourline.com.br)
//   QR_SENHA — senha da conta
//
// Segurança: o login acontece AQUI, no servidor. As credenciais nunca vão ao
// browser — o front chama /api/qrcode e esta função cuida do resto.

import { requireAuth, cors } from './_auth.js';

const QR_BASE = 'https://www.bodyhealthbrasil.com/sistema-qr';

// O access_token expira em ~1h. Cacheado no escopo do módulo (reaproveitado
// entre invocações quentes). Renova 5 min antes de vencer + retry no 401.
let tokenCache = { value: null, exp: 0 };

async function qrLogin() {
  const email = process.env.QR_EMAIL;
  const senha = process.env.QR_SENHA;
  if (!email || !senha) throw new Error('Sistema QR não configurado (QR_EMAIL/QR_SENHA)');

  const resp = await fetch(`${QR_BASE}/api/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: senha }),
  });
  const json = await resp.json().catch(() => ({}));

  if (!resp.ok || !json.access_token) {
    if (json.error === 'profile_not_allowed') throw new Error(`Conta ${email} está com o perfil inativo no portal`);
    if (json.error === 'invalid_login')       throw new Error('E-mail ou senha do Sistema QR incorretos');
    throw new Error(json.error || `Falha no login do Sistema QR (HTTP ${resp.status})`);
  }
  // expires_at vem em segundos (Unix). Margem de 5 min.
  tokenCache = { value: json.access_token, exp: (json.expires_at * 1000) - 5 * 60 * 1000 };
  return tokenCache.value;
}

async function qrToken(force = false) {
  if (!force && tokenCache.value && Date.now() < tokenCache.exp) return tokenCache.value;
  return qrLogin();
}

/** Chamada autenticada. Renova o token e repete UMA vez se vier 401. */
async function qrFetch(path, opts = {}, isRetry = false) {
  const token = await qrToken();
  const resp = await fetch(`${QR_BASE}${path}`, {
    ...opts,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...(opts.headers || {}) },
  });
  if (resp.status === 401 && !isRetry) {
    await qrToken(true); // token morreu antes da margem → renova e tenta de novo
    return qrFetch(path, opts, true);
  }
  return resp;
}

/** Mesma normalização do Worker: espaços removidos, maiúsculas (hífen permanece). */
function normQr(qr) {
  return String(qr || '').replace(/\s+/g, '').toUpperCase();
}

/** Aceita YYYY-MM-DD ou DD/MM/YYYY; devolve YYYY-MM-DD (formato preferido da API). */
function normData(valor) {
  const v = String(valor || '').trim();
  if (!v) return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
  const br = v.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (br) return `${br[3]}-${br[2]}-${br[1]}`;
  return v;
}

/**
 * Grava um equipamento sem destruir histórico.
 * A doc é explícita: POST em QR existente SUBSTITUI o registro e descarta as
 * revisões. Por isso: consulta antes → 404 = cria (POST) · existe = atualiza (PUT).
 */
async function upsertEquipamento(item) {
  const qr = normQr(item.qr_code);
  if (!qr)                return { success: false, erro: 'qr_code vazio (adesivo não informado na OP)' };
  if (!item.numero_serie) return { success: false, qr_code: qr, erro: 'numero_serie é obrigatório' };
  if (!item.data_expedicao) return { success: false, qr_code: qr, erro: 'data_expedicao é obrigatória' };

  const corpo = {
    numero_serie:   String(item.numero_serie).trim(),
    modelo:         String(item.modelo || '').trim(),
    status:         item.status === 0 ? 0 : 1,
    data_expedicao: normData(item.data_expedicao),
  };
  // data_garantia omitida de propósito: a API calcula expedição + 1 ano.
  if (item.empresa)            corpo.empresa = item.empresa;
  if (item.pedido_producao)    corpo.pedido_producao = item.pedido_producao;
  if (item.contato_negociacao) corpo.contato_negociacao = item.contato_negociacao;

  const existe = await qrFetch(`/api/admin/equipamentos/${encodeURIComponent(qr)}`, { method: 'GET' });

  let resp, acao;
  if (existe.status === 404) {
    acao = 'criado';
    resp = await qrFetch('/api/admin/equipamentos', { method: 'POST', body: JSON.stringify({ qr_code: qr, ...corpo }) });
  } else if (existe.ok) {
    // PUT = merge parcial; preserva revisoes/created_at. qr_code é imutável (não enviar).
    acao = 'atualizado';
    resp = await qrFetch(`/api/admin/equipamentos/${encodeURIComponent(qr)}`, { method: 'PUT', body: JSON.stringify(corpo) });
  } else {
    const e = await existe.json().catch(() => ({}));
    return { success: false, qr_code: qr, erro: e.error || `Falha ao consultar (HTTP ${existe.status})` };
  }

  const json = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    return { success: false, qr_code: qr, erro: json.error || `Falha ao gravar (HTTP ${resp.status})` };
  }

  const eq = json.equipamento || {};
  return {
    success: true, qr_code: qr, acao,
    numero_serie: eq.numero_serie, modelo: eq.modelo,
    data_expedicao: eq.data_expedicao, data_garantia: eq.data_garantia,
  };
}

export default async function handler(req, res) {
  if (cors(req, res, 'POST, OPTIONS')) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  // Escreve no sistema do parceiro com a identidade da Contourline: sem sessão,
  // qualquer um sobrescrevia equipamento real (eu mesmo provei isso hoje).
  if (!await requireAuth(req, res)) return;

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }

  const itens = Array.isArray(body?.equipamentos) ? body.equipamentos : [];
  if (!itens.length) return res.status(400).json({ error: 'Nenhum equipamento informado' });
  if (itens.length > 50) return res.status(400).json({ error: 'Máximo de 50 equipamentos por requisição' });

  const resultados = [];
  try {
    // Sequencial de propósito: 1 login para todos (a doc pede para reaproveitar
    // o token) e o volume é baixo — poucas máquinas por despacho.
    for (const item of itens) {
      try {
        resultados.push(await upsertEquipamento(item || {}));
      } catch (err) {
        resultados.push({ success: false, qr_code: normQr(item?.qr_code), erro: err.message });
      }
    }
  } catch (err) {
    return res.status(502).json({ error: err.message });
  }

  const ok = resultados.filter(r => r.success).length;
  return res.status(ok === resultados.length ? 200 : 207).json({
    success: ok === resultados.length,
    total: resultados.length,
    gravados: ok,
    com_erro: resultados.length - ok,
    resultados,
  });
}
