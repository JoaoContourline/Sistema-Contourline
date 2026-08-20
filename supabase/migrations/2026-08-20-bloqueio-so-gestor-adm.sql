-- =====================================================================
-- Bloquear OP: exclusivo de GESTOR e ADM — 2026-08-20
-- Execute UMA vez no SQL Editor do Supabase.
--
-- Pré-requisito: 2026-08-19-cancelamento-so-gestor.sql (esta migração
-- substitui a mesma função, acrescentando a segunda regra).
--
-- POR QUE
-- O financeiro tinha o botão "Bloquear OP" na própria fila. Aprovar ou não
-- aprovar o pagamento é dele; travar a OP é decisão de quem manda no fluxo.
-- Agora só gestor e ADM bloqueiam.
--
-- POR QUE NA MESMA FUNÇÃO DO CANCELAMENTO
-- É o mesmo tipo de regra: "esta transição específica exige um papel", e
-- depende de comparar a linha ANTIGA com a NOVA — o `with check` de uma policy
-- só enxerga a nova. Manter as duas regras numa função só evita dois triggers
-- disputando o mesmo UPDATE.
--
-- OBSERVAÇÃO
-- Ninguém perde acesso a OP nenhuma: no momento desta migração não há OP em
-- 'bloqueada' e nenhuma passou por bloqueio no histórico. Desbloquear (voltar
-- de 'bloqueada' para 'aguard_financeiro') continua com o financeiro, que é o
-- dono da etapa — quem destrava é quem confirma que o pagamento entrou.
--
-- ROLLBACK: recria a função só com a regra de cancelamento.
--   (o corpo anterior está em 2026-08-19-cancelamento-so-gestor.sql)
-- =====================================================================

create or replace function public.bloqueia_cancelamento()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  setor text;
begin
  -- Sem usuário autenticado = SQL Editor, service_role, cron ou migração.
  -- Não bloqueia: manutenção pelo banco continua possível.
  if auth.uid() is null then
    return new;
  end if;

  setor := coalesce(public.my_sector(), '');

  -- 1. Cancelar ou reativar: só gestor.
  if (new.data -> 'cancelada') is distinct from (old.data -> 'cancelada') then
    if setor <> 'gestor' then
      raise exception
        'Somente o setor gestor pode cancelar ou reativar uma OP (seu setor: %)',
        coalesce(nullif(setor, ''), 'indefinido')
        using errcode = '42501';
    end if;
  end if;

  -- 2. Bloquear: só gestor e ADM. Desbloquear (sair de 'bloqueada') NÃO passa
  --    por aqui de propósito — é o financeiro que destrava, ao confirmar o
  --    pagamento.
  if new.status = 'bloqueada' and old.status is distinct from 'bloqueada' then
    if setor not in ('gestor', 'adm') then
      raise exception
        'Somente gestor e ADM podem bloquear uma OP (seu setor: %)',
        coalesce(nullif(setor, ''), 'indefinido')
        using errcode = '42501';
    end if;
  end if;

  return new;
end;
$$;

-- O trigger já existe desde 2026-08-19 e aponta para esta função; recriado
-- aqui para o arquivo ser aplicável sozinho num banco novo.
drop trigger if exists ops_bloqueia_cancelamento on ops;
create trigger ops_bloqueia_cancelamento
  before update on ops
  for each row execute function public.bloqueia_cancelamento();

-- =====================================================================
-- CONFIRA no app:
--   • financeiro → a OP em Validação Financeira não mostra mais "Bloquear OP";
--     "Confirmar Pagamento" continua normal
--   • gestor / ADM → "Bloquear OP" aparece no rodapé do modal da OP
--   • uma OP bloqueada volta para validação pelo financeiro, como antes
-- =====================================================================
