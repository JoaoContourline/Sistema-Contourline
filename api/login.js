// api/login.js — envia código OTP após autenticação Supabase já validada no cliente
// O frontend valida email+senha via sb.auth.signInWithPassword() ANTES de chamar esta rota.
// Esta rota só gera e envia o código de 2ª etapa — não verifica credenciais.
//
// Variáveis de ambiente necessárias no Vercel:
//   RESEND_API_KEY — chave do Resend (re_...)
//   JWT_SECRET     — string aleatória para assinar tokens (qualquer texto longo)

import crypto from 'node:crypto';

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

  const { email, name } = req.body || {};
  if (!email) return res.status(400).json({ error: 'E-mail é obrigatório.' });

  const firstName = (name || email.split('@')[0]).split(' ')[0];

  // ── 1. Gera código de 6 dígitos (NUNCA vai ao cliente) ─────────────
  const code     = String(crypto.randomInt(100000, 999999));
  const salt     = crypto.randomBytes(16).toString('hex');
  const secret   = Buffer.from(JWT_SECRET, 'utf8');
  const codeHash = crypto.createHmac('sha256', secret).update(code + salt).digest('hex');

  // ── 2. Cria token assinado sem o código ─────────────────────────────
  const exp        = Date.now() + 10 * 60 * 1000; // 10 minutos
  const payloadStr = JSON.stringify({ email: email.toLowerCase(), codeHash, salt, exp });
  const sig        = crypto.createHmac('sha256', secret).update(payloadStr).digest('hex');
  const token      = Buffer.from(payloadStr).toString('base64url') + '.' + sig;

  // ── 3. Envia e-mail com o código via Resend ─────────────────────────
  const emailHtml = `<!DOCTYPE html>
<html lang="pt-BR">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Código de acesso</title>
</head>
<body style="margin:0;padding:0;background-color:#eef1f6;font-family:Arial,Helvetica,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#eef1f6;padding:40px 0">
  <tr><td align="center">
    <table width="480" cellpadding="0" cellspacing="0" border="0" style="max-width:480px;border-radius:14px;overflow:hidden;box-shadow:0 4px 20px rgba(22,44,69,.15)">
      <tr><td align="center" bgcolor="#162C45" style="padding:28px 32px">
        <p style="margin:0;font-size:20px;font-weight:700;color:#fff;font-family:Arial,Helvetica,sans-serif">Fluxo de Vendas</p>
        <p style="margin:6px 0 0;font-size:11px;color:#91B0DC;font-family:Courier,monospace;letter-spacing:.5px">CONTOURLINE EQUIPAMENTOS MÉDICOS</p>
      </td></tr>
      <tr><td height="4" bgcolor="#2672B8" style="line-height:4px;font-size:4px">&nbsp;</td></tr>
      <tr><td align="center" bgcolor="#ffffff" style="padding:36px 40px 32px">
        <p style="margin:0 0 6px;font-size:16px;font-weight:700;color:#0f1f35;font-family:Arial,Helvetica,sans-serif">Olá, ${firstName}!</p>
        <p style="margin:0 0 28px;font-size:13px;color:#3d5170;line-height:1.7;font-family:Arial,Helvetica,sans-serif">
          Use o código abaixo para confirmar seu acesso.<br>
          Ele expira em <strong style="color:#162C45">10 minutos</strong>.
        </p>
        <table cellpadding="0" cellspacing="0" border="0" align="center" style="margin:0 auto 28px">
          <tr><td align="center" bgcolor="#162C45" style="border-radius:12px;padding:22px 32px">
            <span style="font-family:Courier,monospace;font-size:38px;font-weight:700;letter-spacing:16px;color:#fff;display:block;line-height:1">${code}</span>
          </td></tr>
        </table>
        <p style="margin:0;font-size:11px;color:#8096b3;line-height:1.6;font-family:Arial,Helvetica,sans-serif">Não compartilhe este código.<br>Se não foi você, ignore este e-mail.</p>
      </td></tr>
      <tr><td align="center" bgcolor="#f0f4f8" style="padding:14px;border-top:1px solid #dde3ed">
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
      return res.status(502).json({ error: 'Falha ao enviar e-mail. Contate o TI.' });
    }
  } catch (err) {
    console.error('Resend fetch error:', err);
    return res.status(502).json({ error: 'Falha de rede ao enviar e-mail.' });
  }

  return res.status(200).json({ token });
}
