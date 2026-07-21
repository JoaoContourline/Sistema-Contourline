// api/_auth.js — guard de autenticação compartilhado.
//
// NÃO é uma rota: arquivos com prefixo "_" são ignorados pelo roteador da Vercel.
//
// Antes disto, todas as funções em /api eram anônimas: qualquer pessoa na
// internet chamava /api/cliente?code=000001 e lia dados de cliente do Protheus
// (CPF/CNPJ, endereço, telefone), ou escrevia no Sistema QR do parceiro usando
// as credenciais da Contourline. O front tem login (Supabase Auth), mas a
// camada /api não verificava nada — era um desvio completo desse perímetro.
//
// Agora o front manda o access_token da sessão e aqui ele é validado contra o
// próprio Supabase. Sem token válido → 401, sem tocar no Protheus/Azul/QR.

const TOKEN_CACHE = new Map(); // token → { user, exp } — evita 1 ida ao Supabase por request
const CACHE_MS    = 60_000;

// Lê o `exp` (ms) do payload do JWT sem validar assinatura — só para não aceitar
// token já expirado nem cachear além do fim da sessão. A validação real continua
// sendo o /auth/v1/user do Supabase.
function jwtExp(token) {
  try {
    const p = token.split('.')[1];
    const json = JSON.parse(Buffer.from(p.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
    return p && json.exp ? json.exp * 1000 : null;
  } catch { return null; }
}

// Projeto Supabase. Estes valores JÁ são públicos (estão no index.html servido a
// qualquer visitante) — a anon key é publicável por design, protegida por RLS.
// Ficam como fallback de propósito: se dependessem só de env var e ela faltasse
// na Vercel, TODAS as rotas responderiam 503 e o sistema inteiro cairia.
const SB_URL  = process.env.SUPABASE_URL || 'https://hmzxqoktfzheqjjnhlam.supabase.co';
const SB_ANON = process.env.SUPABASE_ANON_KEY
  || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imhtenhxb2t0ZnpoZXFqam5obGFtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzk4ODE4NDUsImV4cCI6MjA5NTQ1Nzg0NX0.5Ll5dRBgZ3X6a_TtMQvKXVj3IExTkaVufoh-KQQXtzI';

/** Setor (sector_id) do usuário, lido do profiles com o próprio token (RLS). null se indeterminado. */
export async function sectorOf(req, userId) {
  const header = String(req.headers.authorization || '');
  const token  = header.replace(/^bearer\s+/i, '').trim();
  try {
    const r = await fetch(`${SB_URL}/rest/v1/profiles?id=eq.${encodeURIComponent(userId)}&select=sector_id`, {
      headers: { apikey: SB_ANON, Authorization: `Bearer ${token}` },
    });
    if (!r.ok) return null;
    const rows = await r.json();
    return rows?.[0]?.sector_id || null;
  } catch { return null; }
}

/**
 * Exige sessão válida E setor no allowlist. Bloqueia (403) quando o setor é
 * conhecido e não permitido; se o setor não puder ser determinado (erro/rede),
 * deixa passar para não travar o sistema. Retorna o usuário ou null (já respondeu).
 */
export async function requireSectors(req, res, allowed) {
  const user = await requireAuth(req, res);
  if (!user) return null;
  const sector = await sectorOf(req, user.id);
  if (sector && !allowed.includes(sector)) {
    res.status(403).json({ error: 'Seu setor não tem acesso a este recurso' });
    return null;
  }
  return user;
}

/** Headers de CORS + preflight. Devolve true se a requisição era OPTIONS (já respondida). */
export function cors(req, res, methods = 'GET, OPTIONS') {
  // O front é servido no mesmo domínio, então CORS aqui é só formalidade.
  // Authorization PRECISA estar liberado, senão o preflight barra o token.
  res.setHeader('Access-Control-Allow-Origin', process.env.APP_ORIGIN || '*');
  res.setHeader('Access-Control-Allow-Methods', methods);
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Cache-Control', 'private, no-store'); // nada de PII em cache de CDN
  if (req.method === 'OPTIONS') { res.status(200).end(); return true; }
  return false;
}

/**
 * Exige uma sessão válida do Supabase.
 * Devolve o usuário, ou null (e JÁ respondeu 401/503 — o handler deve só retornar).
 */
export async function requireAuth(req, res) {
  const header = String(req.headers.authorization || '');
  const token  = /^bearer\s+/i.test(header) ? header.replace(/^bearer\s+/i, '').trim() : '';
  if (!token) { res.status(401).json({ error: 'Não autenticado' }); return null; }

  const hit = TOKEN_CACHE.get(token);
  if (hit && Date.now() < hit.exp) return hit.user;

  // Expiração real do JWT: se já passou, rejeita sem nem consultar o Supabase.
  const jwtExpMs = jwtExp(token);
  if (jwtExpMs && Date.now() >= jwtExpMs) {
    TOKEN_CACHE.delete(token);
    res.status(401).json({ error: 'Sessão expirada' });
    return null;
  }

  let resp;
  try {
    resp = await fetch(`${SB_URL}/auth/v1/user`, {
      headers: { apikey: SB_ANON, Authorization: `Bearer ${token}` },
    });
  } catch {
    res.status(503).json({ error: 'Não foi possível validar a sessão' });
    return null;
  }

  if (!resp.ok) {
    TOKEN_CACHE.delete(token);
    res.status(401).json({ error: 'Sessão inválida ou expirada' });
    return null;
  }

  const user = await resp.json().catch(() => null);
  if (!user?.id) { res.status(401).json({ error: 'Sessão inválida' }); return null; }

  if (TOKEN_CACHE.size > 500) TOKEN_CACHE.clear(); // teto simples de memória
  // Cache no máx. até 60s, mas nunca além da expiração real do token.
  const cacheUntil = jwtExpMs ? Math.min(Date.now() + CACHE_MS, jwtExpMs) : Date.now() + CACHE_MS;
  TOKEN_CACHE.set(token, { user, exp: cacheUntil });
  return user;
}
