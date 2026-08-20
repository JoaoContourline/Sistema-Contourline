// Agrupar os clones NÃO pode reindexar: os onclick (equipQty/equipRemove/
// equipPrice) indexam tempEquipList direto. Um índice trocado apaga o item errado.
const { extrair } = require('./_extract.js');
const src = extrair('equipListItemsHtml');

// stub: devolve só o índice que o item receberia
const renderEquipItem=(e,i)=>`[${i}:${e.name}${e.simplesFat?'*':''}]`;
let tempEquipList=[];
eval(src);

let pass=0,fail=0;
const ok=(n,c,d)=>{if(c){pass++;console.log('  ok    '+n)}else{fail++;console.log('  FALHA '+n+(d?'\n          → '+d:''))}};

// PV 002833: clones (TES 624) nas posições 3, 5 e 6
tempEquipList=[
  {name:'XERF'},{name:'KIT'},{name:'EFFECTOR'},
  {name:'ULTRAPULSE',simplesFat:true},{name:'ULTRAPULSE'},
  {name:'XERF',simplesFat:true},{name:'KIT',simplesFat:true},
];
const html=equipListItemsHtml();
const idx=[...html.matchAll(/\[(\d+):([^\]]*)\]/g)].map(m=>({i:+m[1],nome:m[2]}));

console.log('\nOrdem renderizada: '+idx.map(x=>x.i+(x.nome.endsWith('*')?'*':'')).join(' → ')+'   (* = clone)');
ok('todos os 7 itens aparecem', idx.length===7, idx.length+' renderizados');
ok('índices preservados (0..6, sem repetir)',
   [...new Set(idx.map(x=>x.i))].sort((a,b)=>a-b).join(',')==='0,1,2,3,4,5,6',
   idx.map(x=>x.i).join(','));
ok('reais primeiro, clones depois', idx.map(x=>x.nome.endsWith('*')?'C':'R').join('')==='RRRRCCC',
   idx.map(x=>x.nome.endsWith('*')?'C':'R').join(''));
ok('cada índice aponta para o item certo',
   idx.every(x=>x.nome.replace('*','')===tempEquipList[x.i].name),
   JSON.stringify(idx));
ok('divisor de simples faturamento presente', /simples faturamento/i.test(html));

// Sem clones a lista sai como antes, sem cabeçalho nenhum
tempEquipList=[{name:'A'},{name:'B'}];
const h2=equipListItemsHtml();
ok('sem clones: nenhum cabeçalho é adicionado', !/simples faturamento|Equipamentos<\/span>/i.test(h2) && h2==='[0:A][1:B]', h2);

// Lista vazia
tempEquipList=[];
ok('lista vazia mantém o placeholder', /Nenhum equipamento adicionado/.test(equipListItemsHtml()));

console.log('\n'+'-'.repeat(58));
console.log(pass+' passaram, '+fail+' falharam');
process.exit(fail?1:0);
