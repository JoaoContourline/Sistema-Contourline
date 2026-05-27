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
<html lang="pt-BR"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#eef1f6;font-family:Inter,Arial,sans-serif">
<div style="max-width:480px;margin:40px auto;background:#f0f3f7;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(22,44,69,.12)">
  <div style="background:linear-gradient(135deg,#162C45 0%,#24336E 100%);padding:32px 28px;text-align:center">
    <div style="color:#fff;font-size:22px;font-weight:700;letter-spacing:-.3px">Fluxo de Vendas</div>
    <div style="color:rgba(255,255,255,.55);font-size:12px;margin-top:4px;font-family:monospace">Contourline Equipamentos Médicos</div>
  </div>
  <div style="background:#fff;padding:36px 32px;text-align:center">
    <p style="color:#0f1f35;font-size:15px;font-weight:600;margin:0 0 8px">Olá, ${firstName}!</p>
    <p style="color:#3d5170;font-size:13px;margin:0 0 28px;line-height:1.6">Use o código abaixo para acessar o sistema.<br>Ele expira em <strong>10 minutos</strong>.</p>
    <div style="background:#f0f4f8;border:1.5px solid #dde3ed;border-radius:14px;padding:24px 20px;margin:0 0 28px;display:inline-block">
      <div style="font-family:'DM Mono',Courier,monospace;font-size:40px;font-weight:700;letter-spacing:14px;color:#162C45;line-height:1">${code}</div>
    </div>
    <p style="color:#8096b3;font-size:11px;margin:0;line-height:1.6">Não compartilhe este código. Se não foi você, ignore este e-mail.</p>
  </div>
  <div style="background:#f8fafc;border-top:1px solid #eef1f6;padding:14px;text-align:center">
    <span style="color:#aab5c8;font-size:10px;font-family:monospace">Rede interna · Acesso restrito · Contourline</span>
  </div>
</div>
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
