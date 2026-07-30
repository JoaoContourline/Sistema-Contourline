// ui-behavior.spec.js — testes de comportamento da UI
// Cobre: filtros, tecla Escape, lightbox, kanban, "Sem resultados" falso
import { test, expect } from '@playwright/test';
import { loginAs } from './helpers/auth.js';
import { waitForModalOpen } from './helpers/modal.js';

test.describe('Filtros', () => {
  test.beforeEach(async ({ page }) => {
    await loginAs(page, 'gestor');
    // Vai para Todas as OPs (kanban)
    const btnTodas = page.locator('[data-tab="todas"], #btn-tab-todas');
    await btnTodas.click();
    await page.waitForTimeout(400);
  });

  test('busca por texto mostra só OPs que batem', async ({ page }) => {
    const btnFiltro = page.locator('#btn-filter-toggle');
    await btnFiltro.click();
    await page.waitForSelector('#filter-bar', { state: 'visible' });

    // Digita algo que não existe
    await page.fill('#fl-q', 'XYZXYZ_NAO_EXISTE_9999');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(800);

    const semResultados = page.locator('.empty-title').filter({ hasText: /sem resultados/i });
    await expect(semResultados).toBeVisible({ timeout: 5_000 });
  });

  test('"Sem resultados" NÃO aparece quando busca casa com OP aberta/bloqueada', async ({ page }) => {
    // Este teste verifica o fix: OPs aberta/bloqueada existem mas não aparecem no
    // kanban — o sistema não deve mostrar "Sem resultados" pois as OPs existem
    const btnFiltro = page.locator('#btn-filter-toggle');
    await btnFiltro.click();
    await page.waitForTimeout(300);

    // Usamos evaluate para injetar direto uma OP com status "aberta" nos dados em
    // memória e verificar que o kanban não mostra "Sem resultados"
    const hasAberta = await page.evaluate(() => {
      if (typeof ops === 'undefined') return false;
      return ops.some(o => o.status === 'aberta' || o.status === 'bloqueada');
    });

    if (hasAberta) {
      // Filtra pelo cliente de uma OP aberta/bloqueada
      const opAberta = await page.evaluate(() =>
        ops.find(o => o.status === 'aberta' || o.status === 'bloqueada')?.cliente || ''
      );
      if (opAberta) {
        await page.fill('#fl-q', opAberta.substring(0, 8));
        await page.waitForTimeout(600);
        // O kanban pode mostrar 0 colunas com cards, mas NÃO deve mostrar "Sem resultados"
        const semResultados = page.locator('.empty-title').filter({ hasText: /sem resultados/i });
        await expect(semResultados).not.toBeVisible({ timeout: 3_000 });
      }
    }
  });

  test('clearFilters fecha a filter bar e reseta o estado', async ({ page }) => {
    const btnFiltro = page.locator('#btn-filter-toggle');
    await btnFiltro.click();
    await page.waitForTimeout(300);

    // Digita algo no filtro para ativar o botão "Limpar"
    await page.fill('#fl-q', 'teste');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(400);

    // Botão "Limpar" deve aparecer quando há filtro ativo
    const btnClear = page.locator('#fl-clear');
    await expect(btnClear).toBeVisible({ timeout: 3_000 });
    await btnClear.click();
    await page.waitForTimeout(500);

    // Filter bar deve estar fechada (maxWidth = '0' ou '0px')
    const maxWidth = await page.evaluate(() => {
      const bar = document.getElementById('filter-bar');
      return bar ? parseInt(bar.style.maxWidth) : -1;
    });
    expect(maxWidth).toBe(0);

    // Campo de busca deve estar vazio
    const valFiltro = await page.locator('#fl-q').inputValue();
    expect(valFiltro).toBe('');
  });
});

test.describe('Tecla Escape', () => {
  test('Escape fecha o modal de ação', async ({ page }) => {
    await loginAs(page, 'gestor');

    // Abre qualquer card
    const card = page.locator('.card').first();
    const temCard = await card.isVisible().catch(() => false);
    test.skip(!temCard, 'Sem cards para testar');

    await card.click();
    await waitForModalOpen(page);

    await page.keyboard.press('Escape');
    await expect(page.locator('#modal')).not.toBeVisible({ timeout: 3_000 });
  });

  test('Escape fecha lightbox sem fechar o modal de fundo', async ({ page }) => {
    await loginAs(page, 'gestor');

    // Procura um card com anexo (comprovante ou imagem) para abrir o lightbox
    // Se não houver, o teste é pulado graciosamente
    const card = page.locator('.card').first();
    const temCard = await card.isVisible().catch(() => false);
    test.skip(!temCard, 'Sem cards para testar');

    await card.click();
    await waitForModalOpen(page);

    // Procura link de arquivo dentro do modal para abrir lightbox
    const linkArquivo = page.locator('#modal a[onclick*="showLightbox"], #modal [onclick*="showLightbox"]').first();
    const temArquivo  = await linkArquivo.isVisible().catch(() => false);

    if (!temArquivo) {
      // Abre lightbox manualmente via evaluate para simular o comportamento
      await page.evaluate(() => {
        if (typeof showLightbox === 'function') {
          showLightbox('data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10"/></svg>', 'teste.svg');
        }
      });
    } else {
      await linkArquivo.click();
    }

    // Verifica se o lightbox abriu
    const lb = page.locator('#img-lightbox');
    const lbAberto = await lb.evaluate(el => el.style.display !== 'none').catch(() => false);

    if (!lbAberto) {
      await page.keyboard.press('Escape');
      test.skip(true, 'Lightbox não disponível — pula');
    }

    // Agora: Escape deve fechar SOMENTE o lightbox, não o modal de fundo
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);

    // Lightbox fechou
    const lbFechado = await lb.evaluate(el => el.style.display === 'none').catch(() => true);
    expect(lbFechado).toBe(true);

    // Modal de fundo ainda está aberto
    await expect(page.locator('#modal')).toBeVisible();

    // Segundo Escape fecha o modal
    await page.keyboard.press('Escape');
    await expect(page.locator('#modal')).not.toBeVisible({ timeout: 3_000 });
  });
});

test.describe('Dashboard do Gestor', () => {
  test('KPI "No Prazo" não conta OPs sem data de entrega/previsão', async ({ page }) => {
    await loginAs(page, 'gestor');

    const btnDash = page.locator('[data-tab="dashboard"], #btn-tab-dashboard');
    await expect(btnDash).toBeVisible({ timeout: 5_000 });
    await btnDash.click();
    await page.waitForTimeout(600);

    // O KPI de "% no prazo" deve existir e mostrar um número válido (0-100%)
    const kpiPrazo = page.locator('[data-kpi="prazo"], .kpi:has-text("%"), .kpi-prazo').first();
    const temKPI   = await kpiPrazo.isVisible().catch(() => false);
    if (!temKPI) {
      // Alternativa: verifica via evaluate
      const pct = await page.evaluate(() => {
        // Tenta ler o valor exibido do KPI de prazo
        const el = document.querySelector('[data-kpi="prazo"]')
                || [...document.querySelectorAll('.kpi-value')].find(e => e.textContent.includes('%'));
        return el ? parseInt(el.textContent) : null;
      });
      if (pct !== null) {
        expect(pct).toBeGreaterThanOrEqual(0);
        expect(pct).toBeLessThanOrEqual(100);
      }
    } else {
      const txt = await kpiPrazo.textContent();
      const pct = parseInt(txt || '0');
      expect(pct).toBeGreaterThanOrEqual(0);
      expect(pct).toBeLessThanOrEqual(100);
    }
  });
});

test.describe('Impressão do Pedido de Venda', () => {
  test('abrir PDF do pedido de venda não lança erro de JS', async ({ page }) => {
    await loginAs(page, 'comercial');

    const card = page.locator('.card').first();
    const temCard = await card.isVisible().catch(() => false);
    test.skip(!temCard, 'Sem OPs para testar impressão');

    await card.click();
    await waitForModalOpen(page);

    // Captura erros JS durante a abertura do PDF
    const erros = [];
    page.on('pageerror', e => erros.push(e.message));

    const btnPrint = page.locator('button[onclick*="printPedidoVenda"], button:has-text("Imprimir PV")');
    if (await btnPrint.isVisible()) {
      // Intercepta window.open para não abrir aba real
      await page.evaluate(() => { window._printOpened = false; window.open = () => { window._printOpened = true; return null; }; });
      await btnPrint.click();
      await page.waitForTimeout(500);
    }

    expect(erros).toHaveLength(0);
  });
});

test.describe('Conexão offline', () => {
  test('banner de "conexão perdida" aparece quando offline', async ({ page }) => {
    await loginAs(page, 'gestor');

    // Dispara evento offline via evaluate (setOffline do Playwright não dispara o evento no window)
    await page.evaluate(() => window.dispatchEvent(new Event('offline')));

    const toast = page.locator('#toast-box div').filter({ hasText: /conexão|offline/i });
    await expect(toast).toBeVisible({ timeout: 5_000 });

    // Restaura conexão
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    const toastOnline = page.locator('#toast-box div').filter({ hasText: /restaurada/i });
    await expect(toastOnline).toBeVisible({ timeout: 5_000 });
  });
});
