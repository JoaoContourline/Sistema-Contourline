// api/admin-users.js — lista de usuários (só ADM), para a tela de redefinir senha.
// Usa a SERVICE_ROLE (via env) para ler os usuários do Auth + os perfis.
import { requireSectors, cors } from './_auth.js';

const SB_URL  = process.env.SUPABASE_URL || 'https://hmzxqoktfzheqjjnhlam.supabase.co';
const SERVICE = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;

export default async function handler(req, res) {
  if (cors(req, res, 'GET, OPTIONS')) return;
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  if (!await requireSectors(req, res, ['adm'])) return; // só o ADM
  if (!SERVICE) return res.status(500).json({ error: 'SUPABASE_SERVICE_KEY não configurada na Vercel' });

  const h = { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` };
  try {
    // Usuários do Auth (id + e-mail)
    const ru = await fetch(`${SB_URL}/auth/v1/admin/users?per_page=500`, { headers: h });
    if (!ru.ok) return res.status(502).json({ error: 'Falha ao listar usuários: ' + (await ru.text()).slice(0, 140) });
    const ju = await ru.json();
    const users = (ju.users || ju || []).map(u => ({ id: u.id, email: u.email }));

    // Perfis (nome + setor)
    const rp = await fetch(`${SB_URL}/rest/v1/profiles?select=id,name,sector_id`, { headers: h });
    const profs = rp.ok ? await rp.json() : [];
    const pmap = {};
    (profs || []).forEach(p => { pmap[p.id] = p; });

    const out = users
      .map(u => ({ id: u.id, email: u.email, name: pmap[u.id]?.name || '', sector: (pmap[u.id]?.sector_id || '') }))
      .sort((a, b) => (a.name || a.email).localeCompare(b.name || b.email, 'pt-BR'));

    return res.status(200).json({ users: out });
  } catch (e) {
    return res.status(502).json({ error: e.message });
  }
}
