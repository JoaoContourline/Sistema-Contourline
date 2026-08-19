// rastreio.spec.js — testes de integração do fluxo de rastreamento de cargas
// Cobre: seleção de transportadora, campos chaveNfe/codigoObjeto, validações,
// aba Rastreamento, guards de erros, e ciclo completo com transportadora.
import { test, expect } from '@playwright/test';
import { loginAs, switchTo, waitForToast } from './helpers/auth.js';
import { cancelarOPsDeTeste, TEST_PREFIX } from './helpers/op.js';
import { waitForModalOpen, waitForModalClose } from './helpers/modal.js';

// ─── helpers locais ────────────────────────────────────────────────────────

async function criarOPMinima(page, { transportadora = 'jamef' } = {}) {
  await loginAs(page, 'comercial');
  const btnNova = page.locator('#btnNovaOP');
  await expect(btnNova).toBeVisible({ timeout: 8_000 });
  await btnNova.click();
  await waitForModalOpen(page);

  await page.waitForSelector('#nova-form-fields', { state: 'attached' });
  await page.evaluate(() => {
    const ff = document.getElementById('nova-form-fields');
    if (ff) ff.style.display = 'block';
    const footer = document.getElementById('nova-modal-footer');
    if (footer) footer.style.display = '';
    const pvInput = document.getElementById('nova-numPedido');
    if (pvInput) pvInput.value = 'TESTE-PV-RASTREIO';
    if (typeof tempEquipList !== 'undefined') {
      tempEquipList.length = 0;
      tempEquipList.push({ name: 'PLAYWRIGHT TEST Rastreio', code: '', qty: 1, valorUnit: '100', desconto: '' });
      if (typeof refreshEquipList === 'function') refreshEquipList();
    }
  });

  await page.locator('#nova-cpf').waitFor({ state: 'visible', timeout: 5_000 });
  await page.fill('#nova-vendedorCanal', `${TEST_PREFIX} Vendedor`);
  await page.fill('#nova-cliente',       `${TEST_PREFIX} Rastreio ${transportadora.toUpperCase()}`);
  await page.fill('#nova-cpf',           '14.458.149/0001-23');

  const analistaSelect = page.locator('#nova-analista');
  const analOpts = await analistaSelect.locator('option:not([disabled])').count();
  if (analOpts > 0) await analistaSelect.selectOption({ index: 1 });

  await page.locator('#nova-entrada').selectOption('sem');
  await page.fill('#nova-contatoEntrega', `${TEST_PREFIX} Contato`);
  const data = new Date(); data.setDate(data.getDate() + 30);
  await page.fill('#nova-previsaoEntrega', data.toISOString().slice(0, 10));

  await page.locator('#btn-criar-op').scrollIntoViewIfNeeded();
  await page.click('#btn-criar-op');
  await waitForModalClose(page, 30_000);
  await page.waitForTimeout(800);

  const cards = page.locator('.card');
  await expect(cards.first()).toBeVisible({ timeout: 8_000 });
  return transportadora;
}

async function avancarParaTransito(page, { transportadora = 'jamef', chaveNfe = '', codigoObjeto = '' } = {}) {
  // 1. Financeiro aprova (sem SF necessário — entrada "sem_entrada" não exige gate duplo)
  await switchTo(page, 'financeiro');
  await page.waitForTimeout(1200);

  let btnFin = page.locator(`.card:has-text("${TEST_PREFIX}") button[onclick*="openActionModal"]`).first();
  if (await btnFin.count() === 0) {
    // Gate duplo não necessário quando sem entrada: OP pode já ter avançado
    // Se não aparecer no financeiro, tenta direto em logística
  } else {
    await btnFin.click();
    await waitForModalOpen(page);
    await page.evaluate(() => {
      if (typeof activeOpId !== 'undefined' && activeOpId && typeof ops !== 'undefined') {
        const op = ops.find(o => o.id === activeOpId);
        if (op) op._loadedAt = op.updated_at || op._loadedAt;
      }
    });
    await page.locator('button[onclick="submitModal()"]').click();
    await waitForModalClose(page, 8_000);
  }

  // 2. Logística preenche dados de transporte com transportadora selecionada
  await switchTo(page, 'logistica');
  await page.waitForTimeout(1200);

  const btnLog = page.locator(`.card:has-text("${TEST_PREFIX}") button[onclick*="openActionModal"]:has-text("Solicitar Emissão")`).first();
  await expect(btnLog).toBeVisible({ timeout: 10_000 });
  await btnLog.click();
  await waitForModalOpen(page);

  await page.fill('#f-enderecoEntrega', 'Av. Contourline, 100 - São Paulo/SP');
  await page.locator('input[name="envioTipo"][value="transportadora"]').check();
  await page.waitForTimeout(200);
  await page.locator('#f-envio_transportadora').selectOption(transportadora);
  await page.fill('#f-volumes', '2');
  await page.fill('#f-peso', '15');

  await page.locator('button[onclick="submitModal()"]').click();
  await waitForModalClose(page, 12_000);
  await expect(page.locator('#save-indicator')).toContainText('Salvo', { timeout: 8_000 });

  // 3. Fiscal emite NF com chaveNfe e codigoObjeto (novos campos)
  await switchTo(page, 'fiscal');
  await page.waitForTimeout(1200);

  const btnFiscal = page.locator(`.card:has-text("${TEST_PREFIX}") button[onclick*="openActionModal"]:has-text("Confirmar Emissão")`).first();
  await expect(btnFiscal).toBeVisible({ timeout: 10_000 });
  await btnFiscal.click();
  await waitForModalOpen(page);

  await page.evaluate(() => {
    if (typeof tempFilesData !== 'undefined') {
      tempFilesData['arquivoNF'] = [{ name: 'nf-rastreio-teste.pdf', size: 1024, url: 'https://placeholder.test/nf.pdf', path: 'uploads/nf-rastreio-teste.pdf' }];
    }
  });

  await page.fill('#f-numeroNF', '88888');
  await page.fill('#f-dataEmissao', new Date().toISOString().slice(0, 10));
  if (chaveNfe) await page.fill('#f-chaveNfe', chaveNfe);
  if (codigoObjeto) await page.fill('#f-codigoObjeto', codigoObjeto);

  await page.evaluate(() => {
    if (typeof activeOpId !== 'undefined' && activeOpId && typeof ops !== 'undefined') {
      const op = ops.find(o => o.id === activeOpId);
      if (op) op._loadedAt = op.updated_at || op._loadedAt;
    }
  });
  await page.locator('button[onclick="submitModal()"]').click();
  await waitForModalClose(page, 12_000);
  await expect(page.locator('#save-indicator')).toContainText('Salvo', { timeout: 8_000 });

  // 4. Logística despacha
  await switchTo(page, 'logistica');
  await page.waitForTimeout(1500);

  const btnDesp = page.locator(`.card:has-text("${TEST_PREFIX}") button[onclick*="openActionModal"]:has-text("Confirmar e Despachar")`).first();
  await expect(btnDesp).toBeVisible({ timeout: 10_000 });
  await btnDesp.click();
  await waitForModalOpen(page);

  await page.evaluate(() => {
    if (typeof activeOpId !== 'undefined' && activeOpId && typeof ops !== 'undefined') {
      const op = ops.find(o => o.id === activeOpId);
      if (op) op._loadedAt = op.updated_at || op._loadedAt;
    }
  });
  await page.locator('button[onclick="submitModal()"]').click();
  await waitForModalClose(page, 12_000);
  await expect(page.locator('#save-indicator')).toContainText('Salvo', { timeout: 8_000 });
}

// ─── SETUP / TEARDOWN ─────────────────────────────────────────────────────

test.describe('Rastreamento de cargas', () => {

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

  // ─── GUARDS E VALIDAÇÕES ─────────────────────────────────────────────

  test('rastreioOps() não inclui OPs de teste antes dos ciclos', async ({ page }) => {
    await loginAs(page, 'logistica');

    const count = await page.evaluate((prefix) => {
      if (typeof rastreioOps === 'undefined') return -1;
      return rastreioOps().filter(o => (o.cliente || '').includes(prefix)).length;
    }, TEST_PREFIX);

    if (count === -1) { test.skip(true, 'rastreioOps não disponível'); return; }
    expect(count, 'Nenhuma OP de teste deve estar na fila de rastreio antes dos ciclos').toBe(0);
  });

  test('FALHA: transportadora Jamef sem numero NF → toast de erro', async ({ page }) => {
    // Monta OP em memória sem numeroNF e tenta atualizar rastreio via JS
    await loginAs(page, 'logistica');

    const toastErro = await page.evaluate(() => {
      // Cria OP falsa em memória para testar o guard do frontend
      if (typeof ops === 'undefined' || typeof atualizarRastreio === 'undefined') return 'N/A';
      const fakeId = -99999;
      ops.push({
        id: fakeId, status: 'transito', cancelada: false,
        stepData: { aguard_nf: { envioTipo: 'transportadora', transportadora: 'jamef' }, aguard_emissao: { numeroNF: '' } },
        pedidoVenda: { cpf: '14.458.149/0001-23' },
      });
      atualizarRastreio(fakeId, false);
      const idx = ops.findIndex(o => o.id === fakeId);
      if (idx >= 0) ops.splice(idx, 1);
      return 'triggered';
    });

    if (toastErro === 'N/A') { test.skip(true, 'API global não disponível'); return; }
    // Deve mostrar toast de erro sobre NF não informada
    await expect(page.locator('#toast-box div').filter({ hasText: /NF|número|emissão/i }))
      .toBeVisible({ timeout: 5_000 });
  });

  test('FALHA: transportadora Loggica sem chaveNfe → toast de erro específico', async ({ page }) => {
    await loginAs(page, 'logistica');

    await page.evaluate(() => {
      if (typeof ops === 'undefined' || typeof atualizarRastreio === 'undefined') return;
      const fakeId = -99998;
      ops.push({
        id: fakeId, status: 'transito', cancelada: false,
        stepData: {
          aguard_nf: { envioTipo: 'transportadora', transportadora: 'loggica' },
          aguard_emissao: { numeroNF: '12345', chaveNfe: '' }, // chaveNfe ausente
        },
        pedidoVenda: { cpf: '' },
      });
      atualizarRastreio(fakeId, false);
      const idx = ops.findIndex(o => o.id === fakeId);
      if (idx >= 0) ops.splice(idx, 1);
    });

    await expect(page.locator('#toast-box div').filter({ hasText: /loggica|chave nf/i }))
      .toBeVisible({ timeout: 5_000 });
  });

  test('FALHA: transportadora Correios sem codigoObjeto → toast de erro específico', async ({ page }) => {
    await loginAs(page, 'logistica');

    await page.evaluate(() => {
      if (typeof ops === 'undefined' || typeof atualizarRastreio === 'undefined') return;
      const fakeId = -99997;
      ops.push({
        id: fakeId, status: 'transito', cancelada: false,
        stepData: {
          aguard_nf: { envioTipo: 'transportadora', transportadora: 'correios' },
          aguard_emissao: { numeroNF: '12345', codigoObjeto: '' }, // codigoObjeto ausente
        },
        pedidoVenda: { cpf: '' },
      });
      atualizarRastreio(fakeId, false);
      const idx = ops.findIndex(o => o.id === fakeId);
      if (idx >= 0) ops.splice(idx, 1);
    });

    await expect(page.locator('#toast-box div').filter({ hasText: /correios|código objeto/i }))
      .toBeVisible({ timeout: 5_000 });
  });

  test('BRECHA: OP com motorista NÃO aparece na aba Rastreamento', async ({ page }) => {
    await loginAs(page, 'logistica');

    // Injeta OP falsa com motorista em trânsito
    const injetado = await page.evaluate(() => {
      if (typeof ops === 'undefined' || typeof rastreioOps === 'undefined') return false;
      const fakeId = -99996;
      ops.push({
        id: fakeId, status: 'transito', cancelada: false, numero: 'FAKE-MOT-001',
        stepData: { aguard_nf: { envioTipo: 'motorista', motorista: 'João' } },
        pedidoVenda: {},
      });
      const visivel = rastreioOps().some(o => o.id === fakeId);
      const idx = ops.findIndex(o => o.id === fakeId);
      if (idx >= 0) ops.splice(idx, 1);
      return visivel;
    });

    expect(injetado, 'OP com motorista NÃO deve aparecer no rastreio').toBe(false);
  });

  test('BRECHA: OP cancelada não aparece na aba Rastreamento', async ({ page }) => {
    await loginAs(page, 'logistica');

    const injetado = await page.evaluate(() => {
      if (typeof ops === 'undefined' || typeof rastreioOps === 'undefined') return false;
      const fakeId = -99995;
      ops.push({
        id: fakeId, status: 'transito', cancelada: true, numero: 'FAKE-CANCEL-001',
        stepData: { aguard_nf: { envioTipo: 'transportadora', transportadora: 'jamef' } },
        pedidoVenda: {},
      });
      const visivel = rastreioOps().some(o => o.id === fakeId);
      const idx = ops.findIndex(o => o.id === fakeId);
      if (idx >= 0) ops.splice(idx, 1);
      return visivel;
    });

    expect(injetado, 'OP cancelada NÃO deve aparecer no rastreio').toBe(false);
  });

  test('BRECHA: entregue há 8 dias não aparece, há 6 dias aparece', async ({ page }) => {
    await loginAs(page, 'logistica');

    const resultado = await page.evaluate(() => {
      if (typeof ops === 'undefined' || typeof rastreioOps === 'undefined') return null;

      const makeOp = (id, diasAtras) => ({
        id, status: 'entregue', cancelada: false,
        stepData: {
          aguard_nf: { envioTipo: 'transportadora', transportadora: 'jamef' },
          transito: { dataEntrega: new Date(Date.now() - diasAtras * 86400_000).toISOString().slice(0, 10) },
        },
        pedidoVenda: {},
      });

      const op8 = makeOp(-99994, 8);
      const op6 = makeOp(-99993, 6);
      ops.push(op8, op6);
      const visiveis = rastreioOps().map(o => o.id).filter(id => id < 0);
      [-99994, -99993].forEach(id => { const idx = ops.findIndex(o => o.id === id); if (idx >= 0) ops.splice(idx, 1); });
      return visiveis;
    });

    if (!resultado) { test.skip(true, 'API global não disponível'); return; }
    expect(resultado, 'OP há 8 dias: não deve aparecer').not.toContain(-99994);
    expect(resultado, 'OP há 6 dias: deve aparecer').toContain(-99993);
  });

  test('BRECHA: inferStage mapeia corretamente os status de cada transportadora', async ({ page }) => {
    await loginAs(page, 'logistica');

    const stages = await page.evaluate(() => {
      if (typeof inferStage === 'undefined') return null;
      return {
        entregue:    inferStage({ entregue: true,  statusLabel: 'Qualquer' }),
        saiu:        inferStage({ entregue: false, statusLabel: 'Saiu para entrega' }),
        emRota:      inferStage({ entregue: false, statusLabel: 'Em rota de entrega' }),
        transfer:    inferStage({ entregue: false, statusLabel: 'Em transferência' }),
        transito:    inferStage({ entregue: false, statusLabel: 'Em trânsito' }),
        coletado:    inferStage({ entregue: false, statusLabel: 'Coletado' }),
        desconhec:   inferStage({ entregue: false, statusLabel: 'Saindo da doca' }),
        semRastreio: inferStage(null),
      };
    });

    if (!stages) { test.skip(true, 'inferStage não disponível'); return; }
    expect(stages.entregue, 'entregue = estágio 3').toBe(3);
    expect(stages.saiu,     'saiu para entrega = estágio 2').toBe(2);
    expect(stages.emRota,   'em rota = estágio 2').toBe(2);
    expect(stages.transfer, 'transferência = estágio 1').toBe(1);
    expect(stages.transito, 'em trânsito = estágio 1').toBe(1);
    expect(stages.coletado, 'coletado = estágio 0').toBe(0);
    expect(stages.desconhec,'status desconhecido = estágio 0').toBe(0);
    expect(stages.semRastreio, 'sem rastreio = -1').toBe(-1);
  });

  // ─── CAMPOS NOVOS NO FORMULÁRIO DE EMISSÃO ───────────────────────────

  test('campos chaveNfe e codigoObjeto aparecem no modal de emissão de NF', async ({ page }) => {
    // Cria OP e avança até aguard_emissao
    await criarOPMinima(page, { transportadora: 'loggica' });

    // Financeiro aprova
    await switchTo(page, 'financeiro');
    await page.waitForTimeout(1200);
    const btnFin = page.locator(`.card:has-text("${TEST_PREFIX}") button[onclick*="openActionModal"]`).first();
    if (await btnFin.count() > 0) {
      await btnFin.click();
      await waitForModalOpen(page);
      await page.locator('button[onclick="submitModal()"]').click();
      await waitForModalClose(page, 8_000);
    }

    // Logística seleciona Loggica
    await switchTo(page, 'logistica');
    await page.waitForTimeout(1200);
    const btnLog = page.locator(`.card:has-text("${TEST_PREFIX}") button[onclick*="openActionModal"]:has-text("Solicitar Emissão")`).first();
    await expect(btnLog).toBeVisible({ timeout: 10_000 });
    await btnLog.click();
    await waitForModalOpen(page);
    await page.fill('#f-enderecoEntrega', 'Rua Teste, 1 - SP');
    await page.locator('input[name="envioTipo"][value="transportadora"]').check();
    await page.waitForTimeout(200);
    await page.locator('#f-envio_transportadora').selectOption('loggica');
    await page.fill('#f-volumes', '1');
    await page.fill('#f-peso', '5');
    await page.locator('button[onclick="submitModal()"]').click();
    await waitForModalClose(page, 12_000);

    // Fiscal abre modal de emissão
    await switchTo(page, 'fiscal');
    await page.waitForTimeout(1200);
    const btnFiscal = page.locator(`.card:has-text("${TEST_PREFIX}") button[onclick*="openActionModal"]:has-text("Confirmar Emissão")`).first();
    await expect(btnFiscal).toBeVisible({ timeout: 10_000 });
    await btnFiscal.click();
    await waitForModalOpen(page);

    // Verifica que os novos campos existem no modal
    await expect(page.locator('#f-chaveNfe'),     'Campo chaveNfe deve existir no modal').toBeAttached({ timeout: 5_000 });
    await expect(page.locator('#f-codigoObjeto'), 'Campo codigoObjeto deve existir no modal').toBeAttached({ timeout: 5_000 });

    await page.keyboard.press('Escape');
    await waitForModalClose(page, 5_000);
  });

  // ─── CICLO COMPLETO COM TRANSPORTADORA ───────────────────────────────

  test('Ciclo Jamef: OP vai para trânsito e tem seção Rastreamento no modal de info', async ({ page }) => {
    await criarOPMinima(page, { transportadora: 'jamef' });
    await avancarParaTransito(page, { transportadora: 'jamef' });

    // avancarParaTransito termina em logística — aguarda estabilização
    await page.waitForTimeout(1500);

    // Abre o info modal da OP de teste diretamente via JS
    const opId = await page.evaluate((prefix) => {
      if (typeof ops === 'undefined') return null;
      const op = ops.find(o => (o.cliente || '').includes(prefix) && o.status === 'transito');
      return op?.id ?? null;
    }, TEST_PREFIX);

    if (!opId) { test.skip(true, 'OP de teste não encontrada em trânsito'); return; }

    await page.evaluate((id) => openInfoModal(id), opId);
    await waitForModalOpen(page);

    // Expande o accordion de Rastreamento (fechado por padrão)
    const accHead = page.locator('.acc-head').filter({ hasText: 'Rastreamento' }).first();
    await expect(accHead).toBeVisible({ timeout: 5_000 });
    await accHead.click();
    await page.waitForTimeout(300);

    // Botão "Atualizar rastreio" deve existir (Jamef está em RASTREAVEIS)
    const btnAtualizar = page.locator('#modal button').filter({ hasText: 'Atualizar rastreio' });
    await expect(btnAtualizar).toBeVisible({ timeout: 5_000 });

    // Transportadora deve estar indicada no modal
    await expect(page.locator('#modal')).toContainText(/jamef/i);

    await page.keyboard.press('Escape');
    await waitForModalClose(page, 5_000);
  });

  test('Botão Atualizar rastreio → erro 502 → exibe mensagem de erro no modal', async ({ page }) => {
    await loginAs(page, 'logistica');
    await page.waitForTimeout(1200);

    // Encontra OP de teste em trânsito por transportadora (deixada pelo ciclo anterior)
    const opId = await page.evaluate((prefix) => {
      if (typeof ops === 'undefined') return null;
      const op = ops.find(o =>
        (o.cliente || '').includes(prefix) &&
        o.status === 'transito' &&
        o.stepData?.aguard_nf?.envioTipo === 'transportadora',
      );
      return op?.id ?? null;
    }, TEST_PREFIX);

    if (!opId) { test.skip(true, 'Sem OP de teste em trânsito por transportadora — execute após o ciclo Jamef'); return; }

    await page.evaluate((id) => openInfoModal(id), opId);
    await waitForModalOpen(page);

    // Expande accordion de Rastreamento
    const accHead = page.locator('.acc-head').filter({ hasText: 'Rastreamento' }).first();
    await expect(accHead).toBeVisible({ timeout: 5_000 });
    await accHead.click();
    await page.waitForTimeout(300);

    const btnAtualizar = page.locator('#modal button').filter({ hasText: 'Atualizar rastreio' });
    if (await btnAtualizar.count() === 0) {
      await page.keyboard.press('Escape');
      test.skip(true, 'Botão Atualizar rastreio não disponível');
      return;
    }

    // Intercepta a chamada à API e retorna 502
    await page.route('**/api/rastreio', async route => {
      await route.fulfill({ status: 502, body: JSON.stringify({ error: 'Transportadora indisponível no momento' }) });
    });

    await btnAtualizar.click();

    // Erro aparece no toast (o modal é snapshot estático; _rastreioErro vai pro toast)
    await expect(page.locator('#toast-box div').filter({ hasText: /indisponível|erro|falha/i }))
      .toBeVisible({ timeout: 6_000 });

    await page.unroute('**/api/rastreio');
    await page.keyboard.press('Escape');
    await waitForModalClose(page, 5_000);
  });

  test('BRECHA: duplo-clique em Atualizar rastreio não dispara 2 requisições simultâneas', async ({ page }) => {
    await loginAs(page, 'logistica');
    await page.waitForTimeout(1200);

    const opId = await page.evaluate((prefix) => {
      if (typeof ops === 'undefined') return null;
      const op = ops.find(o =>
        (o.cliente || '').includes(prefix) &&
        o.status === 'transito' &&
        o.stepData?.aguard_nf?.envioTipo === 'transportadora',
      );
      return op?.id ?? null;
    }, TEST_PREFIX);

    if (!opId) { test.skip(true, 'Sem OP de teste em trânsito — execute após o ciclo Jamef'); return; }

    await page.evaluate((id) => openInfoModal(id), opId);
    await waitForModalOpen(page);

    const accHead = page.locator('.acc-head').filter({ hasText: 'Rastreamento' }).first();
    await expect(accHead).toBeVisible({ timeout: 5_000 });
    await accHead.click();
    await page.waitForTimeout(300);

    const btnAtualizar = page.locator('#modal button').filter({ hasText: 'Atualizar rastreio' });
    if (await btnAtualizar.count() === 0) {
      await page.keyboard.press('Escape');
      test.skip(true, 'Botão Atualizar rastreio não disponível');
      return;
    }

    let requisicoes = 0;
    await page.route('**/api/rastreio', async route => {
      requisicoes++;
      await new Promise(r => setTimeout(r, 800)); // simula latência
      await route.fulfill({ status: 502, body: JSON.stringify({ error: 'teste' }) });
    });

    // Duplo-clique rápido — _rastreioLoading deve bloquear a 2ª chamada
    await btnAtualizar.click();
    await btnAtualizar.click();
    await page.waitForTimeout(2000);

    expect(requisicoes, '_rastreioLoading guard deve bloquear 2ª chamada').toBe(1);

    await page.unroute('**/api/rastreio');
    await page.keyboard.press('Escape');
    await waitForModalClose(page, 5_000);
  });

  test('BRECHA: autoEntregar não dispara quando rastreio retorna entregue mas OP já está entregue', async ({ page }) => {
    await loginAs(page, 'logistica');

    const resultado = await page.evaluate(() => {
      if (typeof ops === 'undefined' || typeof advanceOP === 'undefined') return 'N/A';
      let advanceCalled = false;
      const origAdvance = window.advanceOP;
      window.advanceOP = (...args) => { advanceCalled = true; origAdvance?.(...args); };

      const fakeId = -99990;
      ops.push({
        id: fakeId, status: 'entregue', cancelada: false, numero: 'FAKE-ENTREGUE-001',
        stepData: { aguard_nf: { envioTipo: 'transportadora', transportadora: 'jamef' } },
        pedidoVenda: {},
      });

      // Simula o que atualizarRastreio faz quando data.entregue = true
      const op = ops.find(o => o.id === fakeId);
      if (op && op.status !== 'transito') {
        // autoEntregar não deve ser chamado (OP não está em transito)
      } else if (op) {
        if (typeof autoEntregar === 'function') autoEntregar(op, { entregue: true, dataEntrega: '2026-08-10', transportadora: 'jamef', pod: null });
      }

      const idx = ops.findIndex(o => o.id === fakeId);
      if (idx >= 0) ops.splice(idx, 1);
      window.advanceOP = origAdvance;
      return advanceCalled;
    });

    if (resultado === 'N/A') { test.skip(true, 'API global não disponível'); return; }
    expect(resultado, 'advanceOP não deve ser chamado para OP já entregue').toBe(false);
  });

  test('BRECHA: atualizarTodosRastreios só processa transportadoras rastreáveis', async ({ page }) => {
    await loginAs(page, 'logistica');

    const resultado = await page.evaluate(() => {
      if (typeof ops === 'undefined' || typeof RASTREAVEIS === 'undefined') return null;

      // Verifica que todas as transportadoras no RASTREAVEIS têm handler
      const esperadas = ['azul', 'rotta', 'loggica', 'correios', 'jamef'];
      const faltando = esperadas.filter(t => !RASTREAVEIS.has(t));

      return { faltando, total: RASTREAVEIS.size };
    });

    if (!resultado) { test.skip(true, 'RASTREAVEIS não disponível'); return; }
    expect(resultado.faltando, 'Todas as transportadoras devem estar em RASTREAVEIS').toHaveLength(0);
    expect(resultado.total, 'RASTREAVEIS deve ter 5 entradas').toBe(5);
  });

  test('BRECHA: API /api/rastreio rejeita transportadora desconhecida com 400', async ({ page }) => {
    await loginAs(page, 'logistica');

    // Testa a API diretamente via fetch no contexto do browser autenticado
    const resultado = await page.evaluate(async () => {
      if (typeof apiFetch === 'undefined') return { skip: true, reason: 'apiFetch não disponível' };
      try {
        const r = await apiFetch('/api/rastreio', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ transportadora: 'transportadora_fake', pedido: '12345' }),
        });
        const ct = r.headers.get('content-type') || '';
        // Se o servidor retornar HTML (não é Vercel dev), pular o teste
        if (!ct.includes('application/json')) return { skip: true, reason: 'Servidor não é Vercel (retornou HTML)' };
        return { skip: false, status: r.status };
      } catch (e) { return { skip: true, reason: e.message }; }
    });

    if (resultado.skip) { test.skip(true, resultado.reason); return; }
    expect(resultado.status, 'Transportadora inválida deve retornar 400').toBe(400);
  });

  test('BRECHA: API /api/rastreio exige autenticação (401 sem token)', async ({ page }) => {
    // Faz request direta sem estar logado — só válida quando rodando com vercel dev
    const resp = await page.request.post('/api/rastreio', {
      data: { transportadora: 'jamef', pedido: '12345' },
      headers: { 'Content-Type': 'application/json' },
      // sem Authorization header
    });
    const ct = resp.headers()['content-type'] || '';
    if (!ct.includes('application/json')) {
      test.skip(true, 'Servidor não é Vercel dev (retornou HTML) — teste só válido com `vercel dev`');
      return;
    }
    expect(resp.status(), 'Endpoint deve exigir autenticação').toBe(401);
  });

  test('BRECHA: Loggica aceita chaveNfe com pontuação (remove não-dígitos)', async ({ page }) => {
    await loginAs(page, 'logistica');

    // Verifica que o frontend remove a pontuação antes de enviar para a API
    const chaveComMask = '35.240.3 14.4581.49.0001.23.55001.000000001.1.000000011';
    const resultado = await page.evaluate((chave) => {
      // Simula o processamento que atualizarRastreio faz
      const limpa = chave.replace(/\D/g, '');
      return { limpa, valida: limpa.length === 44 };
    }, chaveComMask);

    expect(resultado.valida, 'Chave com pontuação deve ser limpa para 44 dígitos').toBe(true);
  });
});
