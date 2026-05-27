// api/verify.js — verifica o código de verificação usando HMAC
// O código NUNCA ficou no cliente — verifica apenas o hash
//
// Variável de ambiente necessária no Vercel:
//   JWT_SECRET — mesma string usada em login.js

import crypto from 'node:crypto';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')    return res.status(405).json({ error: 'Method not allowed' });

  const JWT_SECRET = process.env.JWT_SECRET;
  if (!JWT_SECRET) {
    return res.status(500).json({ error: 'Servidor não configurado.' });
  }

  const { token, code } = req.body || {};
  if (!token || !code) {
    return res.status(400).json({ error: 'Token e código são obrigatórios.' });
  }

  // ── 1. Decodifica e verifica assinatura do token ───────────────────
  const dotIdx = token.lastIndexOf('.');
  if (dotIdx === -1) return res.status(401).json({ error: 'Token inválido.' });

  const payloadB64 = token.slice(0, dotIdx);
  const sig        = token.slice(dotIdx + 1);

  let payload;
  try {
    const payloadStr = Buffer.from(payloadB64, 'base64url').toString('utf8');
    const secret     = Buffer.from(JWT_SECRET, 'utf8');

    // Verifica assinatura — recomputa HMAC sobre o mesmo payloadStr
    const expectedSig = crypto.createHmac('sha256', secret).update(payloadStr).digest('hex');
    if (!crypto.timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(expectedSig, 'hex'))) {
      return res.status(401).json({ error: 'Token inválido.' });
    }

    payload = JSON.parse(payloadStr);
  } catch {
    return res.status(401).json({ error: 'Token inválido.' });
  }

  // ── 2. Verifica expiração ──────────────────────────────────────────
  if (!payload.exp || Date.now() > payload.exp) {
    return res.status(401).json({ error: 'Código expirado. Clique em "Reenviar código".' });
  }

  // ── 3. Verifica o código (timing-safe) ────────────────────────────
  const secret      = Buffer.from(JWT_SECRET, 'utf8');
  const submittedHash = crypto.createHmac('sha256', secret)
    .update(String(code).trim() + payload.salt).digest('hex');

  const expectedHash = Buffer.from(payload.codeHash, 'hex');
  const submitted    = Buffer.from(submittedHash, 'hex');

  if (!crypto.timingSafeEqual(submitted, expectedHash)) {
    return res.status(401).json({ error: 'Código incorreto. Verifique o e-mail e tente novamente.' });
  }

  // ── 4. Sucesso — retorna dados de sessão (sem info sensível) ───────
  return res.status(200).json({
    sectorId: payload.sectorId,
    name:     payload.name,
  });
}
