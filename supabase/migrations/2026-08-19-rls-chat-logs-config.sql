-- =====================================================================
-- RLS de chat, logs, configuração e profiles — 2026-08-19
-- Execute UMA vez no SQL Editor do Supabase.
--
-- PROBLEMA QUE ISTO CORRIGE
-- chat_messages, system_config e system_logs foram criadas com a policy
-- guarda-chuva `for all to authenticated using (true) with check (true)`.
-- Como a anon key é pública (está no index.html), "estar logado" é o único
-- requisito para falar direto com a REST do Supabase, fora do app. Na prática:
--
--   1) chat_messages — o filtro de mensagem privada existe SÓ no cliente
--      (o .or(...) do _chatLoadConv). Qualquer funcionário lia todas as DMs
--      da empresa com um único GET.
--   2) system_logs   — qualquer usuário podia APAGAR a trilha de auditoria,
--      ou inserir eventos com o nome de outra pessoa (user_name/user_role
--      vinham do cliente, sem validação).
--   3) system_config — qualquer usuário podia setar logsEnabled=false e
--      desligar o registro de auditoria para todo mundo.
--   4) profiles      — não havia policy de UPDATE para o ADM, então o toggle
--      "liberar chat" do painel admin casava 0 linhas. Sem erro: o app exibia
--      "Chat liberado para o usuário" e nada acontecia.
--
-- Também versiona a policy profiles_read_all, que existe em produção mas foi
-- criada pelo Table Editor e nunca entrou no repositório — o que fazia as
-- migrações divergirem do banco real.
--
-- SEGURO PARA RODAR COM O APP NO AR?
-- Sim. Foi conferido, uma a uma, quais operações o index.html faz nestas
-- tabelas: system_logs (só select + insert), chat_messages (só select +
-- insert), system_config (select + upsert), profiles (updates do próprio
-- usuário + o toggle de chat do ADM). Nada que o app faz hoje deixa de
-- funcionar; o que some é o acesso por fora dele.
--
-- ROLLBACK (volta ao estado anterior, permissivo):
--   drop policy if exists chat_select   on chat_messages;
--   drop policy if exists chat_insert   on chat_messages;
--   create policy "chat_authenticated" on chat_messages
--     for all to authenticated using (true) with check (true);
--   drop policy if exists config_read   on system_config;
--   drop policy if exists config_insert on system_config;
--   drop policy if exists config_update on system_config;
--   create policy "config_authenticated" on system_config
--     for all to authenticated using (true) with check (true);
--   drop policy if exists logs_insert on system_logs;
--   drop policy if exists logs_read   on system_logs;
--   create policy "logs_authenticated" on system_logs
--     for all to authenticated using (true) with check (true);
--   drop policy if exists profiles_admin_update on profiles;
-- =====================================================================

-- ── 1. chat_messages ─────────────────────────────────────────────────
drop policy if exists "chat_authenticated" on chat_messages;
drop policy if exists chat_select on chat_messages;
drop policy if exists chat_insert on chat_messages;

-- Leitura: mensagem de OP (canal da OP) e canal geral seguem públicas para os
-- autenticados — é o comportamento atual. DM só para remetente e destinatário.
-- private_to guarda o UUID do destinatário como text (o app grava assim).
create policy chat_select on chat_messages
  for select to authenticated
  using (
    op_id is not null
    or (op_id is null and is_private = false)
    or user_id = auth.uid()
    or private_to = auth.uid()::text
  );

-- Escrita: só em nome de si mesmo. Fecha a forja de mensagem com o nome de
-- outra pessoa (user_name/user_role continuam vindo do cliente, mas agora
-- ficam amarrados ao user_id autenticado).
create policy chat_insert on chat_messages
  for insert to authenticated
  with check (user_id = auth.uid());

-- Sem policy de UPDATE/DELETE = negado. O app nunca edita nem apaga mensagem.

-- ── 2. system_config ─────────────────────────────────────────────────
drop policy if exists "config_authenticated" on system_config;
drop policy if exists config_read   on system_config;
drop policy if exists config_insert on system_config;
drop policy if exists config_update on system_config;

-- Todos leem (o app checa chatEnabled/exportEnabled no boot de qualquer setor).
create policy config_read on system_config
  for select to authenticated
  using (true);

-- Só o ADM escreve. saveSysConfig() usa upsert, por isso as duas policies.
create policy config_insert on system_config
  for insert to authenticated
  with check (public.my_sector() = 'adm');

create policy config_update on system_config
  for update to authenticated
  using (public.my_sector() = 'adm')
  with check (public.my_sector() = 'adm');

-- ── 3. system_logs ───────────────────────────────────────────────────
drop policy if exists "logs_authenticated" on system_logs;
drop policy if exists logs_insert on system_logs;
drop policy if exists logs_read   on system_logs;

-- Cada um só registra evento em seu próprio nome.
create policy logs_insert on system_logs
  for insert to authenticated
  with check (user_id = auth.uid());

-- Leitura restrita a quem audita (o painel de logs é do ADM).
create policy logs_read on system_logs
  for select to authenticated
  using (public.my_sector() in ('adm', 'gestor'));

-- Sem policy de UPDATE/DELETE = negado, para TODOS (inclusive ADM).
-- Trilha de auditoria que o auditado consegue apagar não é trilha de auditoria.
-- Expurgo, se um dia precisar, roda pelo service_role (que ignora RLS).

-- ── 4. profiles ──────────────────────────────────────────────────────
-- Versiona a policy que já existe em produção (criada pelo Table Editor).
-- O app depende dela: a lista de contatos do chat e o painel admin fazem
-- select em profiles de OUTROS usuários.
drop policy if exists profiles_read_all on profiles;
create policy profiles_read_all on profiles
  for select to authenticated
  using (true);

-- UPDATE pelo ADM: é o que faz o toggle "liberar chat" do painel admin
-- realmente gravar. Sem isto ele casa 0 linhas e finge sucesso.
-- Nota: isto também permite ao ADM alterar sector_id de terceiros. Não é
-- escalação nova — o ADM já redefine a senha de qualquer conta pela
-- /api/admin-reset-senha (service_role).
drop policy if exists profiles_admin_update on profiles;
create policy profiles_admin_update on profiles
  for update to authenticated
  using (public.my_sector() = 'adm')
  with check (public.my_sector() = 'adm');

-- =====================================================================
-- DEPOIS DE RODAR, CONFIRA:
--   select tablename, policyname, cmd, qual, with_check from pg_policies
--   where tablename in ('profiles','chat_messages','system_config','system_logs')
--   order by tablename, policyname;
--
-- E teste no app, logado como NÃO-adm:
--   • o chat abre e lista contatos            → profiles_read_all
--   • envia e recebe DM                        → chat_select + chat_insert
--   • o painel Admin não é acessível           → já era restrito no front
-- Logado como ADM:
--   • o toggle de chat de outro usuário PERSISTE após F5  → profiles_admin_update
--   • os toggles de sistema salvam             → config_update
--   • a aba de logs lista eventos              → logs_read
-- =====================================================================
