// O que a dbSaveOp REAL faz quando a RLS do Postgres recusa o UPDATE?
// A RLS não devolve erro: ela simplesmente não casa a linha, e o PostgREST
// responde 200 com lista vazia. Este teste simula exatamente isso.
const { INDEX, extrair, bloco } = require('./_extract.js');
const funcs = extrair('rowToOp', 'dbSaveOp');

let pass = 0, fail = 0;
const check = (nome, cond, det) => {
  if (cond) { pass++; console.log('  ok   ' + nome); }
  else      { fail++; console.log('  FALHA ' + nome + (det ? '\n         → ' + det : '')); }
};

// ── stubs ──────────────────────────────────────────────────────────────
let indicador = [], toasts = [], renders = 0;
let ops = [];
const setSaveIndicator = e => indicador.push(e);
const showToast = (m, t) => toasts.push({ m, t });
const renderAll = () => { renders++; };

// Resultado configurável do UPDATE e do SELECT de verificação
let updateResult = { data: [{ id: 1, updated_at: 'T2' }], error: null };
let linhaNoBanco = { id: 1, updated_at: 'T1' };

const builder = (resultado) => {
  const b = {
    eq: () => b,
    select: () => Promise.resolve(resultado()),
    single: () => Promise.resolve(resultado()),
  };
  b.then = (res, rej) => Promise.resolve(resultado()).then(res, rej);
  return b;
};
const sb = {
  from: () => ({
    update: () => builder(() => updateResult),
    select: () => builder(() => ({ data: linhaNoBanco, error: null })),
  }),
};

eval(funcs);

const novaOp = () => ({ id: 1, numero: '42/2026', cliente: 'CLINICA', status: 'entregue', _loadedAt: 'T1', stepData: {} });
const reset = () => { indicador = []; toasts = []; renders = 0; };
const espera = () => new Promise(r => setTimeout(r, 30));

(async () => {
  console.log('\n1. Caminho feliz (o UPDATE realmente gravou)');
  {
    reset();
    updateResult = { data: [{ id: 1, updated_at: 'T2' }], error: null };
    const op = novaOp(); ops = [op];
    dbSaveOp(op);
    await espera();
    check('indica "salvo"', indicador.includes('ok'), JSON.stringify(indicador));
    check('sem toast de erro', !toasts.some(t => t.t === 'err'), JSON.stringify(toasts));
    check('avança o _loadedAt', op._loadedAt === 'T2', op._loadedAt);
  }

  console.log('\n2. Conflito real (outra pessoa salvou antes)');
  {
    reset();
    updateResult = { data: [], error: null };
    linhaNoBanco = { id: 1, updated_at: 'T9' };  // mudou → conflito de verdade
    const op = novaOp(); ops = [op];
    dbSaveOp(op);
    await espera();
    check('indica erro', indicador.includes('err'), JSON.stringify(indicador));
    check('avisa o usuário', toasts.some(t => t.t === 'err' && /alterada por outra pessoa/i.test(t.m)),
      JSON.stringify(toasts));
  }

  console.log('\n3. RLS RECUSA o update (0 linhas, linha intacta no banco)');
  {
    reset();
    updateResult = { data: [], error: null };
    linhaNoBanco = { id: 1, updated_at: 'T1' };  // NÃO mudou — foi a RLS que barrou
    const op = novaOp(); ops = [op];
    op.stepData.transito = { fotos: [{ name: 'entrega.jpg' }] }; // a alteração do usuário
    dbSaveOp(op);
    await espera();

    console.log('       indicador: ' + JSON.stringify(indicador));
    console.log('       toasts:    ' + JSON.stringify(toasts));
    check('NÃO deveria indicar "salvo" — nada foi gravado', !indicador.includes('ok'),
      'indicou "✓ Salvo" com 0 linhas afetadas — o usuário acredita que salvou');
    check('DEVERIA avisar o usuário', toasts.some(t => t.t === 'err'),
      'nenhum aviso: a alteração some no próximo F5 e ninguém fica sabendo');
  }

  console.log('\n' + '─'.repeat(60));
  console.log(pass + ' passaram, ' + fail + ' falharam');
  process.exit(0);
})();
