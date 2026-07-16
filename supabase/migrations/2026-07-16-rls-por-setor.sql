-- =====================================================================
-- RLS por setor — 2026-07-16
-- Execute UMA vez no SQL Editor do Supabase.
--
-- PROBLEMA QUE ISTO CORRIGE
-- A policy anterior era:
--     create policy "ops_all_access" on ops for all to authenticated
--       using (true) with check (true);
-- "for all" + "using(true)" = QUALQUER usuário logado, de qualquer setor, podia
-- ler, alterar e APAGAR todas as OPs chamando a REST do Supabase direto, fora do
-- app. O controle por setor existia só no JavaScript (step.owner === user.role),
-- que é enfeite: o Postgres aceitava tudo.
--
-- SEGURO PARA RODAR COM O APP NO AR?
-- Sim, com uma ressalva: leitura continua liberada para todos os autenticados
-- (o app precisa disso — a aba "Todas as OPs" e o Realtime mostram tudo).
-- O que muda é a ESCRITA, que passa a exigir que o setor do usuário seja o dono
-- da etapa atual — exatamente a regra que o front já aplica hoje. Ou seja: quem
-- usa o sistema normalmente não sente diferença.
--
-- ROLLBACK (se algo quebrar):
--   drop policy if exists ops_select on ops;
--   drop policy if exists ops_insert on ops;
--   drop policy if exists ops_update on ops;
--   create policy "ops_all_access" on ops for all to authenticated
--     using (true) with check (true);
-- =====================================================================

-- ── 1. Setor do usuário logado ───────────────────────────────────────
-- security definer para não recursar na RLS de profiles.
create or replace function public.my_sector()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select sector_id from public.profiles where id = auth.uid()
$$;

revoke execute on function public.my_sector() from anon;
grant  execute on function public.my_sector() to authenticated;

-- ── 2. Qual setor é dono de cada etapa ───────────────────────────────
-- Espelha o objeto STEPS do index.html. Se o fluxo mudar lá, mude aqui.
create or replace function public.sector_of_status(s text)
returns text
language sql
immutable
as $$
  select case s
    when 'aberta'            then 'comercial'
    when 'aguard_financeiro' then 'financeiro'
    when 'bloqueada'         then 'financeiro'
    when 'aguard_nf'         then 'logistica'
    when 'aguard_emissao'    then 'fiscal'
    when 'aguard_despacho'   then 'logistica'
    when 'transito'          then 'logistica'
    when 'entregue'          then null
  end
$$;

-- ── 3. Policies ──────────────────────────────────────────────────────
drop policy if exists "ops_all_access" on ops;
drop policy if exists ops_select on ops;
drop policy if exists ops_insert on ops;
drop policy if exists ops_update on ops;

-- Leitura: todo autenticado vê tudo (o app depende disso hoje).
create policy ops_select on ops
  for select to authenticated
  using (true);

-- Criação: só comercial e gestor abrem OP.
create policy ops_insert on ops
  for insert to authenticated
  with check (public.my_sector() in ('comercial', 'gestor'));

-- Alteração: só o setor dono da etapa ATUAL (o mesmo gate do front), ou gestor.
-- O fiscal também precisa escrever em aguard_financeiro por causa do Simples
-- Faturamento (side-channel do fluxo), por isso a exceção explícita.
create policy ops_update on ops
  for update to authenticated
  using (
    public.my_sector() = 'gestor'
    or public.my_sector() = public.sector_of_status(status)
    or (status = 'aguard_financeiro' and public.my_sector() = 'fiscal')
  )
  with check (true);

-- DELETE: nenhuma policy = negado para todos.
-- O app nunca apaga OP (não há .delete() no index.html), então isto não tira
-- nenhuma funcionalidade — só fecha uma capacidade destrutiva que estava aberta
-- para todo funcionário. Se algum dia precisar, crie uma policy só para gestor.

-- ── 4. profiles: fecha a escalação de privilégio ─────────────────────
-- A tabela nunca foi versionada (foi criada pelo Table Editor), então a RLS dela
-- era desconhecida. Sem isto, um usuário poderia alterar o PRÓPRIO sector_id e
-- virar 'gestor' — e agora que my_sector() vale dinheiro, isso seria grave.
alter table public.profiles enable row level security;

drop policy if exists profiles_self_read on profiles;
create policy profiles_self_read on profiles
  for select to authenticated
  using (id = auth.uid());

-- Sem policy de insert/update/delete = negado.
-- O setor é atribuído pela Table Editor (service_role ignora RLS), e o trigger
-- handle_new_user roda como security definer — ambos seguem funcionando.

-- ── 5. protheus_clientes: base de clientes exigia só a anon key ──────
-- A anon key está publicada no index.html, então esta tabela (CPF/CNPJ, nome,
-- endereço) estava legível por qualquer um na internet, sem login.
alter table public.protheus_clientes enable row level security;

drop policy if exists protheus_clientes_read on protheus_clientes;
create policy protheus_clientes_read on protheus_clientes
  for select to authenticated
  using (true);

-- Escrita: sem policy = só o service_role (usado pelo cron de sync). Isso também
-- fecha o envenenamento de cache (antes dava para inserir cliente falso anônimo).
--
-- ATENÇÃO: o index.html lê/grava esta tabela com a anon key CRUA em vez do JWT
-- da sessão. Ver a nota no fim deste arquivo.

-- =====================================================================
-- DEPOIS DE RODAR, VERIFIQUE:
--   select * from pg_policies where tablename in ('ops','profiles','protheus_clientes');
--
-- E no Dashboard → Authentication → Providers → Email:
--   desligue "Allow new users to sign up" (usuários são criados pelo admin).
--   Com signup aberto, qualquer um cria conta e vira 'authenticated'.
-- =====================================================================
