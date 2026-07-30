// helpers/op.js — criação, avanço e limpeza de OPs de teste
import { expect } from '@playwright/test';
import { waitForModalOpen, waitForModalClose } from './modal.js';

// Prefixo único para identificar OPs criadas pelos testes (facilita limpeza)
export const TEST_PREFIX = 'PLAYWRIGHT_TEST';

/**
 * Cancela todas as OPs cujo cliente começa com TEST_PREFIX.
 * Usado no afterAll para limpar dados de teste.
 * Requer estar logado como gestor.
 */
export async function cancelarOPsDeTeste(page) {
  // Vai para a aba "Todas" para ver tudo
  const btnTodas = page.locator('[data-tab="todas"], #btn-tab-todas, button:has-text("Todas")');
  if (await btnTodas.count() > 0) await btnTodas.click();
  await page.waitForTimeout(500);

  // Busca pelo prefixo de teste no filtro
  const filtro = page.locator('#fl-q');
  if (await filtro.count() > 0) {
    const btnFiltro = page.locator('#btn-filter-toggle');
    if (await btnFiltro.count() > 0) await btnFiltro.click();
    await filtro.fill(TEST_PREFIX);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(600);
  }

  // Cancela cada OP encontrada (clica no card, cancela pelo modal de info)
  const cards = page.locator(`.card[data-cliente*="${TEST_PREFIX}"], .card:has-text("${TEST_PREFIX}")`);
  const total = await cards.count();
  for (let i = 0; i < total; i++) {
    try {
      await cards.nth(0).click();
      await waitForModalOpen(page, 5_000);
      const btnCancel = page.locator('button[onclick*="cancelarOP"], [data-action="cancelar-op"]');
      if (await btnCancel.count() > 0) {
        await btnCancel.click();
        await page.waitForSelector('#f-motivoCancel', { state: 'visible', timeout: 3_000 });
        await page.fill('#f-motivoCancel', 'Cancelado pelo teste automatizado Playwright');
        await page.click('button[onclick*="doCancelarOP"]');
        await waitForModalClose(page, 5_000);
      } else {
        await page.keyboard.press('Escape');
      }
    } catch {}
    await page.waitForTimeout(400);
  }
}

/**
 * Abre o modal de ação (avançar etapa) da OP atualmente em destaque / primeira da fila.
 */
export async function abrirAcaoPrimeiraOP(page) {
  const btnAcao = page.locator('.card .btn-acao, .card button[onclick*="openActionModal"]').first();
  await btnAcao.click();
  await waitForModalOpen(page);
  return page.locator('#modal');
}
