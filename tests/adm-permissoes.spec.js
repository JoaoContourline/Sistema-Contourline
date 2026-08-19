// adm-permissoes.spec.js — verifica as correções de permissão de 19/08/2026.
//
// Cobre o que não dava para testar sem uma conta ADM:
//   1. ops_update passou a incluir 'adm' (a OP criada pelo ADM mantém o número)
//   2. o ADM consegue avançar etapa (antes a RLS recusava em silêncio)
//   3. profiles_admin_update (o toggle de chat do painel admin persiste)
//   4. cancelar/reativar OP é exclusivo do gestor
//
// As asserções leem o estado DEPOIS de um reload, não a memória do app — o bug
// original era justamente o app mostrar certo na tela e errado no banco.
import { test, expect } from '@playwright/test';
import { loginAs, logout } from './helpers/auth.js';
import { TEST_PREFIX } from './helpers/op.js';
import { waitForModalOpen, waitForModalClose } from './helpers/modal.js';

const PV_TESTE = 'TESTE-ADM-PV';

/** Espera o loadOps() TERMINAR.
 *  Cuidado com dois falsos sinais: `ops` nasce como [] no topo do script (então
 *  Array.isArray passa na hora) e, logo após um reload, o #main ainda nem
 *  recebeu o placeholder "Carregando OPs…" (então checar a ausência dele também
 *  passa cedo demais). O único sinal positivo é o array populado. */
async function esperarOps(page) {
  await page.waitForFunction(
    () => typeof ops !== 'undefined' && Array.isArray(ops) && ops.length > 0,
    null, { timeout: 25_000 });
  await page.waitForTimeout(300);
}

/** Espera a OP `id` aparecer no array vindo do banco. Se estourar o timeout, é
 *  porque ela realmente não foi persistida — que é exatamente o bug testado. */
async function esperarOpNoBanco(page, id, timeout = 25_000) {
  await page.waitForFunction(
    _id => typeof ops !== 'undefined' && ops.some(o => o.id === _id),
    id, { timeout });
}

/** Lê a OP direto do array do app (que reflete o que veio do banco). */
function lerOp(page, id) {
  return page.evaluate(_id => {
    const o = ops.find(x => x.id === _id);
    return o ? { id: o.id, numero: o.numero, status: o.status, pv: o.pedidoProtheus, cliente: o.cliente,
                 aprovadoFin: o.stepData?.aguard_financeiro?.aprovado === true,
                 nHistorico: (o.history || []).length } : null;
  }, id);
}

test.describe('Permissões do ADM', () => {
  let opId = null;

  test('1. ADM cria OP e o número sobrevive ao reload (ops_update inclui adm)', async ({ page }) => {
    await loginAs(page, 'adm');
    await esperarOps(page);

    const btnNova = page.locator('#btnNovaOP');
    await expect(btnNova, 'ADM precisa enxergar o botão Nova OP').toBeVisible({ timeout: 8_000 });
    await btnNova.click();
    await waitForModalOpen(page);

    // Revela o formulário completo sem depender do Protheus (mesmo bypass do op-lifecycle)
    await page.waitForSelector('#nova-form-fields', { state: 'attached' });
    await page.evaluate(pv => {
      document.getElementById('nova-form-fields').style.display = 'block';
      const f = document.getElementById('nova-modal-footer'); if (f) f.style.display = '';
      const p = document.getElementById('nova-numPedido'); if (p) p.value = pv;
      tempEquipList.length = 0;
      tempEquipList.push({ name: 'ADM TEST Equipamento', code: '', qty: 1, valorUnit: '100', desconto: '', tes: '624' });
      refreshEquipList();
    }, PV_TESTE);

    await page.locator('#nova-cpf').waitFor({ state: 'visible', timeout: 5_000 });
    await page.fill('#nova-vendedorCanal', `${TEST_PREFIX} Vendedor ADM`);
    await page.fill('#nova-cliente', `${TEST_PREFIX} ADM PERMISSOES`);
    await page.fill('#nova-cpf', '11.222.333/0001-81');
    const analista = page.locator('#nova-analista');
    if (await analista.locator('option:not([disabled])').count() > 0) await analista.selectOption({ index: 1 });
    await page.locator('#nova-entrada').selectOption('pendente');
    await page.evaluate(() => {
      const el = document.getElementById('nova-valorEntrada');
      if (el) { el.value = '100,00'; el.dispatchEvent(new Event('input', { bubbles: true })); }
      const row = document.getElementById('nova-entrada-row'); if (row) row.style.display = '';
    });
    await page.fill('#nova-contatoEntrega', `${TEST_PREFIX} Contato`);
    const d = new Date(); d.setDate(d.getDate() + 30);
    await page.fill('#nova-previsaoEntrega', d.toISOString().slice(0, 10));

    await page.locator('#btn-criar-op').scrollIntoViewIfNeeded();
    await page.click('#btn-criar-op');
    await waitForModalClose(page, 30_000);
    await page.waitForTimeout(1500);

    const naTela = await page.evaluate(p => {
      const o = ops.find(x => x.pedidoProtheus === p);
      return o ? { id: o.id, numero: o.numero, pv: o.pedidoProtheus } : null;
    }, PV_TESTE);
    expect(naTela, 'a OP deveria existir na memória do app após a criação').not.toBeNull();
    opId = naTela.id;
    console.log('   criada na tela → id=' + naTela.id + ' numero=' + JSON.stringify(naTela.numero));

    // O TESTE DE VERDADE: recarrega e relê do banco.
    await page.reload();
    await esperarOpNoBanco(page, opId);
    const noBanco = await lerOp(page, opId);
    console.log('   após o reload  → numero=' + JSON.stringify(noBanco?.numero) + ' pv=' + JSON.stringify(noBanco?.pv));

    expect(noBanco, 'a OP sumiu depois do reload').not.toBeNull();
    expect(noBanco.numero, 'numero ficou PENDENTE — ops_update ainda recusa o adm').not.toBe('PENDENTE');
    expect(noBanco.numero, 'numero veio vazio do banco').toBeTruthy();
    expect(noBanco.numero, 'o número deveria seguir o padrão N/AAAA').toMatch(/^\d+\/\d{4}/);
    expect(noBanco.pv, 'o vínculo com o PV se perdeu no banco').toBe(PV_TESTE);
    expect(noBanco.numero, 'o PV deveria aparecer no número').toContain(PV_TESTE);
  });

  test('2. ADM aprova o financeiro e a escrita chega ao banco', async ({ page }) => {
    test.skip(!opId, 'depende da OP criada no teste 1');
    await loginAs(page, 'adm');
    await esperarOps(page);

    const antes = await lerOp(page, opId);
    expect(antes.status).toBe('aguard_financeiro');
    expect(antes.aprovadoFin, 'a OP não deveria nascer aprovada').toBe(false);

    // O ADM age simulando o setor dono da etapa (é como o switcher funciona).
    await page.evaluate(id => {
      setGestorView('financeiro');
      advanceOP(id, { descricao: 'Aprovado pelo teste automatizado de permissões do ADM' });
    }, opId);
    await page.waitForTimeout(2500);

    await page.reload();
    await esperarOpNoBanco(page, opId);
    const depois = await lerOp(page, opId);
    console.log('   aprovadoFin: ' + antes.aprovadoFin + ' → ' + depois.aprovadoFin
      + '  ·  histórico: ' + antes.nHistorico + ' → ' + depois.nHistorico
      + '  ·  status: ' + depois.status);

    // O QUE ESTE TESTE PROVA: a escrita do ADM chegou ao Postgres. Antes da
    // correção a RLS recusava devolvendo 0 linhas, sem erro, e nada persistia.
    expect(depois.aprovadoFin, 'a aprovação do financeiro não chegou ao banco — a RLS recusou o adm').toBe(true);
    expect(depois.nHistorico, 'o histórico não cresceu — nada foi gravado').toBeGreaterThan(antes.nHistorico);

    // E o status NÃO avança de propósito: esta OP tem TES 624, então a porta
    // dupla segura em aguard_financeiro até o fiscal lançar o Simples
    // Faturamento. Aprovar o financeiro sozinho não move a OP.
    expect(depois.status, 'com TES 624 pendente a OP tem de esperar o Simples Faturamento').toBe('aguard_financeiro');
  });

  test('3. ADM liga o chat de um usuário e a mudança persiste (profiles_admin_update)', async ({ page }) => {
    await loginAs(page, 'adm');
    await esperarOps(page);

    const alvo = await page.evaluate(async () => {
      const { data } = await sb.from('profiles').select('id,name,sector_id,chat_enabled').eq('sector_id', 'comercial').limit(1);
      return data?.[0] || null;
    });
    expect(alvo, 'nenhum perfil comercial encontrado para o teste').not.toBeNull();

    const novoValor = !alvo.chat_enabled;
    await page.evaluate(async ([id, v]) => { await toggleUserChat(id, v); }, [alvo.id, novoValor]);
    await page.waitForTimeout(1500);

    await page.reload();
    await esperarOps(page);
    const persistido = await page.evaluate(async id => {
      const { data } = await sb.from('profiles').select('chat_enabled').eq('id', id).single();
      return data?.chat_enabled;
    }, alvo.id);
    console.log('   chat_enabled de ' + alvo.name + ': ' + alvo.chat_enabled + ' → ' + persistido + ' (esperado ' + novoValor + ')');
    expect(persistido, 'o toggle de chat do ADM não gravou — falta profiles_admin_update').toBe(novoValor);

    // devolve ao valor original
    await page.evaluate(async ([id, v]) => { await toggleUserChat(id, v); }, [alvo.id, alvo.chat_enabled]);
  });

  test('4. Cancelar OP: só o gestor enxerga o botão', async ({ page }) => {
    test.skip(!opId, 'depende da OP criada no teste 1');

    for (const papel of ['logistica', 'fiscal', 'adm']) {
      await loginAs(page, papel);
      await esperarOps(page);
      await page.evaluate(id => openInfoModal(id), opId);
      await waitForModalOpen(page);
      const n = await page.locator('#modal button', { hasText: 'Cancelar OP' }).count();
      console.log('   ' + papel.padEnd(10) + ' → botão Cancelar OP visível: ' + (n > 0));
      expect(n, `${papel} não deveria poder cancelar OP`).toBe(0);
      await page.evaluate(() => closeModal());
      // Sem deslogar, o loginAs seguinte cai no app ja autenticado e fica
      // esperando por um #loginEmail que nunca aparece.
      await logout(page);
    }

    await loginAs(page, 'gestor');
    await esperarOps(page);
    await page.evaluate(id => openInfoModal(id), opId);
    await waitForModalOpen(page);
    const nGestor = await page.locator('#modal button', { hasText: 'Cancelar OP' }).count();
    console.log('   gestor     → botão Cancelar OP visível: ' + (nGestor > 0));
    expect(nGestor, 'o gestor precisa continuar podendo cancelar').toBeGreaterThan(0);
  });
});
