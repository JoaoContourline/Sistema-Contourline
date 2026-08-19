// Testa o handler REAL do /api/rastreio com as 5 transportadoras simuladas.
// Este código foi para produção sem nunca ter sido executado — os testes de
// rastreio existentes precisam de servidor no ar. Aqui o alvo é o contrato de
// cada adaptador: autenticação, consulta e tradução para o formato normalizado.
import { importarApi, mkRes } from './_api.mjs';
const { default: handler } = await importarApi('rastreio');

process.env.EMAIL_AZUL = 'a@b.c';           process.env.SENHA_AZUL = 'x';
process.env.LOGGICA_USUARIO = 'u';          process.env.LOGGICA_SENHA = 'x';
process.env.CORREIOS_COD_ACESSO = 'cws-ch1_teste';
process.env.JAMEF_USERNAME = 'u';           process.env.JAMEF_PASSWORD = 'x';
process.env.RASTREIO_AZUL_AMBIENTE = 'homolog';
process.env.JAMEF_AMBIENTE = 'qa';

let pass = 0, fail = 0;
const ok = (n, c, d) => { if (c) { pass++; console.log('  ok    ' + n); } else { fail++; console.log('  FALHA ' + n + (d ? '\n          → ' + d : '')); } };

let chamadas = [];
const json = (s, o) => new Response(JSON.stringify(o), { status: s, headers: { 'Content-Type': 'application/json' } });

globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  chamadas.push({ url: u, method: opts.method || 'GET', auth: opts.headers?.Authorization || opts.headers?.authorization });

  if (u.includes('/auth/v1/user'))    return json(200, { id: 'u1' });
  if (u.includes('/rest/v1/profiles')) return json(200, [{ sector_id: 'logistica' }]);

  // ── Azul ──
  if (u.includes('AutenticarUsuario')) return json(200, { Value: 'tok-azul', HasErrors: false });
  if (u.includes('/api/Rastreio/Consultar')) return json(200, { HasErrors: false, Value: [{
    Awb: '5771234567', DataEntregaPrevisao: '2026-08-22', DataHoraEmissao: '2026-08-19T08:00:00',
    DataHoraEntrega: '2026-08-21T14:30:00', DestinoCidade: 'RECIFE', DestinoUnidade: 'REC',
    Ocorrencias: [
      { DataHora: '2026-08-21T14:30:00', Codigo: '01', Descricao: 'ENTREGA REALIZADA', UnidadeMunicipio: 'RECIFE', UnidadeUf: 'PE', UrlPOD: 'https://azul/pod.pdf' },
      { DataHora: '2026-08-19T09:00:00', Codigo: '10', Descricao: 'COLETADO',          UnidadeMunicipio: 'SETE LAGOAS', UnidadeUf: 'MG' },
    ],
  }] });

  // ── Rotta Master ──
  if (u.includes('rottamasterst.php')) return json(200, { status: 1, data: [{
    prev_entrega: '22/08/2026', comprovante: 'https://rotta/canhoto.jpg',
    dados: [
      { data: '2026-08-19T09:00:00', descricao: 'COLETADO' },
      { data: '2026-08-20T10:00:00', descricao: 'PREVISÃO DE ENTREGA 22/08' },
      { data: '2026-08-21T15:00:00', descricao: '<a href="https://rotta/canhoto.jpg">Entregue</a>' },
    ],
  }] });

  // ── Loggica (Brudam) ──
  if (u.includes('/acesso/auth/login')) return json(200, { data: { access_key: 'tok-loggica' } });
  if (u.includes('/tracking/ocorrencias')) return json(200, { data: [
    { dt_ocorrencia: '2026-08-19T09:00:00', cd_ocorrencia: '01', ds_ocorrencia: 'COLETA REALIZADA', ds_municipio: 'SETE LAGOAS', sg_uf: 'MG' },
    { dt_ocorrencia: '2026-08-21T16:00:00', cd_ocorrencia: '99', ds_ocorrencia: 'ENTREGUE AO DESTINATARIO', ds_municipio: 'RECIFE', sg_uf: 'PE', url_comprovante: 'https://loggica/pod.pdf' },
  ] });

  // ── Correios ──
  if (u.includes('/srorastro/v1/objetos')) return json(200, { objetos: [{
    codObjeto: 'SS123456789BR', dtPrevista: '2026-08-22', dataCriacao: '2026-08-19T08:00:00',
    destinatario: { endereco: { cidade: 'RECIFE', uf: 'PE' } },
    eventos: [
      { dtHora: '2026-08-21T17:00:00', codigo: 'BDE', descricao: 'Objeto entregue ao destinatário', unidade: { endereco: { cidade: 'RECIFE', uf: 'PE' } } },
      { dtHora: '2026-08-19T09:00:00', codigo: 'PO',  descricao: 'Objeto postado', unidade: { endereco: { cidade: 'SETE LAGOAS', uf: 'MG' } } },
    ],
  }] });

  // ── Jamef ──
  if (u.includes('/auth/v1/login')) return json(200, { access_token: 'tok-jamef', expiresIn: 3600 });
  if (u.includes('/consulta/v1/rastreamento')) return json(200, { data: [{
    numeroRemessa: 'JMF-987', previsaoEntrega: '2026-08-22', dataEntrega: '2026-08-21T13:00:00',
    destinatario: { cidade: 'RECIFE', uf: 'PE' },
    ocorrencias: [
      { dataHora: '2026-08-19T09:00:00', codigo: '1', descricao: 'MERCADORIA COLETADA', cidade: 'SETE LAGOAS', uf: 'MG' },
      { dataHora: '2026-08-21T13:00:00', codigo: '9', descricao: 'ENTREGUE', cidade: 'RECIFE', uf: 'PE' },
    ],
  }] });

  return json(500, { error: 'url nao simulada: ' + u });
};

const chamar = async (body, comAuth = true) => {
  chamadas = [];
  const res = mkRes();
  await handler({ method: 'POST', headers: comAuth ? { authorization: 'Bearer jwt' } : {}, query: {}, body }, res);
  return res;
};

// Invariantes que TODO adaptador precisa respeitar — é o contrato de que o
// front depende para não precisar saber qual transportadora é.
function checarFormato(nome, d) {
  ok(nome + ': devolve objeto normalizado', !!d && typeof d === 'object', JSON.stringify(d)?.slice(0, 120));
  if (!d) return;
  ok(nome + ': transportadora preenchida', !!d.transportadora, String(d.transportadora));
  ok(nome + ': eventos é array não-vazio', Array.isArray(d.eventos) && d.eventos.length > 0, JSON.stringify(d.eventos)?.slice(0, 100));
  const ts = (d.eventos || []).map(e => new Date(e.ts || 0).getTime());
  ok(nome + ': eventos em ordem crescente', ts.every((t, i) => i === 0 || t >= ts[i - 1]), JSON.stringify(ts));
  ok(nome + ': statusLabel é o último evento', d.statusLabel === d.eventos[d.eventos.length - 1].descricao,
     d.statusLabel + ' vs ' + d.eventos[d.eventos.length - 1].descricao);
  ok(nome + ': detectou a entrega', d.entregue === true, 'entregue=' + d.entregue + ' statusLabel=' + d.statusLabel);
  ok(nome + ': fetchedAt em ISO', typeof d.fetchedAt === 'string' && !isNaN(Date.parse(d.fetchedAt)), d.fetchedAt);
}

console.log('\n1. Azul Cargo');
{
  const r = await chamar({ transportadora: 'azul', chaveNfe: '1'.repeat(44) });
  ok('HTTP 200', r.statusCode === 200, r.statusCode + ' ' + JSON.stringify(r.body));
  checarFormato('azul', r.body);
  ok('azul: AWB extraído', r.body?.awb === '5771234567', r.body?.awb);
  ok('azul: POD do último evento que tem', r.body?.pod === 'https://azul/pod.pdf', r.body?.pod);
}

console.log('\n2. Rotta Master');
{
  const r = await chamar({ transportadora: 'rotta', cnpj: '14458149000123', numeroNF: '19373' });
  ok('HTTP 200', r.statusCode === 200, r.statusCode + ' ' + JSON.stringify(r.body));
  checarFormato('rotta', r.body);
  ok('rotta: linha de "previsão de entrega" não vira evento',
     !(r.body?.eventos || []).some(e => /previs/i.test(e.descricao)), JSON.stringify(r.body?.eventos?.map(e => e.descricao)));
  ok('rotta: extraiu o texto de dentro do <a>', r.body?.statusLabel === 'Entregue', r.body?.statusLabel);
  ok('rotta: previsão dd/mm/aaaa → ISO', r.body?.previsao === '2026-08-22', r.body?.previsao);
  ok('rotta: comprovante vira pod', r.body?.pod === 'https://rotta/canhoto.jpg', r.body?.pod);
}

console.log('\n3. Loggica (Brudam)');
{
  const r = await chamar({ transportadora: 'loggica', chaveNfe: '2'.repeat(44) });
  ok('HTTP 200', r.statusCode === 200, r.statusCode + ' ' + JSON.stringify(r.body));
  checarFormato('loggica', r.body);
  const cons = chamadas.find(c => c.url.includes('/tracking/ocorrencias'));
  ok('loggica: token vai SEM "Bearer" (peculiaridade da API)',
     cons && cons.auth === 'tok-loggica', 'authorization=' + JSON.stringify(cons?.auth));
  ok('loggica: local montado como cidade/UF', r.body?.eventos?.[0]?.local === 'SETE LAGOAS/MG', r.body?.eventos?.[0]?.local);
}

console.log('\n4. Correios');
{
  const r = await chamar({ transportadora: 'correios', codigoObjeto: 'SS123456789BR' });
  ok('HTTP 200', r.statusCode === 200, r.statusCode + ' ' + JSON.stringify(r.body));
  checarFormato('correios', r.body);
  const cons = chamadas.find(c => c.url.includes('/srorastro/'));
  ok('correios: usa o código CWS como Bearer direto (sem endpoint de auth)',
     cons?.auth === 'Bearer cws-ch1_teste' && !chamadas.some(c => /login|auth/i.test(c.url) && !c.url.includes('supabase')),
     'auth=' + cons?.auth);
  ok('correios: descrição junta descricao + detalhe', /Objeto entregue/.test(r.body?.statusLabel || ''), r.body?.statusLabel);
}

console.log('\n5. Jamef');
{
  const r = await chamar({ transportadora: 'jamef', numeroNF: '19373', cnpj: '14458149000123' });
  ok('HTTP 200', r.statusCode === 200, r.statusCode + ' ' + JSON.stringify(r.body));
  checarFormato('jamef', r.body);
  ok('jamef: numeroRemessa vira awb', r.body?.awb === 'JMF-987', r.body?.awb);
  ok('jamef: dataEntrega preservada', String(r.body?.dataEntrega || '').startsWith('2026-08-21'), r.body?.dataEntrega);
}

console.log('\n6. Guardas do handler');
{
  const semAuth = await chamar({ transportadora: 'azul', chaveNfe: '1'.repeat(44) }, false);
  ok('sem sessão → 401', semAuth.statusCode === 401, String(semAuth.statusCode));

  const desconhecida = await chamar({ transportadora: 'sedex-imaginario', numeroNF: '1' });
  ok('transportadora sem integração → 400', desconhecida.statusCode === 400, String(desconhecida.statusCode));

  const rottaSemCnpj = await chamar({ transportadora: 'rotta', numeroNF: '19373' });
  ok('rotta sem cnpj → 400', rottaSemCnpj.statusCode === 400, String(rottaSemCnpj.statusCode));

  const loggicaSemChave = await chamar({ transportadora: 'loggica', numeroNF: '19373' });
  ok('loggica sem chaveNfe → 400', loggicaSemChave.statusCode === 400, String(loggicaSemChave.statusCode));

  const correiosSemCodigo = await chamar({ transportadora: 'correios', numeroNF: '19373' });
  ok('correios sem codigoObjeto → 400', correiosSemCodigo.statusCode === 400, String(correiosSemCodigo.statusCode));

  const loggicaChaveCurta = await chamar({ transportadora: 'loggica', chaveNfe: '123' });
  ok('loggica com chave inválida → 502 com motivo', loggicaChaveCurta.statusCode === 502 && /44 d/i.test(loggicaChaveCurta.body?.error || ''),
     loggicaChaveCurta.statusCode + ' ' + JSON.stringify(loggicaChaveCurta.body));
}

console.log('\n' + '─'.repeat(60));
console.log(pass + ' passaram, ' + fail + ' falharam');
process.exit(fail ? 1 : 0);
