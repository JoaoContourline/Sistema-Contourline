// api/protheus.js — Vercel serverless function
// Proxy server-side para a API do Protheus (sem CORS no browser)
// Variáveis de ambiente necessárias no Vercel:
//   PROTHEUS_BASE, PROTHEUS_USER, PROTHEUS_PASS

import https from 'https';

// Ignora erros de certificado SSL do Protheus (certificado auto-assinado)
const agent = new https.Agent({ rejectUnauthorized: false });

export default async function handler(req, res) {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { cpfCnpj } = req.query;
  if (!cpfCnpj) {
    return res.status(400).json({ error: 'Parâmetro cpfCnpj é obrigatório' });
  }

  const digits = cpfCnpj.replace(/\D/g, '');
  if (digits.length < 11) {
    return res.status(400).json({ error: 'CPF ou CNPJ inválido' });
  }

  const base = process.env.PROTHEUS_BASE;
  const user = process.env.PROTHEUS_USER;
  const pass = process.env.PROTHEUS_PASS;

  if (!base || !user || !pass) {
    return res.status(500).json({ error: 'Variáveis de ambiente do Protheus não configuradas' });
  }

  const auth = Buffer.from(`${user}:${pass}`).toString('base64');
  // pageSize alto para garantir que o CPF/CNPJ seja encontrado mesmo sem filtro server-side
  const url  = `${base}/api/crm/v1/customerVendor?cpfCnpj=${digits}&pageSize=500`;

  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Authorization': `Basic ${auth}`,
        'Accept': 'application/json',
      },
      // @ts-ignore — undici / Node 18 fetch aceita dispatcher, mas usamos agent abaixo como fallback
      signal: AbortSignal.timeout(15000),
    });

    const text = await response.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { raw: text }; }

    return res.status(response.status).json(data);
  } catch (err) {
    // Fallback: usar o módulo https nativo (suporta agent para ignorar SSL)
    try {
      const data = await new Promise((resolve, reject) => {
        const urlObj = new URL(url);
        const options = {
          hostname: urlObj.hostname,
          port:     urlObj.port || 443,
          path:     urlObj.pathname + urlObj.search,
          method:   'GET',
          headers:  { 'Authorization': `Basic ${auth}`, 'Accept': 'application/json' },
          agent,
          timeout: 15000,
        };
        const r = https.request(options, (resp) => {
          let body = '';
          resp.on('data', chunk => body += chunk);
          resp.on('end',  () => {
            try { resolve({ status: resp.statusCode, body: JSON.parse(body) }); }
            catch { resolve({ status: resp.statusCode, body: { raw: body } }); }
          });
        });
        r.on('error',   reject);
        r.on('timeout', () => { r.destroy(); reject(new Error('timeout')); });
        r.end();
      });
      return res.status(data.status).json(data.body);
    } catch (err2) {
      return res.status(502).json({ error: err2.message || 'Falha ao conectar com o Protheus' });
    }
  }
}
