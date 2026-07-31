-- =====================================================================
-- Migração: Foto de perfil (avatar_url)
-- Execute no SQL Editor do Supabase
-- =====================================================================

-- 1. Coluna avatar_url na tabela profiles
alter table profiles
  add column if not exists avatar_url text;

-- 2. Bucket de storage público para avatares
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('avatars', 'avatars', true, 5242880, array['image/jpeg','image/png','image/webp'])
on conflict (id) do nothing;

-- 3. Políticas de storage (DROP + CREATE para evitar deadlock do DO $$ block)

drop policy if exists "avatar_upload" on storage.objects;
create policy "avatar_upload" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "avatar_update" on storage.objects;
create policy "avatar_update" on storage.objects
  for update to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "avatar_read_public" on storage.objects;
create policy "avatar_read_public" on storage.objects
  for select to public
  using (bucket_id = 'avatars');
