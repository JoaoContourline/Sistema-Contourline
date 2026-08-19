// Testa o handler REAL do /api/qrcode com o Sistema QR simulado.
// Cobre o contrato que a doc do parceiro impõe: POST em QR existente SUBSTITUI
// o registro e descarta as revisões — por isso o handler consulta antes e usa
// PUT quando já existe. Também cobre o guard de sessão e o retry de token.
import { importarApi, mkRes } from './_api.mjs';
const { default: handler } = await importarApi('qrcode');

process.env.QR_EMAIL = 'qr@contourline.com.br';
process.env.QR_SENHA = 'senha-de-teste';

const QR_BASE = 'https://www.bodyhealthbrasil.com/sistema-qr';
let pass = 0, fail = 0;
const check = (nome, cond, det) => {
  if (cond) { pass++; console.log('  ok   ' + nome); }
  else      { fail++; console.log('  FALHA ' + nome + (det ? '\n         → ' + det : '')); }
};

let chamadas = [];
// existentes: QRs que o Sistema QR simulado já conhece (GET devolve 200)
let existentes = new Set();
let forcar401Uma = false, ja401 = false;
// Contador global: cada login emite um token único. Não usar chamadas.length —
// ela é zerada entre os testes e dois logins acabam com o mesmo nome.
let seqToken = 0;
let setorDoUsuario = 'logistica';

globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  const method = opts.method || 'GET';
  chamadas.push({ url: u, method, body: opts.body ? JSON.parse(opts.body) : null, auth: opts.headers?.Authorization });
  const json = (status, obj) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });

  if (u.includes('/auth/v1/user')) return json(200, { id: 'user-teste-1', email: 'log@contourline.com.br' });
  if (u.includes('/rest/v1/profiles')) return json(200, [{ sector_id: setorDoUsuario }]);
  if (u.endsWith('/api/admin/login')) return json(200, { access_token: 'tok-' + (++seqToken), expires_at: Math.floor(Date.now() / 1000) + 3600 });

  if (u.startsWith(QR_BASE + '/api/admin/equipamentos')) {
    if (forcar401Uma && !ja401) { ja401 = true; return json(401, { error: 'token expirado' }); }
    const qr = decodeURIComponent(u.split('/equipamentos/')[1] || '');
    if (method === 'GET')  return existentes.has(qr) ? json(200, { equipamento: { qr_code: qr } }) : json(404, { error: 'not_found' });
    if (method === 'PUT')  return json(200, { equipamento: { qr_code: qr, numero_serie: opts.body ? JSON.parse(opts.body).numero_serie : '', data_expedicao: '2026-08-19', data_garantia: '2027-08-19' } });
    if (method === 'POST') { const b = JSON.parse(opts.body); existentes.add(b.qr_code); return json(200, { equipamento: { ...b, data_garantia: '2027-08-19' } }); }
  }
  return json(500, { error: 'url nao simulada: ' + u });
};

const mkReq = (body, comAuth = true) => ({
  method: 'POST',
  headers: comAuth ? { authorization: 'Bearer jwt-de-teste' } : {},
  query: {}, body,
});
const equip = (qr, serie) => ({
  qr_code: qr, numero_serie: serie, modelo: 'HIPRO', data_expedicao: '2026-08-19',
  empresa: { razao_social: 'CLINICA TESTE LTDA' },
});
const reset = () => { chamadas = []; forcar401Uma = false; ja401 = false; };

console.log('\n1. Sem sessão → 401 e NADA é enviado ao parceiro');
{
  reset();
  const res = mkRes();
  await handler(mkReq({ equipamentos: [equip('CT-1', 'SN-1')] }, false), res);
  check('responde 401', res.statusCode === 401, 'veio ' + res.statusCode);
  check('não chamou o Sistema QR', !chamadas.some(c => c.url.includes('sistema-qr')), JSON.stringify(chamadas.map(c => c.url)));
}

console.log('\n2. QR novo → POST (cria)');
{
  reset(); existentes = new Set();
  const res = mkRes();
  await handler(mkReq({ equipamentos: [equip('CT-NOVO', 'SN-100')] }), res);
  const eq = chamadas.filter(c => c.url.includes('/equipamentos'));
  check('responde 200', res.statusCode === 200, 'veio ' + res.statusCode + ' ' + JSON.stringify(res.body));
  check('consultou antes (GET)', eq[0]?.method === 'GET', eq[0]?.method);
  check('criou com POST', eq[1]?.method === 'POST', eq[1]?.method);
  check('POST envia qr_code', eq[1]?.body?.qr_code === 'CT-NOVO', JSON.stringify(eq[1]?.body));
  check('acao = "criado"', res.body?.resultados?.[0]?.acao === 'criado', JSON.stringify(res.body?.resultados));
  check('NÃO envia data_garantia (a API calcula)', !('data_garantia' in (eq[1]?.body || {})), JSON.stringify(Object.keys(eq[1]?.body || {})));
}

console.log('\n3. QR já existente → PUT (preserva revisões e created_at)');
{
  reset(); existentes = new Set(['CT-JA-EXISTE']);
  const res = mkRes();
  await handler(mkReq({ equipamentos: [equip('CT-JA-EXISTE', 'SN-200')] }), res);
  const eq = chamadas.filter(c => c.url.includes('/equipamentos'));
  check('atualizou com PUT, não POST', eq[1]?.method === 'PUT', eq[1]?.method);
  check('nenhum POST foi disparado', !eq.some(c => c.method === 'POST'), 'houve POST — descartaria as revisões');
  check('PUT NÃO envia qr_code (imutável)', !('qr_code' in (eq[1]?.body || {})), JSON.stringify(Object.keys(eq[1]?.body || {})));
  check('acao = "atualizado"', res.body?.resultados?.[0]?.acao === 'atualizado', JSON.stringify(res.body?.resultados));
}

console.log('\n4. Normalização: QR com espaços/minúsculas e data BR');
{
  reset(); existentes = new Set();
  const res = mkRes();
  const e = equip(' ct-min usculo ', 'SN-300'); e.data_expedicao = '19/08/2026';
  await handler(mkReq({ equipamentos: [e] }), res);
  const post = chamadas.find(c => c.method === 'POST');
  check('QR sem espaços e em maiúsculas', post?.body?.qr_code === 'CT-MINUSCULO', post?.body?.qr_code);
  check('data BR convertida para ISO', post?.body?.data_expedicao === '2026-08-19', post?.body?.data_expedicao);
}

console.log('\n5. Item inválido → erro por item, sem chamar o parceiro');
{
  reset(); existentes = new Set();
  const res = mkRes();
  const semSerie = equip('CT-X', ''); const semQr = equip('', 'SN-Y');
  await handler(mkReq({ equipamentos: [semSerie, semQr] }), res);
  check('nenhuma chamada de equipamento', !chamadas.some(c => c.url.includes('/equipamentos')), JSON.stringify(chamadas.map(c => c.method + ' ' + c.url)));
  check('ambos com success:false', (res.body?.resultados || []).every(r => !r.success), JSON.stringify(res.body?.resultados));
  check('erro cita numero_serie', /numero_serie/.test(res.body?.resultados?.[0]?.erro || ''), res.body?.resultados?.[0]?.erro);
  check('erro cita qr_code vazio', /qr_code vazio/.test(res.body?.resultados?.[1]?.erro || ''), res.body?.resultados?.[1]?.erro);
}

console.log('\n6. Sucesso parcial → HTTP 207 com a contagem certa');
{
  reset(); existentes = new Set();
  const res = mkRes();
  await handler(mkReq({ equipamentos: [equip('CT-OK', 'SN-1'), equip('CT-RUIM', '')] }), res);
  check('HTTP 207', res.statusCode === 207, 'veio ' + res.statusCode);
  check('gravados = 1', res.body?.gravados === 1, JSON.stringify(res.body));
  check('com_erro = 1', res.body?.com_erro === 1, JSON.stringify(res.body));
  check('success = false', res.body?.success === false, String(res.body?.success));
}

console.log('\n7. Um login só para vários equipamentos (doc pede reuso do token)');
{
  reset(); existentes = new Set();
  const res = mkRes();
  await handler(mkReq({ equipamentos: [equip('CT-A', 'S1'), equip('CT-B', 'S2'), equip('CT-C', 'S3')] }), res);
  const logins = chamadas.filter(c => c.url.endsWith('/api/admin/login')).length;
  check('no máximo 1 login para 3 máquinas', logins <= 1, 'houve ' + logins + ' logins');
  check('as 3 foram gravadas', res.body?.gravados === 3, JSON.stringify(res.body));
}

console.log('\n8. Token expirado no meio → renova e repete a chamada');
{
  reset(); existentes = new Set(); forcar401Uma = true;
  const res = mkRes();
  await handler(mkReq({ equipamentos: [equip('CT-401', 'SN-401')] }), res);
  check('a máquina foi gravada mesmo com 401 no caminho', res.body?.gravados === 1, JSON.stringify(res.body));
  // O token vem cacheado dos testes anteriores, então o único login aqui é o
  // forçado pela renovação — o sinal do retry é o login DEPOIS do 401.
  const i401   = chamadas.findIndex(c => c.url.includes('/equipamentos'));
  const iLogin = chamadas.findIndex(c => c.url.endsWith('/api/admin/login'));
  check('renovou o token após o 401', iLogin > i401 && iLogin !== -1,
    'ordem: ' + chamadas.map(c => c.method + ' ' + c.url.split('/').pop()).join(' → '));
  check('repetiu a consulta com o token novo',
    chamadas.filter(c => c.url.includes('/equipamentos') && c.method === 'GET').length === 2,
    chamadas.filter(c => c.url.includes('/equipamentos') && c.method === 'GET').length + ' GETs');
  const posLogin = chamadas.slice(iLogin + 1).find(c => c.url.includes('/equipamentos'));
  check('a repetição usa o token renovado', posLogin?.auth && posLogin.auth !== chamadas[i401]?.auth,
    'antes=' + chamadas[i401]?.auth + ' depois=' + posLogin?.auth);
}

console.log('\n9. Limites de entrada');
{
  reset();
  const r1 = mkRes();
  await handler(mkReq({ equipamentos: [] }), r1);
  check('lista vazia → 400', r1.statusCode === 400, 'veio ' + r1.statusCode);

  const r2 = mkRes();
  await handler(mkReq({ equipamentos: Array.from({ length: 51 }, (_, i) => equip('CT-' + i, 'SN-' + i)) }), r2);
  check('51 equipamentos → 400 (teto de 50)', r2.statusCode === 400, 'veio ' + r2.statusCode);

  const r3 = mkRes();
  await handler({ method: 'GET', headers: { authorization: 'Bearer x' }, query: {} }, r3);
  check('GET → 405', r3.statusCode === 405, 'veio ' + r3.statusCode);
}

console.log('\n10. Guard de setor: quem não despacha não grava no parceiro');
{
  for (const setor of ['comercial', 'financeiro', 'fiscal']) {
    reset(); existentes = new Set();
    setorDoUsuario = setor;
    const res = mkRes();
    await handler(mkReq({ equipamentos: [equip('CT-BLOQ', 'SN-BLOQ')] }), res);
    check(setor + ' → 403', res.statusCode === 403, 'veio ' + res.statusCode);
    check(setor + ' → não tocou no Sistema QR', !chamadas.some(c => c.url.includes('sistema-qr')),
      JSON.stringify(chamadas.filter(c => c.url.includes('sistema-qr')).map(c => c.method)));
  }
  for (const setor of ['logistica', 'gestor', 'adm']) {
    reset(); existentes = new Set();
    setorDoUsuario = setor;
    const res = mkRes();
    await handler(mkReq({ equipamentos: [equip('CT-OK-' + setor, 'SN-' + setor)] }), res);
    check(setor + ' → segue gravando', res.statusCode === 200, 'veio ' + res.statusCode + ' ' + JSON.stringify(res.body));
  }
  setorDoUsuario = 'logistica';
}

console.log('\n' + '─'.repeat(60));
console.log(pass + ' passaram, ' + fail + ' falharam');
process.exit(fail ? 1 : 0);
