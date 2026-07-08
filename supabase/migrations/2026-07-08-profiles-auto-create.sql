-- =====================================================================
-- Cria a linha em profiles automaticamente para cada usuário do Auth
-- 2026-07-08 — Execute UMA vez no SQL Editor do Supabase.
--
-- Depois disto, cadastrar usuário vira: criar no Auth → preencher o
-- sector_id na Table Editor (a linha em profiles nasce sozinha).
-- profiles = (id, name, sector_id).
-- =====================================================================

-- 1. Função: insere o profile quando um usuário é criado no Auth
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, name)
  values (
    new.id,
    coalesce(nullif(new.raw_user_meta_data->>'name', ''), split_part(new.email, '@', 1))
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

-- 2. Trigger no auth.users
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

-- 3. Backfill: cria profiles para usuários do Auth que ainda não têm
insert into public.profiles (id, name)
select u.id, coalesce(nullif(u.raw_user_meta_data->>'name', ''), split_part(u.email, '@', 1))
from auth.users u
left join public.profiles p on p.id = u.id
where p.id is null;
