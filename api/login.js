// api/login.js — valida credenciais e envia código de verificação via Resend
// NUNCA retorna o código ao cliente — apenas um token HMAC assinado com o hash do código
//
// Variáveis de ambiente necessárias no Vercel:
//   RESEND_API_KEY   — chave do Resend (re_...)
//   JWT_SECRET       — string aleatória para assinar tokens (qualquer texto longo)
//   SUPABASE_URL     — https://hmzxqoktfzheqjjnhlam.supabase.co
//   SUPABASE_ANON_KEY — anon key do Supabase

import crypto from 'node:crypto';

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://hmzxqoktfzheqjjnhlam.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imhtenhxb2t0ZnpoZXFqam5obGFtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzk4ODE4NDUsImV4cCI6MjA5NTQ1Nzg0NX0.5Ll5dRBgZ3X6a_TtMQvKXVj3IExTkaVufoh-KQQXtzI';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')    return res.status(405).json({ error: 'Method not allowed' });

  const JWT_SECRET = process.env.JWT_SECRET;
  const RESEND_KEY = process.env.RESEND_API_KEY;
  if (!JWT_SECRET || !RESEND_KEY) {
    console.error('Missing env vars: JWT_SECRET or RESEND_API_KEY');
    return res.status(500).json({ error: 'Servidor não configurado. Contate o administrador.' });
  }

  const { email, password } = req.body || {};
  if (!email || !password) {
    return res.status(400).json({ error: 'E-mail e senha são obrigatórios.' });
  }

  // ── 1. Valida credenciais no Supabase ──────────────────────────────
  let user;
  try {
    const sbRes = await fetch(
      `${SUPABASE_URL}/rest/v1/usuarios?email=eq.${encodeURIComponent(email.toLowerCase())}&password=eq.${encodeURIComponent(password)}&select=sector_id,name`,
      { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
    );
    const rows = await sbRes.json();
    if (!Array.isArray(rows) || rows.length === 0) {
      return res.status(401).json({ error: 'E-mail ou senha incorretos.' });
    }
    user = rows[0];
  } catch (err) {
    console.error('Supabase error:', err);
    return res.status(502).json({ error: 'Erro ao verificar credenciais. Tente novamente.' });
  }

  // ── 2. Gera código de 6 dígitos (NUNCA vai para o cliente) ─────────
  const code    = String(crypto.randomInt(100000, 999999));
  const salt    = crypto.randomBytes(16).toString('hex');
  const secret  = Buffer.from(JWT_SECRET, 'utf8');
  const codeHash = crypto.createHmac('sha256', secret).update(code + salt).digest('hex');

  // ── 3. Cria token assinado sem o código (apenas o hash) ────────────
  const exp        = Date.now() + 10 * 60 * 1000; // 10 minutos
  const payloadStr = JSON.stringify({ email: email.toLowerCase(), sectorId: user.sector_id, name: user.name, codeHash, salt, exp });
  const sig        = crypto.createHmac('sha256', secret).update(payloadStr).digest('hex');
  const token      = Buffer.from(payloadStr).toString('base64url') + '.' + sig;

  // ── 4. Envia e-mail com o código via Resend ───────────────────────
  const firstName = user.name.split(' ')[0];
  const emailHtml = `<!DOCTYPE html>
<html lang="pt-BR">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Código de acesso</title>
</head>
<body style="margin:0;padding:0;background-color:#eef1f6;font-family:Arial,Helvetica,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#eef1f6;padding:40px 0">
  <tr><td align="center">
    <table width="480" cellpadding="0" cellspacing="0" border="0" style="max-width:480px;border-radius:14px;overflow:hidden;box-shadow:0 4px 20px rgba(22,44,69,.15)">

      <!-- HEADER -->
      <tr><td align="center" bgcolor="#162C45" style="background-color:#162C45;padding:28px 32px">
        <p style="margin:0;font-size:20px;font-weight:700;color:#ffffff;letter-spacing:-0.3px;font-family:Arial,Helvetica,sans-serif">Fluxo de Vendas</p>
        <p style="margin:6px 0 0;font-size:11px;color:#91B0DC;font-family:Courier,monospace;letter-spacing:0.5px">CONTOURLINE EQUIPAMENTOS MÉDICOS</p>
      </td></tr>

      <!-- DIVISOR AZUL -->
      <tr><td height="4" bgcolor="#2672B8" style="background-color:#2672B8;line-height:4px;font-size:4px">&nbsp;</td></tr>

      <!-- CORPO -->
      <tr><td align="center" bgcolor="#ffffff" style="background-color:#ffffff;padding:36px 40px 32px">
        <p style="margin:0 0 6px;font-size:16px;font-weight:700;color:#0f1f35;font-family:Arial,Helvetica,sans-serif">Olá, ${firstName}!</p>
        <p style="margin:0 0 28px;font-size:13px;color:#3d5170;line-height:1.7;font-family:Arial,Helvetica,sans-serif">
          Use o código abaixo para acessar o sistema.<br>
          Ele expira em <strong style="color:#162C45">10 minutos</strong>.
        </p>

        <!-- CÓDIGO -->
        <table cellpadding="0" cellspacing="0" border="0" align="center" style="margin:0 auto 28px">
          <tr><td align="center" bgcolor="#162C45" style="background-color:#162C45;border-radius:12px;padding:22px 32px">
            <span style="font-family:Courier,monospace;font-size:38px;font-weight:700;letter-spacing:16px;color:#ffffff;display:block;line-height:1">${code}</span>
          </td></tr>
        </table>

        <p style="margin:0;font-size:11px;color:#8096b3;line-height:1.6;font-family:Arial,Helvetica,sans-serif">Não compartilhe este código.<br>Se não foi você, ignore este e-mail.</p>
      </td></tr>

      <!-- RODAPÉ -->
      <tr><td align="center" bgcolor="#f0f4f8" style="background-color:#f0f4f8;padding:14px;border-top:1px solid #dde3ed">
        <span style="font-size:10px;color:#8096b3;font-family:Courier,monospace">Rede interna · Acesso restrito · Contourline</span>
      </td></tr>

    </table>
  </td></tr>
</table>
</body></html>`;

  try {
    const sendRes = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from:    'Fluxo de Vendas <ti@contourline.com.br>',
        to:      email,
        subject: `${code} é seu código de acesso — Fluxo de Vendas`,
        html:    emailHtml,
      }),
    });

    if (!sendRes.ok) {
      const errTxt = await sendRes.text();
      console.error('Resend error:', sendRes.status, errTxt);
      return res.status(502).json({ error: 'Falha ao enviar e-mail. Verifique o domínio no Resend ou contate o TI.' });
    }
  } catch (err) {
    console.error('Resend fetch error:', err);
    return res.status(502).json({ error: 'Falha de rede ao enviar e-mail.' });
  }

  // ── 5. Retorna token (sem o código) ───────────────────────────────
  return res.status(200).json({ token, name: user.name });
}
