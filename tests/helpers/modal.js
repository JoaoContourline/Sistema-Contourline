// helpers/modal.js — utilitários para aguardar abertura/fechamento do modal
// O #modal sempre existe no DOM; a visibilidade é controlada pela classe .open no #overlay.
import { expect } from '@playwright/test';

export async function waitForModalOpen(page, timeout = 10_000) {
  await expect(page.locator('#overlay')).toHaveClass(/open/, { timeout });
}

export async function waitForModalClose(page, timeout = 20_000) {
  await expect(page.locator('#overlay')).not.toHaveClass(/open/, { timeout });
}
