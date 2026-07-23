// api/admin-reset-senha.js — o ADM redefine a senha de um usuário para uma senha
// temporária gerada pelo sistema. Opcionalmente exige a troca no próximo login
// (marcando password_changed_at como antigo → o app força a troca).
import crypto from 'node:crypto';
import { requireSectors, cors } from './_auth.js';

const SB_URL  = process.env.SUPABASE_URL || 'https://hmzxqoktfzheqjjnhlam.supabase.co';
const SERVICE = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;

// Senha temporária forte (sem caracteres ambíguos).
function gerarSenha(n = 12) {
  const cs = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789@#$%&';
  const b = crypto.randomBytes(n);
  let s = '';
  for (let i = 0; i < n; i++) s += cs[b[i] % cs.length];
  return s;
}

export default async function handler(req, res) {
  if (cors(req, res, 'POST, OPTIONS')) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!await requireSectors(req, res, ['adm'])) return; // só o ADM
  if (!SERVICE) return res.status(500).json({ error: 'SUPABASE_SERVICE_KEY não configurada na Vercel' });

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  const userId      = String(body?.userId || '').trim();
  const forceChange = body?.forceChange !== false; // default: exigir troca
  if (!userId) return res.status(400).json({ error: 'userId é obrigatório' });

  const h = { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, 'Content-Type': 'application/json' };
  const temp = gerarSenha();

  try {
    // Define a senha temporária
    const ru = await fetch(`${SB_URL}/auth/v1/admin/users/${userId}`, {
      method: 'PUT', headers: h, body: JSON.stringify({ password: temp }),
    });
    if (!ru.ok) return res.status(502).json({ error: 'Falha ao redefinir: ' + (await ru.text()).slice(0, 160) });

    // Exigir (ou não) a troca no próximo login, via password_changed_at.
    // Antigo (forçar troca) ou agora (não forçar).
    const when = forceChange ? new Date(Date.now() - 200 * 86400000).toISOString() : new Date().toISOString();
    await fetch(`${SB_URL}/rest/v1/profiles?id=eq.${userId}`, {
      method: 'PATCH', headers: { ...h, Prefer: 'return=minimal' },
      body: JSON.stringify({ password_changed_at: when }),
    });

    return res.status(200).json({ tempPassword: temp, forceChange });
  } catch (e) {
    return res.status(502).json({ error: e.message });
  }
}
