-- =====================================================================
-- Logística pode anexar comprovante em OP já ENTREGUE — 2026-08-19
-- Execute UMA vez no SQL Editor do Supabase.
--
-- PROBLEMA
-- O botão "Anexar Fotos" aparece para a logística sempre que a OP já passou
-- por trânsito — inclusive depois de entregue, que é justamente quando a foto
-- do canhoto costuma chegar. Só que sector_of_status('entregue') devolve NULL,
-- então nenhum braço da policy ops_update casava e o UPDATE era recusado.
--
-- Até hoje isso era pior do que parece: a RLS recusa devolvendo 0 linhas sem
-- erro, e a dbSaveOp exibia "Salvo". A foto sumia no F5 seguinte, calada. A
-- correção da dbSaveOp (commit 3278238) já transformou isso em erro visível;
-- esta migração libera o caso, que é legítimo.
--
-- ESCOPO
-- Apenas o setor logistica, apenas em OPs com status 'entregue'. Nenhum outro
-- setor ganha nada, e a etapa 'entregue' continua fechada para os demais.
--
-- ROLLBACK: recria a policy sem o último braço.
--   drop policy if exists ops_update on ops;
--   create policy ops_update on ops for update to authenticated
--     using (
--       public.my_sector() in ('gestor', 'adm')
--       or public.my_sector() = public.sector_of_status(status)
--       or (status = 'aguard_financeiro' and public.my_sector() = 'fiscal')
--     ) with check (true);
-- =====================================================================

drop policy if exists ops_update on ops;

create policy ops_update on ops
  for update to authenticated
  using (
    public.my_sector() in ('gestor', 'adm')                                -- visão e ação completas
    or public.my_sector() = public.sector_of_status(status)                -- dono da etapa atual
    or (status = 'aguard_financeiro' and public.my_sector() = 'fiscal')    -- side-channel do Simples Faturamento
    or (status = 'entregue'          and public.my_sector() = 'logistica') -- comprovante que chega depois
  )
  with check (true);

-- Cancelar/reativar segue exclusivo do gestor: quem garante isso é o trigger
-- ops_bloqueia_cancelamento (migração 2026-08-19-cancelamento-so-gestor.sql),
-- que roda em cima desta policy. Liberar a logística em 'entregue' NÃO permite
-- que ela cancele nada.

-- =====================================================================
-- CONFIRA:
--   select policyname, cmd, qual from pg_policies
--   where tablename = 'ops' and policyname = 'ops_update';
--
-- Teste: como logística, abra uma OP entregue → "Anexar Fotos" → salvar → F5.
-- A foto tem de continuar lá.
-- =====================================================================
