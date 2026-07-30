-- =====================================================================
-- Chat por usuário: coluna chat_enabled na tabela profiles
-- Execute no SQL Editor do Supabase
-- =====================================================================

alter table profiles
  add column if not exists chat_enabled boolean not null default false;
