// PV 002833 — o padrão "simples faturamento" cruzado com a integração do QR.
// Dados reais do Protheus + tracking real do catálogo (/api/retail-items).
// Nada é enviado a lugar nenhum: só monta o payload e mostra o que sairia.
const { INDEX, extrair, bloco } = require('./_extract.js');
const funcs = extrair('equipTracking', 'qrQtdDaLinha', 'qrListaDaLinha', 'qrSeriaisPorLinha', 'qrMontarPayload');

// Catálogo real (/api/retail-items), consultado em produção
globalThis._equipCache = [
  { code: '010940', name: 'SISTEMA DE RADIOFREQUENCIA XERF',        tracking: 'serie' },
  { code: '009550', name: 'ULTRAPULSE ALPHA',                        tracking: 'serie' },
  { code: '011511', name: 'KIT CONSUMÍVEIS XERF EQUIPAMENTO',        tracking: 'lote'  },
  { code: '011539', name: 'XERF EFFECTOR 60 (900) - TIP 900 MP21',   tracking: 'lote'  },
];
eval(funcs);

// As 7 linhas do PV 002833, como o preencherPedido as transforma (1 por linha,
// sem consolidar código repetido). tracking vem do catálogo, via equipTracking.
const LINHAS = [
  { n: 1, code: '010940', name: 'SISTEMA DE RADIOFREQUENCIA XERF', qty: 1,  tes: '708', tesDesc: 'VENDA ENTREGA FUTURA',  numSerie: 'TXE126F142' },
  { n: 2, code: '011511', name: 'KIT CONSUMÍVEIS XERF EQUIPAMENTO', qty: 1, tes: '708', tesDesc: 'VENDA ENTREGA FUTURA',  numSerie: '' },
  { n: 3, code: '011539', name: 'XERF EFFECTOR 60 (900) - TIP 900 MP21', qty: 15, tes: '620', tesDesc: 'REMESSA BONIFICAÇÃO', numSerie: '' },
  { n: 4, code: '009550', name: 'ULTRAPULSE ALPHA', qty: 1,        tes: '624', tesDesc: 'SIMPLES FATURAMENTO', numSerie: '' },
  { n: 5, code: '009550', name: 'ULTRAPULSE ALPHA', qty: 1,        tes: '577', tesDesc: 'VENDA ENTREGA FUTURA', numSerie: '30391' },
  { n: 6, code: '010940', name: 'SISTEMA DE RADIOFREQUENCIA XERF', qty: 1,  tes: '624', tesDesc: 'SIMPLES FATURAMENTO', numSerie: '' },
  { n: 7, code: '011511', name: 'KIT CONSUMÍVEIS XERF EQUIPAMENTO', qty: 1, tes: '624', tesDesc: 'SIMPLES FATURAMENTO', numSerie: '' },
];

console.log('\nLinhas do PV e como o app as classifica:');
let slots = 0;
LINHAS.forEach(l => {
  const t = equipTracking({ name: l.name, code: l.code, simplesFat: l.tes === '624' });
  const pedeQr = t === 'serie' || t === 'lote';
  if (t === 'serie') slots += l.qty;
  else if (t === 'lote') slots += 1;
  console.log('  linha ' + l.n + '  TES ' + l.tes + '  ' + String(t).padEnd(5) +
    '  ' + (pedeQr ? 'pede ' + (t === 'serie' ? l.qty : 1) + ' QR+série' : 'não pede') +
    '   ' + l.name.slice(0, 32));
});
console.log('\n  → o formulário pede ' + slots + ' pares de QR/série.');
console.log('  → mas fisicamente existem só 2 máquinas com série:');
console.log('       XERF (TXE126F142) — faturada na linha 6 (TES 624) e entregue na linha 1 (TES 708)');
console.log('       ULTRAPULSE (30391) — faturada na linha 4 (TES 624) e entregue na linha 5 (TES 577)');

const montarOp = (qrs, series) => ({
  id: 1, numero: '99/2026', cliente: 'FABIA VALENTE DERMATOLOGIA LTDA.', pedidoProtheus: '002833',
  dataAbertura: '2026-08-19',
  pedidoVenda: {
    cliente: 'FABIA VALENTE DERMATOLOGIA LTDA.', vendedorCanal: 'Barbara Kelly',
    equipamentos: LINHAS.map((l, i) => ({
      name: l.name, code: l.code, qty: l.qty, tes: l.tes, tesDesc: l.tesDesc, simplesFat: l.tes === '624',
      numSerie: l.numSerie, qrcodes: qrs[i] ? [qrs[i]] : [],
    })),
  },
  stepData: { aguard_nf: { numSeries: series }, aguard_despacho: { dataDespacho: '2026-08-19' } },
});

// Ordem dos slots de série = ordem das linhas RASTREADAS (1,2,3,4,5,6,7 menos as null)
function cenario(titulo, qrs, series) {
  console.log('\n' + '═'.repeat(66) + '\n' + titulo);
  const { itens, avisos, ignorados } = qrMontarPayload(montarOp(qrs, series));
  console.log('  máquinas enviadas ao Sistema QR: ' + itens.length);
  itens.forEach(i => console.log('    · QR=' + String(i.qr_code).padEnd(10) + ' série=' + String(i.numero_serie).padEnd(12) + ' ' + String(i.modelo).slice(0, 32)));
  if (avisos.length) console.log('  avisos: ' + avisos.join(' · '));
  if (ignorados.length) console.log('  ignorados: ' + ignorados.length + ' linha(s) de lote/sem rastreio');
  return itens;
}

// slots de série na ordem: linha1(serie), linha2(lote), linha3(lote), linha4(serie), linha5(serie), linha6(serie), linha7(lote)
// qrSeriaisPorLinha consome 1 slot por unidade de série e 1 por linha de lote.

const A = cenario(
  'CENÁRIO A — operador põe o MESMO QR nas duas linhas da mesma máquina\n(fisicamente correto: 1 adesivo por máquina)',
  ['QR-XERF', '', '', 'QR-ULTRA', 'QR-ULTRA', 'QR-XERF', ''],
  ['TXE126F142', '', '', '30391', '30391', 'TXE126F142', ''],
);

const B = cenario(
  'CENÁRIO B — operador põe QRs DIFERENTES, achando que são 4 máquinas',
  ['QR-XERF-1', '', '', 'QR-ULTRA-1', 'QR-ULTRA-2', 'QR-XERF-2', ''],
  ['TXE126F142', '', '', '30391', '30391', 'TXE126F142', ''],
);

const C = cenario(
  'CENÁRIO C — operador deixa as linhas de TES 624 em branco\n(natural: no Protheus elas não têm série)',
  ['QR-XERF', '', '', '', 'QR-ULTRA', '', ''],
  ['TXE126F142', '', '', '', '30391', '', ''],
);

console.log('\n' + '═'.repeat(66));
let pass = 0, fail = 0;
const check = (n, c, d) => { if (c) { pass++; console.log('  ok   ' + n); } else { fail++; console.log('  FALHA ' + n + (d ? '\n         → ' + d : '')); } };

// As 2 máquinas físicas do PV 002833, independentemente do que o operador digite
// nas linhas de simples faturamento.
const serieDeA = A.map(i => i.numero_serie).sort().join(',');
check('A: 2 máquinas (não 4)', A.length === 2, A.length + ' enviadas');
check('A: séries certas',      serieDeA === '30391,TXE126F142', serieDeA);
check('B: 2 máquinas mesmo com QRs diferentes nas linhas 624', B.length === 2, B.length + ' enviadas');
check('C: 2 máquinas com as linhas 624 em branco', C.length === 2, C.length + ' enviadas');
check('C: sem aviso falso de "sem QR/série"',
  !qrMontarPayload(montarOp(['QR-XERF','','','','QR-ULTRA','',''], ['TXE126F142','','','','30391','',''])).avisos.length,
  JSON.stringify(qrMontarPayload(montarOp(['QR-XERF','','','','QR-ULTRA','',''], ['TXE126F142','','','','30391','',''])).avisos));
check('o formulário pede 4 slots (2 séries + 2 lotes), não 7', slots === 4, slots + ' slots');

console.log('\n' + '─'.repeat(66));
console.log(pass + ' passaram, ' + fail + ' falharam');
process.exit(fail ? 1 : 0);
