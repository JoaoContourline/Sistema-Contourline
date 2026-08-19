-- =====================================================================
-- Bucket op-files: público → PRIVADO — 2026-08-19
--
-- ⚠️  RODE ISTO **DEPOIS** DE PUBLICAR O CÓDIGO QUE USA URL ASSINADA.
--     A ordem importa e é segura nos dois sentidos: URL assinada funciona
--     tanto em bucket público quanto privado. Então publique o front, confira
--     que os anexos abrem normalmente, e só então rode este arquivo. Se algo
--     der errado, o rollback no fim volta em um comando.
--
-- PROBLEMA
-- O bucket guarda nota fiscal, comprovante de pagamento e foto de entrega —
-- documentos com CPF/CNPJ, endereço e telefone de cliente. Sendo público, cada
-- anexo tinha uma URL PERMANENTE que dispensa login. O caminho é aleatório, o
-- que dificulta adivinhar, mas as URLs ficam gravadas no jsonb da OP — legível
-- por qualquer usuário autenticado — e nunca expiram: uma vez vazado o link,
-- não havia como revogar. Para uma empresa de equipamento médico lidando com
-- dado pessoal de cliente, é o item de maior exposição do sistema.
--
-- O QUE MUDA
-- O front deixa de embutir a URL pública no HTML. Ele guarda o CAMINHO no
-- bucket e pede uma URL assinada na hora do clique, válida por 1 hora.
-- Aqui o bucket vira privado e a leitura passa a exigir sessão.
--
-- ROLLBACK (volta a ser público na hora):
--   update storage.buckets set public = true where id = 'op-files';
-- =====================================================================

-- 1. Leitura só para autenticado. Sem esta policy, o createSignedUrl passa a
--    falhar depois que o bucket vira privado — e os anexos somem da tela.
drop policy if exists "opfiles_read_auth" on storage.objects;
create policy "opfiles_read_auth" on storage.objects
  for select to authenticated
  using (bucket_id = 'op-files');

-- 2. Upload continua para qualquer autenticado (é o que o app já faz hoje ao
--    anexar comprovante, NF e foto). Declarada aqui para o repositório passar a
--    descrever o estado real do bucket — as policies dele nunca foram versionadas.
drop policy if exists "opfiles_insert_auth" on storage.objects;
create policy "opfiles_insert_auth" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'op-files');

-- 3. A virada. A partir daqui as URLs /object/public/op-files/... param de
--    responder — inclusive as que já estavam gravadas em OPs antigas.
--    O front não usa mais nenhuma delas: o storagePath() extrai o caminho da
--    URL antiga quando o campo `path` não existe, então anexo velho segue
--    abrindo, agora por URL assinada.
update storage.buckets set public = false where id = 'op-files';

-- =====================================================================
-- CONFIRA:
--   select id, public from storage.buckets where id = 'op-files';   -- public = false
--   select policyname, cmd from pg_policies
--   where tablename = 'objects' and schemaname = 'storage'
--     and policyname like 'opfiles%';
--
-- E no app, logado:
--   • abrir uma OP com anexo → miniatura carrega, "Visualizar" e "Baixar" abrem
--   • anexar um arquivo novo → sobe e abre normalmente
--   • conferir uma OP ANTIGA (anexo sem o campo `path`) → tem de abrir também
--
-- Teste da vedação: copie a URL de um anexo e abra numa janela anônima.
--   • antes  → o arquivo abria para qualquer um
--   • agora  → a URL /object/public/... devolve erro; a assinada expira em 1h
-- =====================================================================
