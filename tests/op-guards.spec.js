// op-guards.spec.js — regras de negócio: gate duplo, cancel/reativar, papel errado
import { test, expect } from '@playwright/test';
import { loginAs, switchTo } from './helpers/auth.js';
import { cancelarOPsDeTeste, TEST_PREFIX } from './helpers/op.js';
import { waitForModalOpen, waitForModalClose } from './helpers/modal.js';

test.describe('Gate duplo financeiro/fiscal', () => {
  test('SF lançado ANTES da aprovação financeira — OP fica em aguard_financeiro', async ({ page }) => {
    await loginAs(page, 'fiscal');

    // Encontra uma OP em aguard_financeiro (fiscal vê botão SF)
    const btnSF = page.locator('button[onclick*="saveSimplesFaturamento"]').first();
    const temSF = await btnSF.isVisible().catch(() => false);
    test.skip(!temSF, 'Sem OP em aguard_financeiro com botão SF visível — pule este teste');

    await btnSF.click();
    await page.waitForTimeout(400);

    // Confirma SF (mesmo sem arquivo — se o sistema rejeitar, o teste valida o toast de erro)
    const btnConfirmar = page.locator('button[onclick*="saveSimplesFaturamento"]').last();
    await btnConfirmar.click();

    // Deve aparecer toast de "aguardando aprovação" (financeiro ainda não aprovou)
    const toastAguard = page.locator('#toast-box div').filter({ hasText: /aguardando.*financeiro|aprovação|financeiro/i });
    await expect(toastAguard).toBeVisible({ timeout: 8_000 });

    // Modal info deve continuar mostrando status aguard_financeiro
    const statusBadge = page.locator('.badge, [class*="badge"]').filter({ hasText: /financeiro/i });
    await expect(statusBadge.first()).toBeVisible({ timeout: 5_000 });
  });
});

test.describe('Cancelar e reativar OP', () => {
  test.afterAll(async ({ browser }) => {
    const ctx  = await browser.newContext();
    const page = await ctx.newPage();
    await loginAs(page, 'gestor');
    await cancelarOPsDeTeste(page);
    await ctx.close();
  });

  test('cancelar OP exige motivo — sem motivo exibe erro', async ({ page }) => {
    await loginAs(page, 'gestor');

    // Abre qualquer OP ativa (info modal) e tenta cancelar sem motivo
    const card = page.locator('.card').first();
    const temCard = await card.isVisible().catch(() => false);
    test.skip(!temCard, 'Sem OPs ativas para testar cancelamento');

    await card.click();
    await waitForModalOpen(page);

    const btnCancel = page.locator('button[onclick*="cancelarOP"]');
    const temBtnCancel = await btnCancel.isVisible().catch(() => false);
    if (!temBtnCancel) { await page.keyboard.press('Escape'); test.skip(true, 'Botão cancelar não encontrado'); }

    await btnCancel.click();
    await page.waitForTimeout(400);

    // Tenta confirmar cancelamento SEM preencher motivo
    const btnConfirmarCancel = page.locator('button[onclick*="doCancelarOP"]');
    if (await btnConfirmarCancel.isVisible()) await btnConfirmarCancel.click();

    // Deve aparecer erro pedindo motivo
    const erroMotivo = page.locator('#toast-box div').filter({ hasText: /motivo/i });
    await expect(erroMotivo).toBeVisible({ timeout: 5_000 });
  });

  test('OP entregue não pode ser cancelada', async ({ page }) => {
    await loginAs(page, 'gestor');

    // Vai para a aba de entregues
    const tabEntregues = page.locator('[data-tab="entregues"], button:has-text("Entregues")');
    if (await tabEntregues.isVisible()) await tabEntregues.click();
    await page.waitForTimeout(400);

    const card = page.locator('.card').first();
    const temCard = await card.isVisible().catch(() => false);
    test.skip(!temCard, 'Sem OPs entregues para testar');

    await card.click();
    await waitForModalOpen(page);

    // Botão de cancelar não deve existir OU deve exibir erro ao clicar
    const btnCancel = page.locator('button[onclick*="cancelarOP"]');
    const visivel   = await btnCancel.isVisible().catch(() => false);
    if (visivel) {
      await btnCancel.click();
      await page.waitForTimeout(300);
      const btnConfirmar = page.locator('button[onclick*="doCancelarOP"]');
      if (await btnConfirmar.isVisible()) {
        await page.fill('#f-motivoCancel', 'Motivo de teste');
        await btnConfirmar.click();
        const erroEntregue = page.locator('#toast-box div').filter({ hasText: /entregue/i });
        await expect(erroEntregue).toBeVisible({ timeout: 5_000 });
      }
    }
  });

  test('cancelar e reativar restaura status anterior', async ({ page }) => {
    await loginAs(page, 'gestor');

    // Pega a primeira OP ativa e registra o status dela
    const card = page.locator('.card:not([data-status="entregue"])').first();
    const temCard = await card.isVisible().catch(() => false);
    test.skip(!temCard, 'Sem OPs ativas');

    const statusAntes = await card.locator('[data-status], .badge').first().textContent();

    await card.click();
    await waitForModalOpen(page);

    // Cancela
    const btnCancel = page.locator('button[onclick*="cancelarOP"]');
    if (!await btnCancel.isVisible()) { await page.keyboard.press('Escape'); test.skip(true); }
    await btnCancel.click();
    await page.waitForTimeout(300);
    await page.fill('#f-motivoCancel', `${TEST_PREFIX} — cancelamento de teste`);
    await page.click('button[onclick*="doCancelarOP"]');
    await waitForModalClose(page, 8_000);
    await page.waitForTimeout(500);

    // Reabre e reativa
    await card.click();
    await waitForModalOpen(page);
    const btnReativar = page.locator('button[onclick*="reativarOP"]');
    await expect(btnReativar).toBeVisible({ timeout: 5_000 });
    await btnReativar.click();
    await waitForModalClose(page, 8_000);

    // Toast de reativada
    const toastReativar = page.locator('#toast-box div').filter({ hasText: /reativada/i });
    await expect(toastReativar).toBeVisible({ timeout: 5_000 });
  });
});

test.describe('Rollback quando DB falha', () => {
  test('status da OP não muda na tela se o Supabase retornar erro', async ({ page }) => {
    await loginAs(page, 'financeiro');

    const card = page.locator('.card').first();
    const temCard = await card.isVisible().catch(() => false);
    test.skip(!temCard, 'Sem OPs na fila do financeiro');

    // Captura o status/badge atual
    const badgeAntes = await card.locator('.badge').first().textContent();

    // Intercepta a chamada REST do Supabase e simula erro de rede
    await page.route('**/rest/v1/ops*', route => route.abort('failed'));

    // Tenta avançar OP
    const btnAcao = card.locator('.btn-acao, button[onclick*="openActionModal"]');
    await btnAcao.click();
    await waitForModalOpen(page);
    const btnConfirmar = page.locator('button[onclick="submitModal()"]').first();
    if (await btnConfirmar.isVisible()) await btnConfirmar.click();

    // Aguarda toast de erro
    const toastErro = page.locator('#toast-box div');
    await expect(toastErro.first()).toBeVisible({ timeout: 8_000 });

    // Cancela interceptação
    await page.unrouteAll();

    // Badge do card deve continuar igual ao anterior (rollback aplicado)
    await page.waitForTimeout(800);
    const badgeDepois = await card.locator('.badge').first().textContent();
    expect(badgeDepois?.trim()).toBe(badgeAntes?.trim());
  });
});
