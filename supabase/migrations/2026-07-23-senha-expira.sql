-- =====================================================================
-- Expiração de senha (90 dias) — 2026-07-23
-- Execute UMA vez no SQL Editor do Supabase.
--
-- O Supabase Auth guarda a senha, mas não tem expiração nativa. Guardamos a
-- data da última troca no profiles; o app checa no login e força a troca
-- quando passa de 90 dias. A troca em si é feita pelo próprio usuário (logado),
-- então NÃO precisa de e-mail/código.
-- =====================================================================

-- Data da última troca de senha (default = agora para linhas existentes).
alter table public.profiles
  add column if not exists password_changed_at timestamptz default now();

-- Garante um valor para quem já existe (conta os 90 dias a partir de agora).
update public.profiles set password_changed_at = now() where password_changed_at is null;

-- Obs.: o próprio usuário atualiza name/password_changed_at? Não — o app grava a
-- data via update no profiles com o JWT da sessão. Isso exige uma policy de UPDATE
-- restrita ao dono do registro, e SEM deixar mudar o sector_id (evita escalar
-- para 'adm' sozinho).
drop policy if exists profiles_self_update on public.profiles;
create policy profiles_self_update on public.profiles
  for update to authenticated
  using (id = auth.uid())
  with check (
    id = auth.uid()
    -- não permite trocar o próprio setor nesta policy (mantém o que já está salvo)
    and sector_id = (select p.sector_id from public.profiles p where p.id = auth.uid())
  );
