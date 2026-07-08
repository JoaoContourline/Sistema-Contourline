-- =====================================================================
-- Migração de segurança — 2026-07-08
-- Execute UMA vez no SQL Editor do Supabase (produção).
--
-- O que faz:
--   1) Restringe a tabela `ops` a usuários AUTENTICADOS.
--      Antes: policy liberada para o role `anon`. Como a anon key é
--      pública (embutida no index.html), qualquer pessoa conseguia
--      ler/alterar/apagar todas as OPs via REST sem passar pelo login.
--   2) Remove a tabela `usuarios` (senhas em texto puro, leitura
--      liberada). Não é usada — o login usa Supabase Auth + profiles.
--
-- Seguro para o app: todo acesso a `ops` no front usa o cliente
-- supabase-js já autenticado (JWT do usuário logado), então continua
-- funcionando. A tabela `protheus_clientes` NÃO é alterada.
-- =====================================================================

-- 1. ops → apenas autenticados
drop policy if exists "ops_all_access" on ops;
create policy "ops_all_access" on ops
  for all
  to authenticated
  using (true)
  with check (true);

-- 2. usuarios → tabela legada, remover
drop table if exists usuarios cascade;
