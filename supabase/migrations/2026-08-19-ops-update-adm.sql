-- =====================================================================
-- ops_update: incluir o setor ADM — 2026-08-19
-- Execute UMA vez no SQL Editor do Supabase.
--
-- PROBLEMA QUE ISTO CORRIGE
-- A migração 2026-08-10-ops-insert-adm.sql percebeu que o ADM cria OPs no
-- front e corrigiu a policy de INSERT. Mas o ADM também ALTERA OPs — e a
-- ops_update, escrita em 2026-07-16, nunca recebeu o 'adm'.
--
-- Efeito prático observado na OP id=94 (criada por um ADM em 19/08/2026):
--   O submitNovaOP faz INSERT e, logo depois, um UPDATE para gravar o número
--   sequencial, o id e o pedidoProtheus. O INSERT passou; o UPDATE foi
--   recusado pela RLS. A linha ficou com:
--       numero = NULL · data.numero = 'PENDENTE' · data.id = 0
--       data.pedidoProtheus = undefined  (perdeu o vínculo com o PV)
--   Como a RLS recusa devolvendo 0 linhas sem erro, o app não percebeu nada.
--   Na tela a OP nasceu certa ("OP 16/2026 · PV 002833"); no F5 seguinte
--   virou "#94", renumerada pelo repair do loadOps e sem o PV.
--
-- Sem esta policy, TODA OP criada por um ADM nasce sem número, e o ADM
-- também não consegue avançar etapa nenhuma no fluxo.
--
-- ROLLBACK:
--   drop policy if exists ops_update on ops;
--   create policy ops_update on ops
--     for update to authenticated
--     using (
--       public.my_sector() = 'gestor'
--       or public.my_sector() = public.sector_of_status(status)
--       or (status = 'aguard_financeiro' and public.my_sector() = 'fiscal')
--     )
--     with check (true);
-- =====================================================================

drop policy if exists ops_update on ops;

create policy ops_update on ops
  for update to authenticated
  using (
    public.my_sector() in ('gestor', 'adm')          -- adm: visão e ação completas
    or public.my_sector() = public.sector_of_status(status)
    or (status = 'aguard_financeiro' and public.my_sector() = 'fiscal')
  )
  with check (true);

-- ── Conserto das OPs que já nasceram sem número ──────────────────────
-- Roda como dono da migração (o SQL Editor ignora RLS), então corrige as
-- linhas órfãs de uma vez. Usa o MAX da sequência do ano, não a contagem.
do $$
declare
  r        record;
  v_ano    int;
  v_seq    int;
  v_numero text;
begin
  for r in
    select id, data, coalesce(data->>'dataAbertura', to_char(created_at, 'YYYY-MM-DD')) as abertura
    from ops
    where numero is null or numero = '' or data->>'numero' = 'PENDENTE'
    order by id
  loop
    v_ano := coalesce(nullif(left(r.abertura, 4), '')::int, extract(year from now())::int);

    -- Próximo número do ano pela sequência atômica (a mesma que o app usa),
    -- para não colidir com nenhum número já emitido.
    v_seq := public.next_op_seq(v_ano);
    v_numero := v_seq || '/' || v_ano;
    if coalesce(r.data->>'pedidoProtheus', '') <> '' then
      v_numero := v_numero || ' - PV ' || (r.data->>'pedidoProtheus');
    end if;

    update ops
       set numero = v_numero,
           data   = jsonb_set(
                      jsonb_set(r.data, '{numero}', to_jsonb(v_numero), true),
                      '{id}', to_jsonb(r.id), true)
     where id = r.id;

    raise notice 'OP id=% renumerada para %', r.id, v_numero;
  end loop;
end $$;

-- =====================================================================
-- ATENÇÃO — a OP id=94 (FABIA VALENTE DERMATOLOGIA) precisa de um ajuste
-- manual, por dois motivos que o bloco acima não tem como adivinhar:
--
--   1) Ela perdeu o campo pedidoProtheus no UPDATE recusado, então não há
--      como saber que o pedido era o 002833.
--   2) O número 16/2026 foi CONSUMIDO e perdido: no código antigo o
--      next_op_seq() era chamado depois do insert, devolveu 16, e o UPDATE
--      que gravaria esse 16 falhou. A sequência já está em 16, então o bloco
--      acima daria 17/2026 a ela. Como o 16 está livre (as demais OPs de 2026
--      vão até 14), o certo é devolver o número que ela mostrou na tela.
--
-- APLICADO EM 19/08/2026: o bloco do-$$ acima rodou primeiro e deu a ela o
-- número 17/2026 (o 16 já tinha sido consumido pelo next_op_seq na criação).
-- Optou-se por MANTER o 17 — renomear para 16 só mudaria qual número fica com
-- buraco — e apenas religar o PV, com:
--
--   update ops
--      set numero = '17/2026 - PV 002833',
--          data   = jsonb_set(
--                     jsonb_set(data, '{numero}', '"17/2026 - PV 002833"', true),
--                     '{pedidoProtheus}', '"002833"', true)
--    where id = 94;
--
-- (O bloco do-$$ já gravou data.id = 94, então não precisa repetir aqui.)
--
-- Confira depois:
--   select id, numero, data->>'numero', data->>'pedidoProtheus' from ops
--   where numero is null or data->>'numero' = 'PENDENTE';   -- deve vir vazio
-- =====================================================================
