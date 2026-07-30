-- =====================================================================
-- Migração: Chat interno + Configurações admin + Logs do sistema
-- Execute no SQL Editor do painel Supabase
-- =====================================================================

-- ─── Chat interno ─────────────────────────────────────────────────
create table if not exists chat_messages (
  id          bigserial primary key,
  op_id       bigint references ops(id) on delete cascade,  -- null = canal geral
  user_id     uuid references auth.users(id),
  user_name   text not null default '',
  user_role   text not null default '',
  content     text not null,
  is_private  boolean not null default false,
  private_to  text,          -- role alvo (mensagem privada)
  created_at  timestamptz not null default now()
);

create index if not exists idx_chat_op_id   on chat_messages (op_id);
create index if not exists idx_chat_created on chat_messages (created_at desc);

alter table chat_messages enable row level security;
create policy "chat_authenticated" on chat_messages
  for all to authenticated using (true) with check (true);

alter publication supabase_realtime add table chat_messages;

-- ─── Configurações do sistema (admin toggles) ─────────────────────
create table if not exists system_config (
  key         text primary key,
  value       text not null,
  updated_at  timestamptz not null default now(),
  updated_by  uuid references auth.users(id)
);

alter table system_config enable row level security;
create policy "config_authenticated" on system_config
  for all to authenticated using (true) with check (true);

alter publication supabase_realtime add table system_config;

insert into system_config (key, value) values
  ('chatEnabled',  'true'),
  ('logsEnabled',  'true'),
  ('exportEnabled','true')
on conflict (key) do nothing;

-- ─── Logs do sistema ──────────────────────────────────────────────
create table if not exists system_logs (
  id          bigserial primary key,
  event_type  text not null,
  user_id     uuid references auth.users(id),
  user_name   text,
  user_role   text,
  op_id       bigint,
  op_numero   text,
  detail      jsonb,
  created_at  timestamptz not null default now()
);

create index if not exists idx_logs_event   on system_logs (event_type);
create index if not exists idx_logs_created on system_logs (created_at desc);
create index if not exists idx_logs_op      on system_logs (op_id);

alter table system_logs enable row level security;
create policy "logs_authenticated" on system_logs
  for all to authenticated using (true) with check (true);
