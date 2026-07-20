-- =====================================================================
-- Tabela ROTAS — planejador de entregas da logística — 2026-07-16
-- Execute UMA vez no SQL Editor do Supabase.
--
-- Uma rota = um motorista/carro/placa + uma lista de paradas:
--   { tipo:'entregar', opId, ... }  → entrega de uma OP ao cliente
--   { tipo:'buscar',   item, endereco } → coleta manual (sem OP)
-- Guardada em `data` (jsonb), no mesmo padrão da tabela `ops`.
-- =====================================================================

create table if not exists rotas (
  id         bigserial primary key,
  data       jsonb not null default '{}',
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- Reusa a função set_updated_at() já criada para a tabela ops.
drop trigger if exists rotas_updated_at on rotas;
create trigger rotas_updated_at
  before update on rotas
  for each row execute procedure set_updated_at();

-- RLS: acesso para usuários autenticados (mesmo padrão de ops).
alter table rotas enable row level security;
drop policy if exists rotas_all on rotas;
create policy rotas_all on rotas
  for all to authenticated
  using (true) with check (true);

-- Realtime para a tabela rotas.
alter publication supabase_realtime add table rotas;
