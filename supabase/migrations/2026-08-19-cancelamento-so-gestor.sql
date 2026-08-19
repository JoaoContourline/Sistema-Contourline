-- =====================================================================
-- Cancelar / reativar OP: exclusivo do GESTOR — 2026-08-19
-- Execute UMA vez no SQL Editor do Supabase.
--
-- POR QUE UM TRIGGER E NÃO UMA POLICY
-- Cancelar não é uma operação própria: é um UPDATE que passa a gravar
-- data->'cancelada'. Reativar é o mesmo UPDATE removendo a chave. Para
-- distinguir "cancelou" de "alterou qualquer outra coisa" é preciso comparar
-- a linha ANTIGA com a NOVA — e o `with check` de uma policy só enxerga a
-- linha nova. Daí o BEFORE UPDATE trigger.
--
-- O QUE MUDA
-- Antes, o botão "Cancelar OP" aparecia para QUALQUER setor, e a ops_update
-- deixava passar o dono da etapa atual (além de gestor e adm). Na prática:
--   • o dono da etapa cancelava de verdade, sem ser gestor;
--   • os demais setores viam a OP sumir da própria tela e ela continuava
--     viva para todo mundo, porque a RLS recusava em silêncio.
-- Agora o Postgres recusa com mensagem explícita, e o front só oferece o
-- botão ao gestor.
--
-- ATENÇÃO — ISTO INCLUI O ADM. Conforme combinado ("só gestor pode cancelar
-- op"), o setor adm também é bloqueado. Se a intenção era manter o ADM,
-- troque a comparação por:  not in ('gestor', 'adm')
--
-- ROLLBACK:
--   drop trigger if exists ops_bloqueia_cancelamento on ops;
--   drop function if exists public.bloqueia_cancelamento();
-- =====================================================================

create or replace function public.bloqueia_cancelamento()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Sem usuário autenticado = SQL Editor, service_role, cron ou migração.
  -- Não bloqueia: manutenção pelo banco continua possível.
  if auth.uid() is null then
    return new;
  end if;

  -- Só reage quando o campo 'cancelada' muda — cancelar OU reativar.
  -- Qualquer outro UPDATE na OP segue governado apenas pela policy ops_update.
  if (new.data -> 'cancelada') is distinct from (old.data -> 'cancelada') then
    if coalesce(public.my_sector(), '') <> 'gestor' then
      raise exception
        'Somente o setor gestor pode cancelar ou reativar uma OP (seu setor: %)',
        coalesce(nullif(public.my_sector(), ''), 'indefinido')
        using errcode = '42501';   -- insufficient_privilege
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists ops_bloqueia_cancelamento on ops;
create trigger ops_bloqueia_cancelamento
  before update on ops
  for each row execute function public.bloqueia_cancelamento();

-- =====================================================================
-- DEPOIS DE RODAR, CONFIRA:
--   select tgname, tgenabled from pg_trigger
--   where tgrelid = 'ops'::regclass and not tgisinternal;
--
-- Teste no app:
--   • logado como logística/fiscal/financeiro/comercial → o botão "Cancelar OP"
--     não aparece mais no modal da OP
--   • logado como gestor → cancela e reativa normalmente
--
-- Diferente da recusa por RLS (que devolve 0 linhas em silêncio), este trigger
-- levanta ERRO. O supabase-js entrega isso como `error`, e a dbSaveOp já trata
-- esse caminho: desfaz a alteração pelo snapshot e mostra o motivo na tela.
-- =====================================================================
