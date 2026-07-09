// api/pedido-venda.js — Vercel serverless function
// Puxa um Pedido de Venda (SC5/SC6) do Protheus pelo número e devolve um
// JSON enxuto e já achatado, pronto para preencher o formulário de Nova OP.
//
// Fonte: serviço REST "PedidosVenda" do Protheus (Basic Auth).
//
// Variáveis de ambiente necessárias no Vercel:
//   PEDIDOS_BASE  — base REST do serviço, ex.:
//                   https://contourline200012.protheus.cloudtotvs.com.br:10522/rest   (produção)
//                   https://contourline200013.protheus.cloudtotvs.com.br:10573/rest   (testes)
//   PEDIDOS_USER  — usuário do Protheus (fallback: PROTHEUS_USER)
//   PEDIDOS_PASS  — senha do Protheus   (fallback: PROTHEUS_PASS)

import https from 'node:https';

const agent = new https.Agent({ rejectUnauthorized: false });

function fetchPedido(base, auth, pedido) {
  const url = new URL(`${base}/PedidosVenda`);
  url.searchParams.set('pedido', pedido);

  return new Promise((resolve, reject) => {
    const r = https.request(
      {
        hostname: url.hostname,
        port:     url.port || 443,
        path:     url.pathname + url.search,
        method:   'GET',
        headers:  { Authorization: `Basic ${auth}`, Accept: 'application/json' },
        agent,
        timeout:  20000,
      },
      (resp) => {
        let body = '';
        resp.on('data', chunk => { body += chunk; });
        resp.on('end', () => {
          try   { resolve(JSON.parse(body)); }
          catch { reject(new Error('Resposta inválida do Protheus')); }
        });
      }
    );
    r.on('error',   err => reject(err));
    r.on('timeout', () => { r.destroy(); reject(new Error('Tempo esgotado ao consultar o Protheus')); });
    r.end();
  });
}

// Lê o valor de um campo no formato { titulo, valor, descricao }
const val  = f => (f && f.valor !== undefined && f.valor !== null) ? f.valor : '';
const desc = f => (f && f.descricao) ? f.descricao : '';

// Data Protheus AAAAMMDD → ISO AAAA-MM-DD (para <input type="date">)
function toISO(d) {
  const s = String(d || '').replace(/\D/g, '');
  return s.length === 8 ? `${s.slice(0,4)}-${s.slice(4,6)}-${s.slice(6,8)}` : '';
}
// Data Protheus AAAAMMDD → DD/MM/AAAA (para texto)
function toBR(d) {
  const s = String(d || '').replace(/\D/g, '');
  return s.length === 8 ? `${s.slice(6,8)}/${s.slice(4,6)}/${s.slice(0,4)}` : '';
}
// Data DD/MM/AAAA → ISO AAAA-MM-DD (para <input type="date">)
function brToISO(d) {
  const m = String(d || '').match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : '';
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET')     return res.status(405).json({ error: 'Method not allowed' });

  const pedido = String(req.query.pedido || '').trim();
  if (!pedido) return res.status(400).json({ error: 'Parâmetro "pedido" é obrigatório' });

  const base = process.env.PEDIDOS_BASE;
  const user = process.env.PEDIDOS_USER || process.env.PROTHEUS_USER;
  const pass = process.env.PEDIDOS_PASS || process.env.PROTHEUS_PASS;
  if (!base || !user || !pass)
    return res.status(500).json({ error: 'Serviço não configurado (PEDIDOS_BASE/USER/PASS)' });

  const auth = Buffer.from(`${user}:${pass}`).toString('base64');

  let json;
  try {
    json = await fetchPedido(base, auth, pedido);
  } catch (err) {
    return res.status(502).json({ error: err.message });
  }

  const row = (json && Array.isArray(json.data)) ? json.data[0] : null;
  if (!row || !row.cabecalho)
    return res.status(404).json({ error: `Pedido ${pedido} não encontrado` });

  const cab = row.cabecalho;

  // Formas de pagamento (1..8): condição + parcela + vencimento — só as preenchidas
  const formaCampos = ['C5_CONDPAG','C5_XFORPG2','C5_XFORPG3','C5_XFORPG4','C5_XFORPG5','C5_XFORPG6','C5_XFORPG7','C5_XFORPG8'];
  const pagamentos = [];
  for (let n = 1; n <= 8; n++) {
    const f  = cab[formaCampos[n - 1]];
    const fd = desc(f) || val(f);
    const pv = Number(val(cab[`C5_PARC${n}`]) || 0);
    const dv = toBR(val(cab[`C5_DATA${n}`]));
    if (fd || pv > 0 || dv) pagamentos.push({ forma: fd, valor: pv, venc: dv });
  }

  // Vendedores (1..5) — só os preenchidos (usa a descrição = nome)
  const vendedores = [];
  for (let n = 1; n <= 5; n++) {
    const vd = desc(cab[`C5_VEND${n}`]) || val(cab[`C5_VEND${n}`]);
    if (vd) vendedores.push(vd);
  }

  const itens = Array.isArray(row.itens) ? row.itens.map(it => {
    const qtd     = Number(val(it.C6_QTDVEN)  || 0);
    const total   = Number(val(it.C6_VALOR)   || 0);
    const desconto = Number(val(it.C6_VALDESC) || 0);
    // Preço unitário BRUTO (antes do desconto): (total líquido + desconto) / qtd.
    // C6_PRCVEN já vem líquido; assim o desconto pode ser aplicado sem contar 2x.
    const bruto = qtd > 0 ? (total + desconto) / qtd : Number(val(it.C6_PRCVEN) || 0);
    return {
      item:      val(it.C6_ITEM),
      produto:   val(it.C6_PRODUTO),
      descricao: val(it.C6_DESCRI),
      um:        val(it.C6_UM),
      qtd,
      preco:     bruto,
      desconto,
      total,
      qrcode:    val(it.C6_XQRCODE),
      numSerie:  val(it.C6_NUMSERI),
      lote:      val(it.C6_LOTECTL) || val(it.C6_NUMLOTE),
    };
  }) : [];

  // Cadastro completo do cliente vem no próprio pedido (objeto "cliente", tabela A1)
  const cli = row.cliente || {};
  const cliente = {
    cod:    val(cli.A1_COD)  || val(cab.C5_CLIENTE),
    loja:   val(cli.A1_LOJA) || val(cab.C5_LOJACLI),
    nome:   val(cli.A1_NOME) || desc(cab.C5_CLIENTE),
    pessoa: val(cli.A1_PESSOA),   // F (física) ou J (jurídica)
    cgc:    String(val(cli.A1_CGC) || '').replace(/\D/g, ''),
    rg:     val(cli.A1_PFISICA) || val(cli.A1_RG),
    email:  val(cli.A1_EMAIL),
    ddd:    val(cli.A1_DDD),
    tel:    val(cli.A1_TEL),
    endereco: val(cli.A1_END),
    bairro:   val(cli.A1_BAIRRO),
    cidade:   val(cli.A1_MUN),
    estado:   val(cli.A1_EST),
    cep:      String(val(cli.A1_CEP) || '').replace(/\D/g, ''),
    contato:  val(cli.A1_CONTATO),
    profissao:       val(cli.A1_XPROFIS),
    docProfissional: val(cli.A1_XDOCPRO),
    dataNascimento:  brToISO(val(cli.A1_DTNASC)),
  };

  return res.status(200).json({
    numero:       val(cab.C5_NUM) || pedido,
    statusPedido: row.status_pedido || '',
    cliente,
    emissao:         toISO(val(cab.C5_EMISSAO)),
    condPag:         val(cab.C5_CONDPAG),
    condPagDesc:     desc(cab.C5_CONDPAG),
    pagamentos,
    vendedores,
    simulador:       Number(val(cab.C5_XSIMULA) || 0),
    instagram:       val(cab.C5_XINSTA),
    previsaoEntrega: toISO(val(cab.C5_XPREVEN)),
    nf:    { numero: val(cab.C5_NOTA), serie: val(cab.C5_SERIE) },
    frete: { tipo: val(cab.C5_TPFRETE), tipoDesc: desc(cab.C5_TPFRETE), valor: Number(val(cab.C5_FRETE) || 0) },
    contrato:        val(cab.C5_XCONTR),
    treinamento:     desc(cab.C5_XTREINA) || val(cab.C5_XTREINA),
    outrasInfo:      val(cab.C5_XOUTINF),
    itens,
  });
}
