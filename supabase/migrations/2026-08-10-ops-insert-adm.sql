-- =====================================================================
-- Corrige RLS de INSERT na tabela ops para permitir o ADM
-- Execute no SQL Editor do Supabase
-- =====================================================================
-- O ADM pode criar OPs no front (botão "+ Nova OP" visível para ele),
-- mas a policy anterior só listava 'comercial' e 'gestor', bloqueando
-- o INSERT do ADM com "new row violates row-level security policy".

drop policy if exists ops_insert on ops;

create policy ops_insert on ops
  for insert to authenticated
  with check (public.my_sector() in ('comercial', 'gestor', 'adm'));
