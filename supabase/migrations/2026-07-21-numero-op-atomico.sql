-- =====================================================================
-- Numeração atômica da OP (evita duas OPs com o mesmo "N/AAAA") — 2026-07-21
-- Execute UMA vez no SQL Editor do Supabase.
--
-- Problema: submitNovaOP lia o MAX do banco e somava 1 no cliente — duas
-- criações simultâneas liam o mesmo MAX e geravam o mesmo número.
-- Solução: uma sequência por ano incrementada atomicamente no servidor,
-- exposta pela função next_op_seq(ano). O front chama via RPC (com fallback
-- para o método antigo enquanto esta migração não estiver aplicada).
-- =====================================================================

create table if not exists op_seq (
  ano int primary key,
  seq int not null default 0
);

-- Semeia com a maior sequência já usada em cada ano (número antes da "/").
insert into op_seq (ano, seq)
select (regexp_match(numero, '/(\d{4})'))[1]::int              as ano,
       max((regexp_match(numero, '^(\d+)/'))[1]::int)          as seq
from ops
where numero ~ '^\d+/\d{4}'
group by 1
on conflict (ano) do update set seq = greatest(op_seq.seq, excluded.seq);

-- Incrementa e devolve o próximo número do ano, de forma atômica.
create or replace function next_op_seq(p_ano int)
returns int
language plpgsql
security definer          -- roda como dono da função → dispensa RLS na op_seq
set search_path = public
as $$
declare v int;
begin
  insert into op_seq (ano, seq) values (p_ano, 1)
  on conflict (ano) do update set seq = op_seq.seq + 1
  returning seq into v;
  return v;
end;
$$;

-- op_seq fechada para acesso direto; só a função (definer) mexe nela.
alter table op_seq enable row level security;

-- Usuários autenticados podem chamar a função (não a tabela).
grant execute on function next_op_seq(int) to authenticated;
