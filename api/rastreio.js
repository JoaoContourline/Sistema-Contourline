// api/rastreio.js — Vercel serverless function
// Rastreio de cargas por transportadora.
// Arquitetura de ADAPTADORES: cada transportadora só traduz sua resposta para o
// formato normalizado abaixo. O front (index.html) nunca muda ao entrar outra.
//
// Formato normalizado devolvido ao front:
//   { transportadora, codigo, awb, previsao, dataEntrega, entregue, insucesso,
//     destino, statusLabel, pod, eventos: [{ ts, codigo, descricao, local, lat, lng, urlPod, urlInsucesso }] }
//
// Env vars (defina também no painel da Vercel, não só no .env local):
//   EMAIL_AZUL              — e-mail de acesso do Integração Fácil (Azul)
//   SENHA_AZUL              — senha de acesso (recebida no e-mail de cadastro)
//   RASTREIO_AZUL_AMBIENTE  — 'prod' | 'homolog' (default: 'homolog')
//   LOGGICA_USUARIO         — usuário (hash) do portal Brudam/Loggica
//   LOGGICA_SENHA           — senha do portal Brudam/Loggica
//   CORREIOS_COD_ACESSO     — código de acesso cws-ch1_... (Bearer direto, gerado no CWS)
//   JAMEF_USERNAME          — e-mail de acesso do portal Jamef
//   JAMEF_PASSWORD          — senha do portal Jamef
//   JAMEF_AMBIENTE          — 'prod' | 'qa' (default: 'qa')

import { requireAuth, cors } from './_auth.js';

// ─── Azul Cargo ─────────────────────────────────────────────────────────────

const AZUL_BASE = {
  homolog: 'https://hmg.onlineapp.com.br/EDIv2_API_INTEGRACAO_Toolkit',
  prod:    'https://ediapi.onlineapp.com.br/toolkit',
};

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
  occ.sort((a, b) => new Date(a.DataHora || 0) - new Date(b.DataHora || 0));

  const eventos = occ.map(o => ({
    ts:           o.DataHora || null,
    codigo:       o.Codigo || '',
    descricao:    o.Descricao || o.Comentario || '',
    local:        [o.UnidadeMunicipio, o.UnidadeUf].filter(Boolean).join('/'),
    lat:          o.Latitude || null,
    lng:          o.Longitude || null,
    urlPod:       o.UrlPOD || o.UrlAssinatura || null,
    urlInsucesso: o.UrlInsucesso || null,
  }));

  const ultimo  = eventos[eventos.length - 1] || {};
  const podEvt  = [...eventos].reverse().find(e => e.urlPod);

  return {
    transportadora: 'azul',
    codigo:         codigoConsulta,
    awb:            carga.Awb || carga.NumeroOperacional || null,
    previsao:       carga.DataEntregaPrevisao || null,
    emissao:        carga.DataHoraEmissao || null,
    dataEntrega:    carga.DataHoraEntrega || null,
    entregue:       !!carga.DataHoraEntrega,
    insucesso:      !!ultimo.urlInsucesso,
    destino:        [carga.DestinoCidade, carga.DestinoUnidade].filter(Boolean).join(' · '),
    statusLabel:    ultimo.descricao || '—',
    local:          ultimo.local || '',
    pod:            podEvt?.urlPod || null,
    eventos,
    fetchedAt:      new Date().toISOString(),
  };
}

// ─── Rotta Master ────────────────────────────────────────────────────────────

async function rottaConsultar({ cnpj, numeroNF }) {
  const url = `https://suatransportadora.com.br/e/rottamasterst.php?t=${Date.now()}&cnpj=${encodeURIComponent(cnpj)}&nota=${encodeURIComponent(numeroNF)}`;
  const resp = await fetch(url, { headers: { Accept: 'application/json' } });
  const json = await resp.json().catch(() => ({}));
  if (!resp.ok || json.status !== 1) {
    throw new Error(json.message || `Falha ao consultar Rotta Master (HTTP ${resp.status})`);
  }
  return json.data?.[0] || null;
}

function rottaParseEvento(e) {
  const raw = e.descricao || '';
  if (!raw.includes('<')) return { descricao: raw, urlPod: null };
  const hrefMatch = raw.match(/href=['"]([^'"]+)['"]/);
  const urlPod    = hrefMatch ? hrefMatch[1] : null;
  const textMatch = raw.match(/>([^<]+)</);
  const descricao = textMatch ? textMatch[1].trim() : 'Entregue';
  return { descricao, urlPod };
}

function rottaNormalize(data, cnpj, numeroNF) {
  if (!data) return null;

  const todos = Array.isArray(data.dados) ? data.dados : [];
  const eventos = todos
    .filter(e => !/previs[ãa]o de entrega/i.test(e.descricao || ''))
    .map(e => {
      const { descricao, urlPod } = rottaParseEvento(e);
      return { ts: e.data || null, codigo: '', descricao, local: '', lat: null, lng: null, urlPod, urlInsucesso: null };
    });

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

// ─── Loggica (Brudam) ────────────────────────────────────────────────────────
// Auth: POST /api/v1/acesso/auth/login → data.access_key (JWT, ~1h)
// Rastreio: GET /api/v1/tracking/ocorrencias/tracking/ocorrencias/nfe?chave={44dígitos}
//           header: authorization: {token}  (sem "Bearer" — peculiaridade da API)

let loggicaToken = { value: null, exp: 0 };

async function loggicaAuth() {
  const usuario = process.env.LOGGICA_USUARIO;
  const senha   = process.env.LOGGICA_SENHA;
  if (!usuario || !senha) throw new Error('Credenciais Loggica não configuradas (LOGGICA_USUARIO/LOGGICA_SENHA)');

  const resp = await fetch('https://loggica.brudam.com.br/api/v1/acesso/auth/login', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body:    JSON.stringify({ usuario, senha }),
  });
  const json = await resp.json().catch(() => ({}));
  if (!resp.ok || !json.data?.access_key) {
    throw new Error(json.message || `Falha na autenticação Loggica (HTTP ${resp.status})`);
  }
  loggicaToken = { value: json.data.access_key, exp: Date.now() + 50 * 60 * 1000 };
  return loggicaToken.value;
}

async function loggicaGetToken(force = false) {
  if (!force && loggicaToken.value && Date.now() < loggicaToken.exp) return loggicaToken.value;
  return loggicaAuth();
}

async function loggicaConsultar({ chaveNfe }, isRetry = false) {
  if (!chaveNfe) throw new Error('Chave NF-e (44 dígitos) obrigatória para rastreio Loggica');
  if (!/^\d{44}$/.test(chaveNfe.replace(/\D/g, ''))) throw new Error('Chave NF-e inválida — deve ter exatamente 44 dígitos');

  const token = await loggicaGetToken();
  const chave = chaveNfe.replace(/\D/g, '');
  const resp = await fetch(
    `https://loggica.brudam.com.br/api/v1/tracking/ocorrencias/tracking/ocorrencias/nfe?chave=${encodeURIComponent(chave)}`,
    { headers: { authorization: token, Accept: 'application/json' } },
  );
  const json = await resp.json().catch(() => ({}));

  if ((resp.status === 401 || /token inv/i.test(json.message || '')) && !isRetry) {
    await loggicaGetToken(true);
    return loggicaConsultar({ chaveNfe }, true);
  }
  if (!resp.ok) throw new Error(json.message || `Falha ao consultar rastreio Loggica (HTTP ${resp.status})`);
  return json;
}

function loggicaNormalize(data, chaveNfe) {
  if (!data) return null;
  // A Brudam retorna array direto ou objeto com campo de eventos
  const raw = Array.isArray(data) ? data : (data.data || data.ocorrencias || []);
  if (!raw.length) return null;

  const eventos = raw.map(o => ({
    ts:           o.dt_ocorrencia || o.dataHora || o.data || null,
    codigo:       String(o.cd_ocorrencia || o.codigo || ''),
    descricao:    o.ds_ocorrencia || o.descricao || '',
    local:        o.ds_municipio ? `${o.ds_municipio}/${o.sg_uf || ''}`.trim().replace(/\/$/, '') : '',
    lat:          null,
    lng:          null,
    urlPod:       o.url_comprovante || o.urlComprovante || null,
    urlInsucesso: null,
  }));
  eventos.sort((a, b) => new Date(a.ts || 0) - new Date(b.ts || 0));

  const ultimo  = eventos[eventos.length - 1] || {};
  const entregue = /entregue|delivery confirm/i.test(ultimo.descricao || '');
  const insucesso = /insucess|recusa|tentativa falh/i.test(ultimo.descricao || '');

  const meta = Array.isArray(data) ? {} : data;
  return {
    transportadora: 'loggica',
    codigo:         chaveNfe,
    awb:            meta.nr_cte || meta.awb || null,
    previsao:       meta.dt_previsao || null,
    emissao:        eventos[0]?.ts || null,
    dataEntrega:    entregue ? (ultimo.ts || null) : null,
    entregue,
    insucesso,
    destino:        meta.ds_municipio_destino ? `${meta.ds_municipio_destino}/${meta.sg_uf_destino || ''}` : '',
    statusLabel:    ultimo.descricao || '—',
    local:          ultimo.local || '',
    pod:            ultimo.urlPod || null,
    eventos,
    fetchedAt:      new Date().toISOString(),
  };
}

// ─── Correios ────────────────────────────────────────────────────────────────
// O código de acesso gerado no portal CWS (formato cws-ch1_...) funciona como
// Bearer token direto — não precisa de endpoint de auth separado.
// Rastreio: GET /srorastro/v1/objetos?codigosObjetos={codigoObjeto}
//           O codigoObjeto é o código impresso no rótulo dos Correios (ex: SS123456789BR)

async function correiosConsultar({ codigoObjeto }) {
  const token = process.env.CORREIOS_COD_ACESSO;
  if (!token) throw new Error('Código de acesso Correios não configurado (CORREIOS_COD_ACESSO)');
  const codigo = (codigoObjeto || '').trim();
  if (!codigo) throw new Error('Código de objeto obrigatório para rastreio Correios (ex: SS123456789BR)');

  const resp = await fetch(
    `https://api.correios.com.br/srorastro/v1/objetos?codigosObjetos=${encodeURIComponent(codigo)}`,
    { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } },
  );
  const json = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    const msg = Array.isArray(json.msgs) ? json.msgs[0] : (json.error || `HTTP ${resp.status}`);
    throw new Error(`Correios: ${msg}`);
  }
  return json;
}

function correiosNormalize(data, codigoObjeto) {
  if (!data) return null;
  const obj = (data.objetos || [])[0];
  if (!obj) return null;
  if (obj.mensagem && !obj.eventos) throw new Error(`Correios: ${obj.mensagem}`);

  const eventos = (obj.eventos || []).map(e => {
    const cidade = e.unidade?.endereco?.cidade || e.localidade?.cidade || '';
    const uf     = e.unidade?.endereco?.uf     || e.localidade?.uf     || '';
    return {
      ts:           e.dtHora || null,
      codigo:       e.codigo || '',
      descricao:    [e.descricao, e.detalhe].filter(Boolean).join(' — '),
      local:        cidade ? `${cidade}/${uf}`.replace(/\/$/, '') : '',
      lat:          null,
      lng:          null,
      urlPod:       null,
      urlInsucesso: null,
    };
  });
  eventos.sort((a, b) => new Date(a.ts || 0) - new Date(b.ts || 0));

  const ultimo  = eventos[eventos.length - 1] || {};
  const entregue = /objeto entregue|entregue ao/i.test(ultimo.descricao || '');
  const insucesso = /tentativa|insucess|recusa/i.test(ultimo.descricao || '');

  const dest = obj.destinatario?.endereco;
  return {
    transportadora: 'correios',
    codigo:         codigoObjeto,
    awb:            obj.codObjeto || codigoObjeto,
    previsao:       obj.dtPrevista || null,
    emissao:        obj.dataCriacao || eventos[0]?.ts || null,
    dataEntrega:    entregue ? (ultimo.ts || null) : null,
    entregue,
    insucesso,
    destino:        dest ? `${dest.cidade || ''}/${dest.uf || ''}`.replace(/^\/|\/$/g, '') : '',
    statusLabel:    ultimo.descricao || '—',
    local:          ultimo.local || '',
    pod:            null,
    eventos,
    fetchedAt:      new Date().toISOString(),
  };
}

// ─── Jamef ───────────────────────────────────────────────────────────────────
// Auth: POST /auth/v1/login → access_token (JWT, 1h)
// Rastreio: GET /consulta/v1/rastreamento?numeroNotaFiscal={nf}&documentoDestinatario={cnpj}

const JAMEF_BASE = {
  qa:   'https://api-qa.jamef.com.br',
  prod: 'https://api.jamef.com.br',
};

let jamefToken = { value: null, exp: 0 };

function jamefBase() {
  const amb = (process.env.JAMEF_AMBIENTE || 'qa').toLowerCase();
  return JAMEF_BASE[amb] || JAMEF_BASE.qa;
}

async function jamefAuth() {
  const username = process.env.JAMEF_USERNAME;
  const password = process.env.JAMEF_PASSWORD;
  if (!username || !password) throw new Error('Credenciais Jamef não configuradas (JAMEF_USERNAME/JAMEF_PASSWORD)');

  const resp = await fetch(`${jamefBase()}/auth/v1/login`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body:    JSON.stringify({ username, password }),
  });
  const json = await resp.json().catch(() => ({}));
  if (!resp.ok || !json.access_token) {
    throw new Error(json.message || json.error || `Falha na autenticação Jamef (HTTP ${resp.status})`);
  }
  const ttl = (json.expiresIn || 3600) * 1000 - 60_000;
  jamefToken = { value: json.access_token, exp: Date.now() + ttl };
  return jamefToken.value;
}

async function jamefGetToken(force = false) {
  if (!force && jamefToken.value && Date.now() < jamefToken.exp) return jamefToken.value;
  return jamefAuth();
}

async function jamefConsultar({ numeroNF, cnpj }, isRetry = false) {
  if (!numeroNF) throw new Error('Número da NF obrigatório para rastreio Jamef');

  const token  = await jamefGetToken();
  const params = new URLSearchParams({ numeroNotaFiscal: numeroNF });
  if (cnpj) params.append('documentoDestinatario', cnpj);

  const resp = await fetch(`${jamefBase()}/consulta/v1/rastreamento?${params}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  });
  const json = await resp.json().catch(() => ({}));

  if (resp.status === 401 && !isRetry) {
    await jamefGetToken(true);
    return jamefConsultar({ numeroNF, cnpj }, true);
  }
  if (!resp.ok) throw new Error(json.message || json.error || `Falha ao consultar rastreio Jamef (HTTP ${resp.status})`);
  return json;
}

function jamefNormalize(data, numeroNF) {
  if (!data) return null;
  const lista = Array.isArray(data) ? data : (data.data || data.entregas || data.rastreamentos || []);
  if (!lista.length) return null;

  const entrega = lista[0];
  const ocorrs  = Array.isArray(entrega.ocorrencias) ? entrega.ocorrencias
                : Array.isArray(entrega.eventos)      ? entrega.eventos
                : [];

  const eventos = ocorrs.map(o => ({
    ts:           o.dataHora || o.data || null,
    codigo:       String(o.codigo || ''),
    descricao:    o.descricao || '',
    local:        o.cidade ? `${o.cidade}/${o.uf || ''}`.replace(/\/$/, '') : '',
    lat:          null,
    lng:          null,
    urlPod:       null,
    urlInsucesso: null,
  }));
  eventos.sort((a, b) => new Date(a.ts || 0) - new Date(b.ts || 0));

  const ultimo  = eventos[eventos.length - 1] || {};
  const entregue = !!entrega.dataEntrega || /\bentregue\b/i.test(ultimo.descricao || '');

  return {
    transportadora: 'jamef',
    codigo:         numeroNF,
    awb:            entrega.numeroRemessa || entrega.cte || entrega.awb || null,
    previsao:       entrega.previsaoEntrega || null,
    emissao:        entrega.dataEmissao || eventos[0]?.ts || null,
    dataEntrega:    entrega.dataEntrega || (entregue ? (ultimo.ts || null) : null),
    entregue,
    insucesso:      /insucess|tentativa/i.test(ultimo.descricao || ''),
    destino:        entrega.destinatario?.cidade
                    ? `${entrega.destinatario.cidade}/${entrega.destinatario.uf || ''}`.replace(/\/$/, '')
                    : '',
    statusLabel:    ultimo.descricao || '—',
    local:          ultimo.local || '',
    pod:            entrega.comprovante || entrega.urlComprovante || null,
    eventos,
    fetchedAt:      new Date().toISOString(),
  };
}

// ─── Registry de adaptadores ─────────────────────────────────────────────────
// Adicionar transportadora nova = uma entrada aqui + env vars acima

const CARRIERS = {
  async azul(codigos) {
    const value = await azulConsultar(codigos);
    return azulNormalize(value, codigos.chaveNfe || codigos.awb || codigos.pedido);
  },
  async rotta(codigos) {
    const data = await rottaConsultar(codigos);
    return rottaNormalize(data, codigos.cnpj, codigos.numeroNF);
  },
  async loggica(codigos) {
    const data = await loggicaConsultar(codigos);
    return loggicaNormalize(data, codigos.chaveNfe);
  },
  async correios(codigos) {
    const data = await correiosConsultar(codigos);
    return correiosNormalize(data, codigos.codigoObjeto);
  },
  async jamef(codigos) {
    const data = await jamefConsultar(codigos);
    return jamefNormalize(data, codigos.pedido || codigos.numeroNF);
  },
};

export default async function handler(req, res) {
  if (cors(req, res, 'POST, OPTIONS')) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!await requireAuth(req, res)) return;

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  const { transportadora, chaveNfe, awb, pedido, cnpj, numeroNF, codigoObjeto } = body || {};

  const transp  = String(transportadora || '').toLowerCase();
  const carrier = CARRIERS[transp];
  if (!carrier) {
    return res.status(400).json({ error: `Transportadora "${transportadora}" sem integração de rastreio` });
  }

  // Validações por transportadora
  if (transp === 'rotta') {
    if (!cnpj || !numeroNF) return res.status(400).json({ error: 'Informe cnpj e numeroNF para Rotta Master' });
  } else if (transp === 'loggica') {
    if (!chaveNfe) return res.status(400).json({ error: 'Informe chaveNfe (44 dígitos) para Loggica' });
  } else if (transp === 'correios') {
    if (!codigoObjeto) return res.status(400).json({ error: 'Informe codigoObjeto (ex: SS123456789BR) para Correios' });
  } else {
    if (!chaveNfe && !awb && !pedido && !numeroNF) {
      return res.status(400).json({ error: 'Informe chaveNfe, awb, pedido ou numeroNF' });
    }
  }

  try {
    const dados = await carrier({ chaveNfe, awb, pedido: pedido || numeroNF, cnpj, numeroNF, codigoObjeto });
    if (!dados) return res.status(404).json({ error: 'Nenhum rastreio encontrado para este código' });
    return res.status(200).json(dados);
  } catch (err) {
    return res.status(502).json({ error: err.message });
  }
}
