// Importa um handler de /api como módulo ESM.
//
// O package.json não declara "type": "module", então o Node trata api/*.js como
// CommonJS e o `import` falha — mesmo o arquivo sendo ESM (é a Vercel que
// resolve isso em produção). A saída é copiar para .mjs num diretório temporário
// e importar de lá. O teste continua rodando o código real do repositório.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export async function importarApi(nome) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'contourline-api-'));
  for (const arq of ['_auth', nome]) {
    const src = fs.readFileSync(path.join(RAIZ, 'api', arq + '.js'), 'utf8')
      .replace(/'\.\/_auth\.js'/g, "'./_auth.mjs'");
    fs.writeFileSync(path.join(dir, arq + '.mjs'), src);
  }
  return import(pathToFileURL(path.join(dir, nome + '.mjs')).href);
}

/** Resposta HTTP falsa no formato que os handlers da Vercel esperam. */
export function mkRes() {
  const r = { statusCode: null, body: null, headers: {} };
  r.setHeader = (k, v) => { r.headers[k] = v; };
  r.status = c => { r.statusCode = c; return r; };
  r.json = o => { r.body = o; return r; };
  r.end = () => r;
  return r;
}
