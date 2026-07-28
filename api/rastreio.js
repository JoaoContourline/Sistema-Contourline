// api/rastreio.js — Vercel serverless function
// Rastreio de cargas por transportadora. Hoje: Azul Cargo (Integração Fácil / EDI v2).
// Arquitetura de ADAPTADORES: cada transportadora só traduz sua resposta para o
// formato normalizado abaixo. O front (index.html) nunca muda ao entrar outra.
//
// Formato normalizado devolvido ao front:
//   { transportadora, codigo, awb, previsao, dataEntrega, entregue, insucesso,
//     destino, statusLabel, pod, eventos: [{ ts, codigo, descricao, local, lat, lng, urlPod, urlInsucesso }] }
//
// Env vars (defina também no painel da Vercel, não só no .env local):
//   EMAIL_AZUL             — e-mail de acesso do Integração Fácil (Azul)
//   SENHA_AZUL             — senha de acesso (recebida no e-mail de cadastro)
//   RASTREIO_AZUL_AMBIENTE — 'prod' | 'homolog' (default: 'homolog')

import { requireAuth, cors } from './_auth.js';

const AZUL_BASE = {
  homolog: 'https://hmg.onlineapp.com.br/EDIv2_API_INTEGRACAO_Toolkit',
  prod:    'https://ediapi.onlineapp.com.br/toolkit',
};

// Token da Azul vale 8h — cacheado no escopo do módulo (reaproveitado entre
// invocações "quentes" do Fluid Compute). Renova a cada 7h por segurança.
let azulToken = { value: null, exp: 0 };

function azulBase() {
  const amb = (process.env.RASTREIO_AZUL_AMBIENTE || 'homolog').toLowerCase();
  return AZUL_BASE[amb] || AZUL_BASE.homolog;
}

async function azulAuth() {
  const email = process.env.EMAIL_AZUL;
  const senha = process.env.SENHA_AZUL;
  if (!email || !senha) throw new Error('Credenciais Azul não configuradas (EMAIL_AZUL/SENHA_AZUL)');

  const resp = await fetch(`${azulBase()}/api/Autenticacao/AutenticarUsuario`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body:    JSON.stringify({ Email: email, Senha: senha }),
  });
  const json = await resp.json().catch(() => ({}));
  if (!resp.ok || json.HasErrors || !json.Value) {
    throw new Error(json.ErrorText || `Falha na autenticação Azul (HTTP ${resp.status})`);
  }
  azulToken = { value: json.Value, exp: Date.now() + 7 * 60 * 60 * 1000 };
  return azulToken.value;
}

async function azulGetToken(force = false) {
  if (!force && azulToken.value && Date.now() < azulToken.exp) return azulToken.value;
  return azulAuth();
}

async function azulConsultar({ chaveNfe, awb, pedido }, isRetry = false) {
  const token = await azulGetToken();
  const body = { Token: token };
  if (chaveNfe) body.ChaveNfe = chaveNfe;
  if (awb)      body.Awb      = awb;
  if (pedido)   body.Pedido   = pedido;

  const resp = await fetch(`${azulBase()}/api/Rastreio/Consultar`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body:    JSON.stringify(body),
  });
  const json = await resp.json().catch(() => ({}));

  // Token expirado/inválido → renova uma vez e tenta de novo
  if ((resp.status === 401 || /token/i.test(json.ErrorText || '')) && !isRetry) {
    await azulGetToken(true);
    return azulConsultar({ chaveNfe, awb, pedido }, true);
  }
  if (!resp.ok || json.HasErrors) {
    throw new Error(json.ErrorText || `Falha ao consultar rastreio Azul (HTTP ${resp.status})`);
  }
  return Array.isArray(json.Value) ? json.Value : [];
}

function azulNormalize(value, codigoConsulta) {
  const carga = value[0];
  if (!carga) return null;

  const occ = Array.isArray(carga.Ocorrencias) ? [...carga.Ocorrencias] : [];
  // Ordena por data/hora crescente
  occ.sort((a, b) => new Date(a.DataHora || 0) - new Date(b.DataHora || 0));

  const eventos = occ.map(o => ({
    ts:          o.DataHora || null,
    codigo:      o.Codigo || '',
    descricao:   o.Descricao || o.Comentario || '',
    local:       [o.UnidadeMunicipio, o.UnidadeUf].filter(Boolean).join('/'),
    lat:         o.Latitude || null,
    lng:         o.Longitude || null,
    urlPod:      o.UrlPOD || o.UrlAssinatura || null,
    urlInsucesso:o.UrlInsucesso || null,
  }));

  const ultimo = eventos[eventos.length - 1] || {};
  const podEvt = [...eventos].reverse().find(e => e.urlPod);

  return {
    transportadora:   'azul',
    codigo:           codigoConsulta,
    awb:              carga.Awb || carga.NumeroOperacional || null,
    previsao:         carga.DataEntregaPrevisao || null,
    emissao:          carga.DataHoraEmissao || null,
    dataEntrega:      carga.DataHoraEntrega || null,
    entregue:         !!carga.DataHoraEntrega,
    insucesso:        !!ultimo.urlInsucesso,
    destino:          [carga.DestinoCidade, carga.DestinoUnidade].filter(Boolean).join(' · '),
    statusLabel:      ultimo.descricao || '—',
    local:            ultimo.local || '',
    pod:              podEvt?.urlPod || null,
    eventos,
    fetchedAt:        new Date().toISOString(),
  };
}

// ─── Rotta Master ───────────────────────────────────────────────────────────

async function rottaConsultar({ cnpj, numeroNF }) {
  const url = `https://suatransportadora.com.br/e/rottamasterst.php?t=${Date.now()}&cnpj=${encodeURIComponent(cnpj)}&nota=${encodeURIComponent(numeroNF)}`;
  const resp = await fetch(url, { headers: { Accept: 'application/json' } });
  const json = await resp.json().catch(() => ({}));
  if (!resp.ok || json.status !== 1) {
    throw new Error(json.message || `Falha ao consultar Rotta Master (HTTP ${resp.status})`);
  }
  return json.data?.[0] || null;
}

function rottaNormalize(data, cnpj, numeroNF) {
  if (!data) return null;

  const todos = Array.isArray(data.dados) ? data.dados : [];
  const eventos = todos
    .filter(e => !/previs[ãa]o de entrega/i.test(e.descricao || ''))
    .map(e => ({
      ts:           e.data || null,
      codigo:       '',
      descricao:    e.descricao || '',
      local:        '',
      lat:          null,
      lng:          null,
      urlPod:       null,
      urlInsucesso: null,
    }));

  const ultimo   = eventos[eventos.length - 1] || {};
  const entregue = !!data.comprovante || /\bentregue\b/i.test(ultimo.descricao || '');

  let previsao = null;
  if (data.prev_entrega) {
    const [d, m, y] = data.prev_entrega.split('/');
    if (y && m && d) previsao = `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
  }

  return {
    transportadora: 'rotta',
    codigo:         numeroNF,
    awb:            null,
    previsao,
    emissao:        eventos[0]?.ts || null,
    dataEntrega:    entregue ? (ultimo.ts || null) : null,
    entregue,
    insucesso:      false,
    destino:        '',
    statusLabel:    ultimo.descricao || '—',
    local:          '',
    pod:            data.comprovante || null,
    eventos,
    fetchedAt:      new Date().toISOString(),
  };
}

// ─── Registry de adaptadores ─────────────────────────────────────────────────
// Adicionar transportadora nova = uma entrada aqui

const CARRIERS = {
  async azul(codigos) {
    const value = await azulConsultar(codigos);
    return azulNormalize(value, codigos.chaveNfe || codigos.awb || codigos.pedido);
  },
  async rotta(codigos) {
    const data = await rottaConsultar(codigos);
    return rottaNormalize(data, codigos.cnpj, codigos.numeroNF);
  },
};

export default async function handler(req, res) {
  if (cors(req, res, 'POST, OPTIONS')) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!await requireAuth(req, res)) return;

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  const { transportadora, chaveNfe, awb, pedido, cnpj, numeroNF } = body || {};

  const transp  = String(transportadora || '').toLowerCase();
  const carrier = CARRIERS[transp];
  if (!carrier) {
    return res.status(400).json({ error: `Transportadora "${transportadora}" sem integração de rastreio` });
  }

  if (transp === 'rotta') {
    if (!cnpj || !numeroNF) return res.status(400).json({ error: 'Informe cnpj e numeroNF para Rotta Master' });
  } else {
    if (!chaveNfe && !awb && !pedido && !numeroNF) return res.status(400).json({ error: 'Informe chaveNfe, awb, pedido ou numeroNF' });
  }

  try {
    const dados = await carrier({ chaveNfe, awb, pedido: pedido || numeroNF, cnpj, numeroNF });
    if (!dados) return res.status(404).json({ error: 'Nenhum rastreio encontrado para este código' });
    return res.status(200).json(dados);
  } catch (err) {
    return res.status(502).json({ error: err.message });
  }
}
