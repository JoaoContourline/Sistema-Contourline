// Runner da suíte unitária: roda cada *.test.js / *.test.mjs num processo
// próprio e resume o resultado.
//
// Por que fora do Playwright: estes testes não abrem navegador nem tocam a rede.
// Rodam em segundos, sem servidor e sem credencial — dá para chamá-los a cada
// alteração. Os testes de navegador continuam em tests/*.spec.js.
//
//   npm run test:unit
import { readdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const arquivos = readdirSync(DIR)
  .filter(f => /\.test\.(js|mjs)$/.test(f))
  .sort();

const roda = arquivo => new Promise(resolve => {
  const p = spawn(process.execPath, [path.join(DIR, arquivo)], { encoding: 'utf8' });
  let saida = '';
  p.stdout.on('data', d => { saida += d; });
  p.stderr.on('data', d => { saida += d; });
  p.on('close', code => resolve({ arquivo, code, saida }));
});

const resultados = [];
for (const a of arquivos) resultados.push(await roda(a));

let totalOk = 0, totalFalhas = 0;
console.log('');
for (const r of resultados) {
  const m = r.saida.match(/(\d+)\s+(?:passaram|ok),\s*(\d+)\s+falharam/);
  const ok = m ? Number(m[1]) : 0;
  const fa = m ? Number(m[2]) : (r.code === 0 ? 0 : 1);
  totalOk += ok; totalFalhas += fa;
  const marca = (r.code === 0 && fa === 0) ? 'ok  ' : 'FALHA';
  console.log(`  ${marca} ${r.arquivo.padEnd(34)} ${ok} asserções` + (fa ? `, ${fa} falharam` : ''));
  if (r.code !== 0 || fa) {
    console.log(r.saida.split('\n').filter(l => /FALHA|Error|错|throw|at /.test(l)).slice(0, 12).map(l => '        ' + l).join('\n'));
  }
}
console.log('\n  ' + '─'.repeat(56));
console.log(`  ${arquivos.length} arquivos · ${totalOk} asserções · ${totalFalhas} falhas\n`);
process.exit(totalFalhas ? 1 : 0);
