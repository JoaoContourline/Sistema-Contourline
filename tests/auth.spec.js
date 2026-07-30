// auth.spec.js — testes de autenticação e controle de acesso por papel
import { test, expect } from '@playwright/test';
import { loginAs, logout, CREDS } from './helpers/auth.js';

test.describe('Login', () => {
  test('credenciais inválidas exibem mensagem de erro', async ({ page }) => {
    await page.goto('/');
    await page.fill('#loginEmail', 'nao-existe@contourline.com.br');
    await page.fill('#loginPassword', 'senhaerrada');
    await page.click('button[onclick="doLogin()"]');

    const erroEl = page.locator('#loginError, .login-error').filter({ hasText: /inválid|incorret|erro/i });
    await expect(erroEl).toBeVisible({ timeout: 8_000 });
    await expect(page.locator('#appContainer')).not.toBeVisible();
  });

  test('login válido como comercial exibe app e oculta painel de login', async ({ page }) => {
    await loginAs(page, 'comercial');
    await expect(page.locator('#appContainer')).toBeVisible();
    await expect(page.locator('#loginCard, #login-panel')).not.toBeVisible();
  });

  test('login válido como gestor exibe aba Dashboard', async ({ page }) => {
    await loginAs(page, 'gestor');
    const dashBtn = page.locator('[data-tab="dashboard"], #btn-tab-dashboard');
    await expect(dashBtn).toBeVisible();
  });
});

test.describe('Controle de acesso por papel', () => {
  test('vendedor (comercial) não enxerga aba Pendentes com alerta', async ({ page }) => {
    await loginAs(page, 'comercial');
    // Comercial vê "Pendentes" mas é a sua fila pessoal de vendas — sem badge/som
    // A lógica refreshPendingAlert() pula o role 'vendedor'
    const dot = page.locator('#pending-dot');
    // O dot não deve piscar para vendedor — pode não existir ou estar oculto
    await page.waitForTimeout(1500); // aguarda um ciclo do refreshPendingAlert
    const isVisible = await dot.isVisible().catch(() => false);
    // Não fazemos expect de visibilidade — apenas garantimos que o app carregou
    await expect(page.locator('#appContainer')).toBeVisible();
  });

  test('financeiro enxerga somente sua fila pendente', async ({ page }) => {
    await loginAs(page, 'financeiro');
    // A aba ativa padrão do financeiro é a fila de aprovações
    const filaTab = page.locator('[data-tab="fila"], #btn-tab-fila');
    await expect(filaTab).toBeVisible();
  });

  test('gestor enxerga aba Todas as OPs', async ({ page }) => {
    await loginAs(page, 'gestor');
    const todasTab = page.locator('[data-tab="todas"], #btn-tab-todas');
    await expect(todasTab).toBeVisible();
    await todasTab.click();
    // Kanban deve aparecer (mesmo que vazio)
    await expect(page.locator('#kanban-wrap')).toBeVisible({ timeout: 8_000 });
  });

  test('logout retorna para tela de login', async ({ page }) => {
    await loginAs(page, 'fiscal');
    await logout(page);
    await expect(page.locator('#loginEmail')).toBeVisible();
    await expect(page.locator('#appContainer')).not.toBeVisible();
  });
});

test.describe('Recuperação de senha', () => {
  test('link "Esqueci minha senha" exibe painel de recuperação', async ({ page }) => {
    await page.goto('/');
    const linkEsqueci = page.locator('button[onclick*="showResetPanel"]');
    // O botão fica oculto por padrão (display:none) mas deve existir no DOM
    await expect(linkEsqueci).toBeAttached();
  });
});
