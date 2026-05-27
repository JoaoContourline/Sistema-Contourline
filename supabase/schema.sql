-- =====================================================================
-- Monitor de OPs Contourline — Supabase Schema
-- Execute no SQL Editor do painel Supabase
-- =====================================================================

-- Tabela principal de Ordens de Pedido
create table if not exists ops (
  id         bigserial primary key,
  numero     text,
  cliente    text,
  status     text not null default 'aberta',
  data       jsonb not null,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- Índices para consultas frequentes
create index if not exists idx_ops_status     on ops (status);
create index if not exists idx_ops_cliente    on ops (cliente);
create index if not exists idx_ops_created    on ops (created_at desc);
create index if not exists idx_ops_data_gin   on ops using gin (data);

-- Trigger para atualizar updated_at automaticamente
create or replace function set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists ops_updated_at on ops;
create trigger ops_updated_at
  before update on ops
  for each row execute procedure set_updated_at();

-- Row Level Security — acesso total via anon key (aplicativo interno)
alter table ops enable row level security;

drop policy if exists "ops_all_access" on ops;
create policy "ops_all_access" on ops
  for all
  using (true)
  with check (true);

-- Habilitar Realtime para a tabela ops
alter publication supabase_realtime add table ops;
