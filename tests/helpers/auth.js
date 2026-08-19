// helpers/auth.js — login/logout helpers para os testes
import { expect } from '@playwright/test';

export const CREDS = {
  comercial:  { email: process.env.TEST_USER_COMERCIAL,  pass: process.env.TEST_PASS_COMERCIAL  },
  financeiro: { email: process.env.TEST_USER_FINANCEIRO, pass: process.env.TEST_PASS_FINANCEIRO },
  fiscal:     { email: process.env.TEST_USER_FISCAL,     pass: process.env.TEST_PASS_FISCAL     },
  logistica:  { email: process.env.TEST_USER_LOGISTICA,  pass: process.env.TEST_PASS_LOGISTICA  },
  gestor:     { email: process.env.TEST_USER_GESTOR,     pass: process.env.TEST_PASS_GESTOR     },
  adm:        { email: process.env.TEST_USER_ADM,        pass: process.env.TEST_PASS_ADM        },
};

/**
 * Abre o app e faz login como o papel especificado.
 * Aguarda o #appContainer estar visível antes de retornar.
 */
export async function loginAs(page, role) {
  const { email, pass } = CREDS[role] || {};
  if (!email || !pass) throw new Error(`Credenciais para "${role}" não configuradas no .env.test`);

  await page.goto('/');
  await page.waitForSelector('#loginEmail', { state: 'visible' });
  await page.fill('#loginEmail', email);
  await page.fill('#loginPassword', pass);
  await page.click('button[onclick="doLogin()"]');
  await page.waitForSelector('#appContainer', { state: 'visible', timeout: 20_000 });
}

/**
 * Faz logout e aguarda a tela de login voltar.
 */
export async function logout(page) {
  try {
    await page.click('.user-avatar');
    await page.waitForSelector('#userMenu', { state: 'visible', timeout: 5_000 });
    // O menu pode fechar antes do clique (race condition de re-render)
    await page.locator('button[onclick="doLogout()"]').click({ timeout: 5_000 });
  } catch {
    // Fallback: chama doLogout() diretamente via JS se o menu fechou antes
    await page.evaluate(() => { if (typeof doLogout === 'function') doLogout(); });
  }
  await page.waitForSelector('#loginEmail', { state: 'visible', timeout: 10_000 });
}

/**
 * Troca de papel: faz logout e login como outro role sem recarregar a página manualmente.
 */
export async function switchTo(page, role) {
  await logout(page);
  await loginAs(page, role);
}

/**
 * Aguarda um toast com texto específico aparecer.
 * O app usa elementos com classe .toast-msg ou similares.
 */
export async function waitForToast(page, textOrRegex) {
  // Toasts são <div> filhos de #toast-box (sem classe própria)
  const el = page.locator('#toast-box div').filter({ hasText: textOrRegex });
  await expect(el).toBeVisible({ timeout: 8_000 });
}
