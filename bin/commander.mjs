// 第三層的指令模式：講「進到台積電的個股頁」「打開設定」「搜尋鴻海」，直接操作最前面的 app。
// 每一步：列出畫面上可以操作的東西 → 決策器（Jev）挑「點、填字、按 Enter、完成、做不到」和對象 → 做 → 等畫面更新。
// 安全：刪除、送出、付款、下單、登出這類按鈕不列進選項；信心不夠就停；最多 8 步；密碼框不填。

import { describeElement, stepQuestions } from './decide.mjs';

const MAX_STEPS = 8;
const SETTLE_MS = 700;
const DANGER = /刪除|移除|清空|送出|傳送|發送|發布|付款|購買|結帳|下單|買進|賣出|轉帳|匯款|登出|解除|取消訂閱|delete|remove|send|submit|publish|post|pay|buy|checkout|order|sign ?out|log ?out|transfer|unsubscribe/i;
const ACTION_MIN = 0.5;
const TARGET_MIN = 0.4;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const safeElements = (list) => list.filter((e) => !DANGER.test(e.label ?? '') && e.subrole !== 'AXSecureTextField');

// { goal, text, app }；frontApp() 取最前面的 app；openApp(name) 把 app 叫到前面
export async function runCommand({ ax, decider, log, frontApp, openApp, goal, text = '', app = '', context = {} }) {
  let front = await frontApp();
  if (app && !(context.app ?? '').toLowerCase().includes(app.toLowerCase())) {
    log(`指令：先切到 ${app}`);
    if (!(await openApp(app))) return { ok: false, reason: `找不到 app「${app}」` };
    await sleep(SETTLE_MS);
    front = await frontApp();
  }
  const done = [];
  let filled = 0; // 剛填字的輸入框，按 Enter 用
  for (let step = 0; step < MAX_STEPS; step += 1) {
    const snap = await ax.call('elements', { pid: front.pid, limit: 150 }, 8000);
    const list = safeElements(snap.elements ?? []);
    const state = {
      goal,
      text,
      app: context.app ?? '',
      window: snap.window?.title ?? '',
      done_steps: done,
      screen: list.map((e, i) => `e${i} ${describeElement(e, snap.window)}`),
    };
    const started = Date.now();
    const answers = await decider.decide(state, stepQuestions(list, snap.window));
    const action = answers.action ?? {};
    const target = answers.target ?? {};
    const el = list[Number(String(target.choice ?? '').slice(1))];
    log(`指令第 ${step + 1} 步（${decider.engine()}，${Date.now() - started} ms）：${action.choice}（${(action.confidence ?? 0).toFixed(2)}）${el ? ` → ${describeElement(el, snap.window)}（${(target.confidence ?? 0).toFixed(2)}）` : ''}`);
    if (action.choice === 'done') return { ok: true, steps: done };
    if (action.choice === 'stuck' || (action.confidence ?? 0) < ACTION_MIN) return { ok: false, reason: '不確定下一步，停下來', steps: done };
    if (action.choice === 'enter') {
      const r = await ax.call('act', { pid: front.pid, handle: filled, action: 'enter' });
      if (r.result !== 'ok') return { ok: false, reason: `按 Enter 沒成功（${r.result}）`, steps: done };
      done.push('按了 Enter');
    } else {
      if (!el || (target.confidence ?? 0) < TARGET_MIN) return { ok: false, reason: '不確定要點哪一個，停下來', steps: done };
      if (action.choice === 'fill') {
        if (!text) return { ok: false, reason: '要填字，但指令裡沒有要填的字', steps: done };
        const r = await ax.call('act', { pid: front.pid, handle: el.handle, action: 'fill', text });
        if (r.result !== 'ok') return { ok: false, reason: `填字沒成功（${r.result}）`, steps: done };
        filled = el.handle;
        done.push(`在${describeElement(el, snap.window)}填了「${text}」`);
      } else {
        const r = await ax.call('act', { pid: front.pid, handle: el.handle, action: 'press' });
        if (r.result !== 'ok') return { ok: false, reason: `點不下去（${r.result}）`, steps: done };
        done.push(`點了${describeElement(el, snap.window)}`);
      }
    }
    await sleep(SETTLE_MS);
  }
  return { ok: false, reason: `做了 ${MAX_STEPS} 步還沒完成，停下來`, steps: done };
}
