// rotta-demo.spec.js
// Cria uma OP com dados fixos da Rotta Master e avança até aguard_despacho.
// O script pausa antes do despacho — clique em "Confirmar e Despachar" manualmente.

import { test, expect } from '@playwright/test';
import { loginAs, switchTo } from './helpers/auth.js';
import { waitForModalOpen, waitForModalClose } from './helpers/modal.js';

const CLIENTE  = 'DEMO Rotta NF19373';
const CNPJ     = '29.986.870/0001-63';
const NUMERO_NF = '19373';

test.use({ headless: false });
test.setTimeout(300_000);

test('Rotta demo — avança até aguard_despacho, despacho manual', async ({ page }) => {

  // ── 1. COMERCIAL: cria OP ─────────────────────────────────────────
  await loginAs(page, 'comercial');

  await expect(page.locator('#btnNovaOP')).toBeVisible({ timeout: 8_000 });
  await page.click('#btnNovaOP');
  await waitForModalOpen(page);
  await page.waitForSelector('#nova-form-fields', { state: 'attached' });

  await page.evaluate(() => {
    document.getElementById('nova-form-fields').style.display = 'block';
    document.getElementById('nova-modal-footer').style.display = '';
    document.getElementById('nova-numPedido').value = 'ROTTA-DEMO-NF19373';
    if (typeof tempEquipList !== 'undefined') {
      tempEquipList.length = 0;
      tempEquipList.push({ name: 'Equipamento Demo Rotta', code: '', qty: 1, valorUnit: '100', desconto: '' });
      if (typeof refreshEquipList === 'function') refreshEquipList();
    }
  });

  await page.locator('#nova-cpf').waitFor({ state: 'visible', timeout: 5_000 });
  await page.fill('#nova-vendedorCanal', 'Demo Rotta');
  await page.fill('#nova-cliente', CLIENTE);
  await page.fill('#nova-cpf', CNPJ);

  const analistaSelect = page.locator('#nova-analista');
  if (await analistaSelect.locator('option:not([disabled])').count() > 0)
    await analistaSelect.selectOption({ index: 1 });

  await page.locator('#nova-entrada').selectOption('pendente');
  await page.evaluate(() => {
    const el = document.getElementById('nova-valorEntrada');
    if (el) { el.value = '100,00'; el.dispatchEvent(new Event('input', { bubbles: true })); }
    const row = document.getElementById('nova-entrada-row');
    if (row) row.style.display = '';
  });

  await page.fill('#nova-contatoEntrega', 'Contato Demo');
  const previsao = new Date();
  previsao.setDate(previsao.getDate() + 30);
  await page.fill('#nova-previsaoEntrega', previsao.toISOString().slice(0, 10));

  await page.locator('#btn-criar-op').scrollIntoViewIfNeeded();
  await page.evaluate(() => submitNovaOP());
  await waitForModalClose(page, 30_000);
  await page.waitForTimeout(1000);

  // ── 2. FINANCEIRO: aprovação ──────────────────────────────────────
  await switchTo(page, 'financeiro');
  await page.waitForTimeout(1500);

  const btnFin = page.locator(`.card:has-text("${CLIENTE}") button[onclick*="openActionModal"]`).first();
  await expect(btnFin).toBeVisible({ timeout: 8_000 });
  await btnFin.click();
  await waitForModalOpen(page);

  const obsField = page.locator('#f-descricao, textarea[name="descricao"]').first();
  if (await obsField.count() > 0) await obsField.fill('Pagamento confirmado — demo Rotta');

  await page.evaluate(() => {
    const op = ops?.find(o => o.id === activeOpId);
    if (op) op._loadedAt = op.updated_at || op._loadedAt;
  });
  await page.locator('button[onclick="submitModal()"]').click();
  await waitForModalClose(page, 8_000);
  await page.waitForTimeout(800);

  // ── 3. LOGÍSTICA: solicita emissão via Rotta Master ───────────────
  await switchTo(page, 'logistica');
  await page.waitForTimeout(1500);

  const btnLog = page.locator(`.card:has-text("${CLIENTE}") button[onclick*="openActionModal"]:has-text("Solicitar Emissão")`).first();
  await expect(btnLog).toBeVisible({ timeout: 8_000 });
  await btnLog.click();
  await waitForModalOpen(page);

  await page.fill('#f-enderecoEntrega', 'Rua de Entrega Demo, 123 - São Paulo/SP');

  await page.locator('input[name="envioTipo"][value="transportadora"]').check();
  await page.waitForTimeout(300);

  await page.locator('#f-envio_transportadora').selectOption('rotta');

  await page.fill('#f-volumes', '1');
  await page.fill('#f-peso', '5');

  await page.evaluate(() => {
    const op = ops?.find(o => o.id === activeOpId);
    if (op) op._loadedAt = op.updated_at || op._loadedAt;
  });
  await page.locator('button[onclick="submitModal()"]').click();
  await waitForModalClose(page, 12_000);
  await expect(page.locator('#save-indicator')).toContainText('Salvo', { timeout: 8_000 });

  // ── 4. FISCAL: emite NF 19373 ─────────────────────────────────────
  await switchTo(page, 'fiscal');
  await page.waitForTimeout(1500);

  const btnFisc = page.locator(`.card:has-text("${CLIENTE}") button[onclick*="openActionModal"]:has-text("Confirmar Emissão")`).first();
  await expect(btnFisc).toBeVisible({ timeout: 8_000 });
  await btnFisc.click();
  await waitForModalOpen(page);

  await page.evaluate(() => {
    if (typeof tempFilesData !== 'undefined') {
      tempFilesData['arquivoNF'] = [{
        name: 'nf-rotta-demo.pdf', size: 1024,
        url: 'https://placeholder.test/nf.pdf',
        path: 'uploads/nf-rotta-demo.pdf',
      }];
    }
  });

  await page.fill('#f-numeroNF', NUMERO_NF);
  await page.fill('#f-dataEmissao', new Date().toISOString().slice(0, 10));

  await page.evaluate(() => {
    const op = ops?.find(o => o.id === activeOpId);
    if (op) op._loadedAt = op.updated_at || op._loadedAt;
  });
  await page.locator('button[onclick="submitModal()"]').click();
  await waitForModalClose(page, 12_000);
  await expect(page.locator('#save-indicator')).toContainText('Salvo', { timeout: 8_000 });

  // ── 5. LOGÍSTICA: aguarda despacho manual ─────────────────────────
  await switchTo(page, 'logistica');
  await page.waitForTimeout(2000);

  const btnDespacho = page.locator(`.card:has-text("${CLIENTE}") button[onclick*="openActionModal"]:has-text("Confirmar e Despachar")`).first();
  await expect(btnDespacho).toBeVisible({ timeout: 10_000 });

  // ── PAUSA: clique em "Confirmar e Despachar" para ver o rastreio ──
  await page.pause();
});
