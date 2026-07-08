-- =====================================================================
-- Setor (role) na tabela profiles — 2026-07-08
-- Execute UMA vez no SQL Editor do Supabase.
--
-- Motivo: o setor do usuário ficava em auth.users.user_metadata (JSON cru),
-- editável só campo a campo. Passa a ser uma COLUNA em profiles, gerenciável
-- pela Table Editor. Valores válidos:
--   comercial | financeiro | logistica | fiscal | gestor
-- =====================================================================

-- 1. Nova coluna
alter table profiles add column if not exists sector_id text;

-- 2. Backfill: copia o setor que já existe no user_metadata do Auth
update profiles p
set sector_id = u.raw_user_meta_data->>'sector_id'
from auth.users u
where u.id = p.id
  and (p.sector_id is null or p.sector_id = '')
  and u.raw_user_meta_data->>'sector_id' is not null;

-- Depois disto: gerencie o setor de cada usuário direto na Table Editor,
-- coluna "sector_id" da tabela profiles (sem mexer no JSON do Auth).
