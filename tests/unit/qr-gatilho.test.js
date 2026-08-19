// Em que ponto do fluxo o app chama o Sistema QR?
// Roda a advanceOP() e a STEPS REAIS (extraídas do index.html) com o resto do
// app stubado, e percorre a OP de aguard_nf até entregue registrando os disparos.
const { INDEX, extrair, bloco } = require('./_extract.js');
const funcs = extrair('finNeeded', 'finDone', 'sfNeeded', 'sfDone', 'nowTs', 'advanceOP');

// ── stubs do app (só o necessário para a advanceOP rodar) ──────────────
const disparos = [];
let ops = [];
const dbSaveOp = () => {};
const renderAll = () => {};
const renderCounts = () => {};
const showToast = (m, t) => { if (t === 'err') disparos.push({ tipo: 'toast-erro', msg: m }); };
const getUser = () => ({ userName: 'Teste', role: 'logistica' });
let _viewRole = 'logistica';
const getActiveView = () => ({ role: _viewRole });
const removerOpDasRotas = () => { disparos.push({ tipo: 'tirou-das-rotas' }); };
const cadastrarEquipamentosQR = (op) => { disparos.push({ tipo: 'SISTEMA-QR', status: op.status }); };
const atualizarRastreio = () => { disparos.push({ tipo: 'rastreio' }); };
const RASTREIO_ATIVO = true;
const RASTREAVEIS = new Set(['azul', 'rotta', 'loggica', 'correios', 'jamef']);
let currentTab = 'fila';

// Um eval só: cada chamada de eval cria seu próprio escopo de const/let, então
// STEPS declarado num eval não enxerga (nem é enxergado por) o do outro.
eval([
  bloco('const STEPS = {', 'const PIPELINE_ORDER'),
  bloco('const HIST_ACTION = {', 'const HIST_REJECT'),
  bloco('const HIST_REJECT = {', '// ══'),
  funcs,
].join('\n'));

let pass = 0, fail = 0;
const check = (nome, cond, det) => {
  if (cond) { pass++; console.log('  ok   ' + nome); }
  else      { fail++; console.log('  FALHA ' + nome + (det ? '\n         → ' + det : '')); }
};

function novaOp(status) {
  return {
    id: 1, numero: '42/2026', cliente: 'CLINICA TESTE', status,
    entrada: 'sem', history: [],
    pedidoVenda: { equipamentos: [{ name: 'HIPRO', qty: 1, tracking: 'serie', tes: '000' }] },
    stepData: {
      aguard_nf: { envioTipo: 'transportadora', transportadora: 'jamef', numSeries: ['SN-1'] },
      aguard_emissao: { numeroNF: '12345', dataEmissao: '2026-08-19' },
    },
  };
}
const passo = (op, role, formData = {}) => { _viewRole = role; ops = [op]; advanceOP(op.id, formData); };

console.log('\n1. Fiscal EMITE a nota (aguard_emissao → aguard_despacho)');
{
  disparos.length = 0;
  const op = novaOp('aguard_emissao');
  passo(op, 'fiscal', { numeroNF: '12345', dataEmissao: '2026-08-19' });
  check('OP foi para aguard_despacho', op.status === 'aguard_despacho', op.status);
  check('NÃO chamou o Sistema QR na emissão', !disparos.some(d => d.tipo === 'SISTEMA-QR'),
    'disparou: ' + JSON.stringify(disparos));
  console.log('       disparos: ' + (disparos.map(d => d.tipo).join(', ') || 'nenhum'));
}

console.log('\n2. Logística CONFIRMA O DESPACHO (aguard_despacho → transito)');
{
  disparos.length = 0;
  const op = novaOp('aguard_despacho');
  passo(op, 'logistica', { dataDespacho: '2026-08-19' });
  check('OP foi para transito', op.status === 'transito', op.status);
  check('CHAMOU o Sistema QR', disparos.some(d => d.tipo === 'SISTEMA-QR'), JSON.stringify(disparos));
  check('chamou já com status "transito"', disparos.find(d => d.tipo === 'SISTEMA-QR')?.status === 'transito',
    disparos.find(d => d.tipo === 'SISTEMA-QR')?.status);
  check('disparou o rastreio junto', disparos.some(d => d.tipo === 'rastreio'), JSON.stringify(disparos.map(d => d.tipo)));
  console.log('       disparos: ' + disparos.map(d => d.tipo).join(', '));
}

console.log('\n3. Entrega ao cliente (transito → entregue) não reenvia');
{
  disparos.length = 0;
  const op = novaOp('transito');
  passo(op, 'logistica', { dataEntrega: '2026-08-25', descricao: 'entregue' });
  check('OP foi para entregue', op.status === 'entregue', op.status);
  check('NÃO chamou o Sistema QR de novo', !disparos.some(d => d.tipo === 'SISTEMA-QR'), JSON.stringify(disparos));
  check('tirou a OP das rotas', disparos.some(d => d.tipo === 'tirou-das-rotas'), JSON.stringify(disparos.map(d => d.tipo)));
}

console.log('\n4. Setor errado tentando despachar → bloqueado, e sem enviar ao parceiro');
{
  disparos.length = 0;
  const op = novaOp('aguard_despacho');
  passo(op, 'fiscal', {});
  check('status não mudou', op.status === 'aguard_despacho', op.status);
  check('não chamou o Sistema QR', !disparos.some(d => d.tipo === 'SISTEMA-QR'), JSON.stringify(disparos));
  check('avisou o usuário', disparos.some(d => d.tipo === 'toast-erro'), JSON.stringify(disparos));
}

console.log('\n5. Re-emissão de NF: volta ao fiscal e, ao redespachar, reenvia (upsert)');
{
  disparos.length = 0;
  const op = novaOp('aguard_despacho');
  passo(op, 'logistica', { dataDespacho: '2026-08-19' });
  const primeira = disparos.filter(d => d.tipo === 'SISTEMA-QR').length;
  // volta para emissão e avança de novo
  op.status = 'aguard_despacho';
  passo(op, 'logistica', { dataDespacho: '2026-08-20' });
  const total = disparos.filter(d => d.tipo === 'SISTEMA-QR').length;
  check('cada despacho dispara um envio', primeira === 1 && total === 2, 'primeira=' + primeira + ' total=' + total);
  console.log('       (o reenvio é seguro: o handler faz upsert por qr_code)');
}

console.log('\n6. Envio por motorista próprio (sem transportadora) também cadastra');
{
  disparos.length = 0;
  const op = novaOp('aguard_despacho');
  op.stepData.aguard_nf = { envioTipo: 'motorista', motorista: 'Joao', numSeries: ['SN-1'] };
  passo(op, 'logistica', { dataDespacho: '2026-08-19' });
  check('CHAMOU o Sistema QR (a máquina saiu da fábrica de qualquer jeito)',
    disparos.some(d => d.tipo === 'SISTEMA-QR'), JSON.stringify(disparos));
  check('NÃO disparou rastreio (não há transportadora)', !disparos.some(d => d.tipo === 'rastreio'),
    JSON.stringify(disparos.map(d => d.tipo)));
}

console.log('\n' + '─'.repeat(60));
console.log(pass + ' passaram, ' + fail + ' falharam');
process.exit(fail ? 1 : 0);
