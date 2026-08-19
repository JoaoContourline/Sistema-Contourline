// Extrai funções do index.html por nome, para os testes rodarem contra o
// código de PRODUÇÃO em vez de uma cópia que envelhece em silêncio.
//
// O index.html é um arquivo único de ~9k linhas sem módulos, então não há o que
// importar: a alternativa seria duplicar as funções no teste, e aí o teste
// passaria a validar a cópia.
const fs   = require('fs');
const path = require('path');

const RAIZ  = path.resolve(__dirname, '..', '..');
const INDEX = path.join(RAIZ, 'index.html');
const BACKSLASH = String.fromCharCode(92);

const _src = () => fs.readFileSync(INDEX, 'utf8');

/** Corpo de uma função declarada no topo do script, achando o `}` que fecha. */
function grab(src, nome) {
  const m = src.match(new RegExp('\\nfunction ' + nome + '\\s*\\('));
  if (!m) throw new Error('função não encontrada no index.html: ' + nome);
  const inicio = src.indexOf('{', m.index + m[0].length - 1);
  let nivel = 0, str = null, ant = '';
  for (let i = inicio; i < src.length; i++) {
    const c = src[i];
    if (str) { if (c === str && ant !== BACKSLASH) str = null; }
    else if (c === '"' || c === "'" || c === '`') str = c;
    else if (c === '{') nivel++;
    else if (c === '}' && --nivel === 0) return src.slice(m.index + 1, i + 1);
    ant = c;
  }
  throw new Error('fim da função não encontrado: ' + nome);
}

/** Devolve o código-fonte das funções pedidas, pronto para eval().
 *  Use UM eval só para todas: cada chamada de eval cria seu próprio escopo de
 *  const/let, então funções avaliadas separadamente não se enxergam. */
function extrair(...nomes) {
  const src = _src();
  return nomes.map(n => grab(src, n)).join('\n\n');
}

/** Trecho entre dois marcadores — para const/let, que o grab() não pega. */
function bloco(inicio, fimMarcador) {
  const src = _src();
  const i = src.indexOf(inicio);
  if (i < 0) throw new Error('marcador não encontrado: ' + inicio);
  const f = src.indexOf(fimMarcador, i);
  if (f < 0) throw new Error('fim não encontrado para: ' + inicio);
  return src.slice(i, f);
}

module.exports = { RAIZ, INDEX, extrair, bloco };
