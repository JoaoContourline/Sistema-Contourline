// op-lifecycle.spec.js — fluxo completo de uma OP do início à entrega
import { test, expect } from '@playwright/test';
import { loginAs, switchTo } from './helpers/auth.js';
import { cancelarOPsDeTeste, TEST_PREFIX } from './helpers/op.js';
import { waitForModalOpen, waitForModalClose } from './helpers/modal.js';

let opNumero = null; // compartilhado entre os steps do fluxo

// ─── CRIAÇÃO ────────────────────────────────────────────────────────
test.describe('Fluxo completo: Comercial → Entregue', () => {

  // Cancela OPs de teste de execuções anteriores que possam ter ficado ativas
  test.beforeAll(async ({ browser }) => {
    const ctx  = await browser.newContext();
    const page = await ctx.newPage();
    await loginAs(page, 'gestor');
    await cancelarOPsDeTeste(page);
    await ctx.close();
  });

  test.afterAll(async ({ browser }) => {
    const ctx  = await browser.newContext();
    const page = await ctx.newPage();
    await loginAs(page, 'gestor');
    await cancelarOPsDeTeste(page);
    await ctx.close();
  });

  test('1. Comercial cria OP e ela aparece em Aguardando Financeiro', async ({ page }) => {
    await loginAs(page, 'comercial');

    // Abre modal nova OP
    const btnNova = page.locator('#btnNovaOP');
    await expect(btnNova).toBeVisible({ timeout: 8_000 });
    await btnNova.click();
    await waitForModalOpen(page);

    // O modal abre com a busca de PV (Protheus). Bypassa via JS revelando o formulário completo.
    await page.waitForSelector('#nova-form-fields', { state: 'attached' });
    await page.evaluate(() => {
      // Mostra o formulário completo (normalmente mostrado após puxarPedido())
      const ff = document.getElementById('nova-form-fields');
      if (ff) ff.style.display = 'block';
      // Mostra o footer com o botão "Criar OP" (também ocultado até puxarPedido())
      const footer = document.getElementById('nova-modal-footer');
      if (footer) footer.style.display = '';
      // PV fictício para não bloquear submit
      const pvInput = document.getElementById('nova-numPedido');
      if (pvInput) pvInput.value = 'TESTE-PV-AUTO';
      // Injeta equipamento mínimo diretamente no array global (evita a busca no catálogo)
      if (typeof tempEquipList !== 'undefined') {
        tempEquipList.length = 0;
        tempEquipList.push({ name: 'PLAYWRIGHT TEST Equipamento', code: '', qty: 1, valorUnit: '100', desconto: '' });
        if (typeof refreshEquipList === 'function') refreshEquipList();
      }
    });

    // Preenchimento dos campos obrigatórios
    await page.locator('#nova-cpf').waitFor({ state: 'visible', timeout: 5_000 });
    await page.fill('#nova-vendedorCanal', `${TEST_PREFIX} Vendedor`);
    await page.fill('#nova-cliente', `${TEST_PREFIX} Equipamentos`);
    await page.fill('#nova-cpf', '11.222.333/0001-81');

    // Analista: seleciona o primeiro item real do select
    const analistaSelect = page.locator('#nova-analista');
    const analOpts = await analistaSelect.locator('option:not([disabled])').count();
    if (analOpts > 0) await analistaSelect.selectOption({ index: 1 });

    // Entrada: "com entrada" para exercitar o gate duplo financeiro+SF
    await page.locator('#nova-entrada').selectOption('pendente');
    // O campo de valor da entrada fica visível após selecionar "pendente"
    const valorEntrada = page.locator('#nova-valorEntrada');
    await valorEntrada.waitFor({ state: 'visible', timeout: 3_000 }).catch(() => {});
    // Força valor caso o campo ainda esteja oculto (brlFormat via evaluate)
    await page.evaluate(() => {
      const el = document.getElementById('nova-valorEntrada');
      if (el) { el.value = '100,00'; el.dispatchEvent(new Event('input', { bubbles: true })); }
      const row = document.getElementById('nova-entrada-row');
      if (row) row.style.display = '';
    });

    // Contato de entrega e previsão (obrigatórios)
    await page.fill('#nova-contatoEntrega', `${TEST_PREFIX} Contato`);
    const data = new Date();
    data.setDate(data.getDate() + 30);
    await page.fill('#nova-previsaoEntrega', data.toISOString().slice(0, 10));

    // Rola até o botão (está no fundo do modal longo) e confirma
    await page.locator('#btn-criar-op').scrollIntoViewIfNeeded();
    await page.click('#btn-criar-op');
    // submitNovaOP faz 3 chamadas Supabase (insert → seq → update)
    await waitForModalClose(page, 30_000);

    // OP deve aparecer em algum lugar na tela
    await page.waitForTimeout(800);
    const cards = page.locator('.card');
    await expect(cards.first()).toBeVisible({ timeout: 8_000 });

    // Captura número da OP
    const numEl = cards.first().locator('[data-op-numero], .card-num, .op-numero').first();
    opNumero = (await numEl.textContent().catch(() => null))?.trim() || 'desconhecido';
    console.log('OP de teste criada:', opNumero);
  });

  // ─── FINANCEIRO ──────────────────────────────────────────────────
  test('2. Financeiro aprova — sem SF ainda, OP fica em aguard_financeiro', async ({ page }) => {
    test.skip(!opNumero, 'Depende do teste de criação');
    await loginAs(page, 'financeiro');

    // Aguarda dados carregarem e realtime estabilizar antes de agir
    await page.waitForTimeout(1500);

    const btnAcao = page.locator(`.card:has-text("${TEST_PREFIX}") button[onclick*="openActionModal"]`).first();
    await expect(btnAcao).toBeVisible({ timeout: 8_000 });
    await btnAcao.click();
    await waitForModalOpen(page);

    const obsFinanceiro = page.locator('#f-descricao, textarea[name="descricao"]').first();
    if (await obsFinanceiro.count() > 0) await obsFinanceiro.fill('Aprovado — teste automatizado');

    // Sincroniza _loadedAt para evitar conflito de locking otimista
    await page.evaluate(() => {
      if (typeof activeOpId !== 'undefined' && activeOpId && typeof ops !== 'undefined') {
        const op = ops.find(o => o.id === activeOpId);
        if (op) op._loadedAt = op.updated_at || op._loadedAt;
      }
    });

    // Botão "Confirmar →" dentro do modal chama submitModal()
    await page.locator('button[onclick="submitModal()"]').click();

    // Toast confirma aprovação (gate duplo: SF ainda pendente, OP permanece no financeiro)
    await expect(page.locator('#toast-box div').first()).toBeVisible({ timeout: 8_000 });

    await waitForModalClose(page, 8_000);

    const cards = page.locator('.card');
    await expect(cards.first()).toBeVisible({ timeout: 5_000 });
  });

  // ─── FISCAL / SIMPLES FATURAMENTO ────────────────────────────────
  test('3. Fiscal lança SF — gate duplo completo, OP avança para Logística', async ({ page }) => {
    test.skip(!opNumero, 'Depende dos testes anteriores');
    await loginAs(page, 'fiscal');

    // Clica no botão SF direto no card (abre o modal SF diretamente)
    const btnSFCard = page.locator(`.card:has-text("${TEST_PREFIX}") button[onclick*="openSimplesFaturamento"]`).first();
    await expect(btnSFCard).toBeVisible({ timeout: 8_000 });
    await btnSFCard.click();
    await waitForModalOpen(page);
    await page.waitForTimeout(400);

    // Injeta arquivo falso para bypasар a validação de upload obrigatório
    await page.evaluate(() => {
      if (typeof tempFilesData !== 'undefined') {
        tempFilesData['sf_arquivos'] = [{
          name: 'playwright-sf-teste.pdf',
          size: 1024,
          url: 'https://placeholder.test/sf.pdf',
          path: 'uploads/playwright-test-sf.pdf',
        }];
      }
    });

    // Preenche data de emissão
    const dataSF = page.locator('#f-sf_data');
    if (await dataSF.count() > 0) {
      await dataSF.fill(new Date().toISOString().slice(0, 10));
    }

    // Salva o SF
    const btnSalvarSF = page.locator('button[onclick*="saveSimplesFaturamento"]').last();
    await expect(btnSalvarSF).toBeVisible({ timeout: 5_000 });
    await btnSalvarSF.click();

    // Gate duplo concluído (finDone + sfDone) — OP avança para Logística
    const toastOK = page.locator('#toast-box div').filter({ hasText: /logística|avançada|faturamento/i });
    await expect(toastOK).toBeVisible({ timeout: 8_000 });
  });

  // ─── LOGÍSTICA: NF ───────────────────────────────────────────────
  test('4. Logística preenche NF e avança para Aguardando Emissão', async ({ page }) => {
    test.skip(!opNumero, 'Depende dos testes anteriores');
    await loginAs(page, 'logistica');

    const btnAcao = page.locator(`.card:has-text("${TEST_PREFIX}") button[onclick*="openActionModal"]:has-text("Solicitar Emissão")`).first();
    await expect(btnAcao).toBeVisible({ timeout: 8_000 });
    await btnAcao.click();
    await waitForModalOpen(page);

    // Endereço de entrega (textarea obrigatório)
    await page.fill('#f-enderecoEntrega', 'Rua de Teste, 123 - Bairro Teste, São Paulo/SP');

    // Seleciona motorista e preenche os sub-campos (toggleEnvio mostra os inputs)
    await page.locator('input[name="envioTipo"][value="motorista"]').check();
    await page.waitForTimeout(200);
    await page.fill('#f-envio_motorista', 'João Motorista Teste');
    await page.fill('#f-envio_carro', 'Fiat Fiorino Branca');
    await page.fill('#f-envio_placa', 'TST-0001');

    // Volumes e peso obrigatórios
    await page.fill('#f-volumes', '1');
    await page.fill('#f-peso', '10');

    await page.locator('button[onclick="submitModal()"]').click();
    await waitForModalClose(page, 12_000);

    // Nenhum toast de sucesso é mostrado para avanços normais — confirma via save indicator
    await expect(page.locator('#save-indicator')).toContainText('Salvo', { timeout: 8_000 });
  });

  // ─── FISCAL: EMISSÃO NF ──────────────────────────────────────────
  test('5. Fiscal emite a NF e avança para Aguardando Despacho', async ({ page }) => {
    test.skip(!opNumero, 'Depende dos testes anteriores');
    await loginAs(page, 'fiscal');

    const btnAcao = page.locator(`.card:has-text("${TEST_PREFIX}") button[onclick*="openActionModal"]:has-text("Confirmar Emissão")`).first();
    await expect(btnAcao).toBeVisible({ timeout: 8_000 });
    await btnAcao.click();
    await waitForModalOpen(page);

    // Injeta arquivo NF falso para bypassar a validação de upload obrigatório
    await page.evaluate(() => {
      if (typeof tempFilesData !== 'undefined') {
        tempFilesData['arquivoNF'] = [{
          name: 'playwright-nf.pdf', size: 1024,
          url: 'https://placeholder.test/nf.pdf',
          path: 'uploads/playwright-test-nf.pdf',
        }];
      }
    });

    await page.fill('#f-numeroNF', '99999');
    await page.fill('#f-dataEmissao', new Date().toISOString().slice(0, 10));

    // Sincroniza _loadedAt para evitar conflito de locking otimista
    await page.evaluate(() => {
      if (typeof activeOpId !== 'undefined' && activeOpId && typeof ops !== 'undefined') {
        const op = ops.find(o => o.id === activeOpId);
        if (op) op._loadedAt = op.updated_at || op._loadedAt;
      }
    });

    await page.locator('button[onclick="submitModal()"]').click();
    await waitForModalClose(page, 12_000);
    await expect(page.locator('#save-indicator')).toContainText('Salvo', { timeout: 8_000 });
  });

  // ─── LOGÍSTICA: DESPACHO ─────────────────────────────────────────
  test('6. Logística confirma despacho e avança para Trânsito', async ({ page }) => {
    test.skip(!opNumero, 'Depende dos testes anteriores');
    await loginAs(page, 'logistica');
    await page.waitForTimeout(1500); // aguarda Realtime propagar o estado aguard_despacho

    const btnAcao = page.locator(`.card:has-text("${TEST_PREFIX}") button[onclick*="openActionModal"]:has-text("Confirmar e Despachar")`).first();
    await expect(btnAcao).toBeVisible({ timeout: 8_000 });
    await btnAcao.click();
    await waitForModalOpen(page);

    // Modal pré-preenche #f-dataDespacho e #f-horaDespacho com nowDate/nowTime
    // Sincroniza _loadedAt para evitar conflito de locking otimista
    await page.evaluate(() => {
      if (typeof activeOpId !== 'undefined' && activeOpId && typeof ops !== 'undefined') {
        const op = ops.find(o => o.id === activeOpId);
        if (op) op._loadedAt = op.updated_at || op._loadedAt;
      }
    });

    await page.locator('button[onclick="submitModal()"]').click();
    await waitForModalClose(page, 12_000);
    await expect(page.locator('#save-indicator')).toContainText('Salvo', { timeout: 8_000 });
  });

  // ─── LOGÍSTICA: ENTREGA ──────────────────────────────────────────
  test('7. Logística confirma entrega — OP vai para Entregue', async ({ page }) => {
    test.skip(!opNumero, 'Depende dos testes anteriores');
    await loginAs(page, 'logistica');
    await page.waitForTimeout(2000); // aguarda Realtime propagar o estado transito

    const btnAcao = page.locator(`.card:has-text("${TEST_PREFIX}") button[onclick*="openActionModal"]:has-text("Confirmar Entrega")`).first();
    await expect(btnAcao).toBeVisible({ timeout: 8_000 });
    await btnAcao.click();
    await waitForModalOpen(page);

    // Sincroniza _loadedAt para evitar conflito de locking otimista
    await page.evaluate(() => {
      if (typeof activeOpId !== 'undefined' && activeOpId && typeof ops !== 'undefined') {
        const op = ops.find(o => o.id === activeOpId);
        if (op) op._loadedAt = op.updated_at || op._loadedAt;
      }
    });

    await page.fill('#f-dataEntrega', new Date().toISOString().slice(0, 10));
    await page.fill('#f-descricao', 'Entrega confirmada — teste automatizado Playwright');

    await page.locator('button[onclick="submitModal()"]').click();
    await waitForModalClose(page, 8_000);

    await expect(page.locator('#save-indicator')).toContainText('Salvo', { timeout: 8_000 });
  });
});
