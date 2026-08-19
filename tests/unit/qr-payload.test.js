// Testa qrMontarPayload() — a função REAL, extraída do index.html.
// Cobre o que o Sistema QR exige (qr_code + numero_serie + data_expedicao) e as
// regras de negócio: 1 cadastro por máquina física, lote/sem-rastreio fora,
// "empresa" = cliente (não a Contourline), vendedor = vendedorCanal.
const { extrair } = require('./_extract.js');

globalThis._equipCache = [
  { code: '002215', name: 'HIPRO',       tracking: 'serie' },
  { code: '005215', name: 'KIT ELETRODO', tracking: 'lote'  },
  { code: '004223', name: 'FIBRA OPTICA', tracking: null    },
];

eval(extrair('equipTracking', 'qrQtdDaLinha', 'qrListaDaLinha', 'qrSeriaisPorLinha', 'qrMontarPayload'));

let pass = 0, fail = 0;
function check(nome, cond, detalhe) {
  if (cond) { pass++; console.log('  ok   ' + nome); }
  else      { fail++; console.log('  FALHA ' + nome + (detalhe ? '\n         → ' + detalhe : '')); }
}

// OP-base realista: o shape que o app grava no jsonb `data`.
function makeOp(equipamentos, numSeries, extra = {}) {
  return {
    id: 999, numero: '42/2026 - PV 012345', cliente: 'CLINICA TESTE LTDA',
    pedidoProtheus: '012345', dataAbertura: '2026-08-01',
    pedidoVenda: {
      empresa: 'Contourline Equipamentos Médicos e Diagnósticos Ltda',
      cnpj: '14.458.149/0001-23',
      cliente: 'CLINICA TESTE LTDA', cpf: '12345678000199',
      tel: '31999998888', email: 'contato@clinicateste.com.br',
      endCEP: '35700333', endRua: 'R. Joaquim Dias Drumond', endNumero: '100',
      endBairro: 'Henrique Nery', endCidade: 'Sete Lagoas', endEstado: 'MG',
      contatoEntrega: 'Dra. Marina', vendedorCanal: 'Barbara Kelly',
      vendedores: ['Barbara Kelly', 'Ana Paula'], analista: 'Ana Paula',
      equipamentos,
    },
    stepData: {
      aguard_nf: { numSeries },
      aguard_despacho: { dataDespacho: '2026-08-19' },
    },
    ...extra,
  };
}

console.log('\n1. Uma máquina de série, tudo preenchido');
{
  const op = makeOp([{ name: 'HIPRO', code: '002215', qty: 1, tracking: 'serie', qrcodes: ['CT-0001'], valorUnit: '85000' }], ['SN-AAA-111']);
  const { itens, avisos, ignorados } = qrMontarPayload(op);
  check('gera exatamente 1 item', itens.length === 1, 'gerou ' + itens.length);
  check('sem avisos', avisos.length === 0, JSON.stringify(avisos));
  const it = itens[0] || {};
  check('qr_code correto', it.qr_code === 'CT-0001', it.qr_code);
  check('numero_serie correto', it.numero_serie === 'SN-AAA-111', it.numero_serie);
  check('data_expedicao = data do despacho', it.data_expedicao === '2026-08-19', it.data_expedicao);
  check('empresa = CLIENTE, não Contourline', it.empresa?.razao_social === 'CLINICA TESTE LTDA', it.empresa?.razao_social);
  check('cpf_cnpj = do cliente', it.empresa?.cpf_cnpj === '12345678000199', it.empresa?.cpf_cnpj);
  check('vendedor = vendedorCanal (não o analista)', it.pedido_producao?.vendedor === 'Barbara Kelly', it.pedido_producao?.vendedor);
  check('pedido_producao.numero = PV do Protheus', it.pedido_producao?.numero === '012345', it.pedido_producao?.numero);
}

console.log('\n2. Linha com qty=3 → 3 máquinas, 3 QRs, 3 séries');
{
  const op = makeOp(
    [{ name: 'HIPRO', code: '002215', qty: 3, tracking: 'serie', qrcodes: ['CT-01', 'CT-02', 'CT-03'] }],
    ['SN-1', 'SN-2', 'SN-3'],
  );
  const { itens, avisos } = qrMontarPayload(op);
  check('gera 3 itens', itens.length === 3, 'gerou ' + itens.length);
  check('sem avisos', avisos.length === 0, JSON.stringify(avisos));
  check('QRs distintos e na ordem', itens.map(i => i.qr_code).join(',') === 'CT-01,CT-02,CT-03', itens.map(i => i.qr_code).join(','));
  check('séries pareadas na ordem', itens.map(i => i.numero_serie).join(',') === 'SN-1,SN-2,SN-3', itens.map(i => i.numero_serie).join(','));
}

console.log('\n3. Lote e item sem rastreio ficam de fora (ignorados, não é erro)');
{
  const op = makeOp([
    { name: 'HIPRO', code: '002215', qty: 1, tracking: 'serie', qrcodes: ['CT-09'] },
    { name: 'KIT ELETRODO', code: '005215', qty: 4, tracking: 'lote', qrcodes: ['LOTE-X'] },
    { name: 'FIBRA OPTICA', code: '004223', qty: 2, tracking: null },
  ], ['SN-9']);
  const { itens, avisos, ignorados } = qrMontarPayload(op);
  check('só a máquina de série entra', itens.length === 1 && itens[0].numero_serie === 'SN-9', JSON.stringify(itens.map(i => i.numero_serie)));
  check('lote e sem-rastreio viram "ignorados"', ignorados.length === 2, JSON.stringify(ignorados));
  check('ignorado não vira aviso de erro', avisos.length === 0, JSON.stringify(avisos));
}

console.log('\n4. Máquina sem QR / sem série → aviso, e NÃO é enviada');
{
  const op = makeOp([
    { name: 'HIPRO', code: '002215', qty: 2, tracking: 'serie', qrcodes: ['CT-11', ''] },
  ], ['SN-11', 'SN-12']);
  const a = qrMontarPayload(op);
  check('sem QR: só 1 item enviado', a.itens.length === 1, 'enviou ' + a.itens.length);
  check('sem QR: aviso emitido', a.avisos.some(x => /sem QR/i.test(x)), JSON.stringify(a.avisos));

  const op2 = makeOp([
    { name: 'HIPRO', code: '002215', qty: 2, tracking: 'serie', qrcodes: ['CT-21', 'CT-22'] },
  ], ['SN-21', '']);
  const b = qrMontarPayload(op2);
  check('sem série: só 1 item enviado', b.itens.length === 1, 'enviou ' + b.itens.length);
  check('sem série: aviso emitido', b.avisos.some(x => /sem nº de série/i.test(x)), JSON.stringify(b.avisos));
}

console.log('\n5. QR repetido na mesma OP → aviso (senão 2 máquinas viram 1 registro)');
{
  const op = makeOp([
    { name: 'HIPRO', code: '002215', qty: 2, tracking: 'serie', qrcodes: ['CT-DUP', 'ct-dup'] },
  ], ['SN-A', 'SN-B']);
  const { avisos } = qrMontarPayload(op);
  check('detecta duplicata ignorando caixa', avisos.some(x => /repetido/i.test(x)), JSON.stringify(avisos));
}

console.log('\n6. Sem dataDespacho → cai para hoje (a API exige data_expedicao)');
{
  const op = makeOp([{ name: 'HIPRO', code: '002215', qty: 1, tracking: 'serie', qrcodes: ['CT-77'] }], ['SN-77']);
  delete op.stepData.aguard_despacho;
  const { itens } = qrMontarPayload(op);
  const hoje = new Date().toISOString().split('T')[0];
  check('data_expedicao = hoje', itens[0]?.data_expedicao === hoje, itens[0]?.data_expedicao);
}

console.log('\n7. Séries são pareadas por linha, com várias linhas rastreadas');
{
  const op = makeOp([
    { name: 'HIPRO', code: '002215', qty: 2, tracking: 'serie', qrcodes: ['A1', 'A2'] },
    { name: 'KIT ELETRODO', code: '005215', qty: 1, tracking: 'lote', qrcodes: ['L1'] },
    { name: 'HIPRO', code: '002215', qty: 1, tracking: 'serie', qrcodes: ['B1'] },
  ], ['SN-A1', 'SN-A2', 'SN-LOTE', 'SN-B1']);
  const { itens } = qrMontarPayload(op);
  const pares = itens.map(i => i.qr_code + '=' + i.numero_serie).join(' ');
  check('QR↔série não desalinha por causa da linha de lote',
    pares === 'A1=SN-A1 A2=SN-A2 B1=SN-B1', pares);
}

console.log('\n' + '─'.repeat(60));
console.log(pass + ' passaram, ' + fail + ' falharam');
process.exit(fail ? 1 : 0);
