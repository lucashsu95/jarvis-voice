// AX 小幫手對真的視窗：開 tests/fixtures/test-window.js（不搶前景），讀上下文、找輸入框、對焦、列元件。
// 不送任何按鍵：測試視窗不在最前面，貼上要回 not-front，填字改成直接設值。跑測試的程式沒有「輔助使用」權限就跳過。

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { createAx } from '../bin/ax.mjs';
import { runCommand } from '../bin/commander.mjs';
import { createDecider } from '../bin/decide.mjs';

const ax = createAx();
after(() => ax.close());
const trusted = process.platform === 'darwin' && (await ax.call('check', { ask: false }).catch(() => ({}))).trusted;

test('AX 小幫手：讀上下文、找輸入框、對焦、列元件；不在前景不貼', { skip: !trusted && '沒有輔助使用權限', timeout: 30_000 }, async () => {
  const win = spawn('/usr/bin/osascript', ['-l', 'JavaScript', join(import.meta.dirname, 'fixtures', 'test-window.js')], { stdio: 'ignore' });
  try {
    const pid = win.pid;
    let ctx;
    for (let i = 0; i < 40; i += 1) {
      ctx = await ax.call('context', { pid, chars: 400 }).catch(() => null);
      if (ctx?.field?.editable) break;
      await new Promise((r) => setTimeout(r, 150));
    }
    assert.equal(ctx.window, '全語音輸入測試視窗');
    assert.deepEqual([ctx.field.role, ctx.field.label, ctx.field.before, ctx.field.after], ['AXTextArea', '訊息', '今天的待辦：', '']);

    const found = await ax.call('targets', { pid });
    const byLabel = Object.fromEntries(found.candidates.map((c) => [c.label, c]));
    assert.equal(byLabel['搜尋'].subrole, 'AXSearchField');
    assert.equal(byLabel['密碼'].subrole, 'AXSecureTextField');
    assert.equal(byLabel['訊息'].focused, true);

    assert.equal((await ax.call('focus', { handle: byLabel['主旨'].handle })).ok, true);
    const moved = await ax.call('context', { pid });
    assert.equal(moved.field.label, '主旨');

    await ax.call('focus', { handle: byLabel['密碼'].handle });
    const secret = await ax.call('context', { pid });
    assert.equal(secret.field.secure, true);
    assert.equal(secret.field.before, undefined); // 密碼欄不讀內容

    assert.equal((await ax.call('read', { handle: byLabel['訊息'].handle })).value, '今天的待辦：');
    const { elements } = await ax.call('elements', { pid });
    assert.deepEqual(elements.map((e) => e.label), ['搜尋', '主旨', '密碼', '訊息']);

    await ax.call('focus', { handle: byLabel['訊息'].handle });
    assert.equal((await ax.call('paste', { pid, text: '不該貼出去' })).result, 'not-front');
    assert.equal((await ax.call('replace', { pid, old: '不在這裡', text: '' })).result, 'mismatch');
    // 不在前景時填字是直接設值，不送按鍵
    assert.equal((await ax.call('act', { pid, handle: byLabel['主旨'].handle, action: 'fill', text: '週會改期' })).result, 'ok');
    assert.equal((await ax.call('read', { handle: byLabel['主旨'].handle })).value, '週會改期');
  } finally {
    win.kill();
  }
});

async function openStockWindow() {
  const win = spawn('/usr/bin/osascript', ['-l', 'JavaScript', join(import.meta.dirname, 'fixtures', 'stock-window.js')], { stdio: 'ignore' });
  for (let i = 0; i < 40; i += 1) {
    const r = await ax.call('elements', { pid: win.pid }).catch(() => null);
    if (r?.elements?.length) break;
    await new Promise((res) => setTimeout(res, 150));
  }
  return win;
}

const title = async (pid) => (await ax.call('elements', { pid })).window.title;

test('指令模式對真的視窗（背景、不送按鍵）：填字 → 確認 → 點結果，刪除按鈕不在選項裡', { skip: !trusted && '沒有輔助使用權限', timeout: 30_000 }, async () => {
  const win = await openStockWindow();
  try {
    const plan = [['fill', '搜尋股票'], ['enter', ''], ['click', '台積電 2330'], ['done', '']];
    let options = '';
    const decider = {
      engine: () => '劇本',
      async decide(state, questions) {
        options += Object.values(questions.target.criteria).join('|');
        const [action, label] = plan[state.done_steps.length];
        const hit = Object.entries(questions.target.criteria).find(([, d]) => label && d.includes(`「${label}」`));
        return { action: { choice: action, confidence: 0.9 }, target: { choice: hit?.[0] ?? 'e0', confidence: hit ? 0.9 : 0.1 } };
      },
    };
    const result = await runCommand({
      ax, decider, log: () => {}, frontApp: async () => ({ pid: win.pid }), openApp: async () => true,
      goal: '打開台積電（2330）的個股頁', text: '台積電', context: { app: '看盤' },
    });
    assert.equal(result.ok, true, result.reason);
    assert.equal(await title(win.pid), '台積電 2330 個股');
    assert.ok(!options.includes('刪除自選'));
  } finally {
    win.kill();
  }
});

// 有 TYPESAFE_API_KEY 才跑：真的 Jev 決定每一步
test('指令模式 + 真的 Jev', { skip: (!trusted && '沒有輔助使用權限') || (!process.env.TYPESAFE_API_KEY && '沒有 TYPESAFE_API_KEY'), timeout: 60_000 }, async () => {
  const win = await openStockWindow();
  try {
    const decider = createDecider(() => ({ jevKey: process.env.TYPESAFE_API_KEY, jevModel: 'jev-latest' }));
    const base = { ax, decider, log: () => {}, frontApp: async () => ({ pid: win.pid }), openApp: async () => true, context: { app: '看盤' } };
    assert.equal((await runCommand({ ...base, goal: '打開台積電（2330）的個股頁', text: '台積電' })).ok, true);
    assert.equal(await title(win.pid), '台積電 2330 個股');
    assert.equal((await runCommand({ ...base, goal: '打開設定頁', text: '' })).ok, true);
    assert.equal(await title(win.pid), '設定');
  } finally {
    win.kill();
  }
});
