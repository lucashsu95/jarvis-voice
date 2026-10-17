// 第三層的快速決策：TypeSafe 的 System One 模型 Jev（https://typesafe.ai）。
// Jev 不寫字，只在給定的選項裡挑、給機率（choice），或回答是非的機率（noul）；從台灣打一次約 0.2 秒。
// 用在：這段話是「要打的字」還是「要操作 app 的指令」、游標不在輸入框時寫進哪個框、指令模式每一步點哪裡。
// 沒有 Jev key 時，同樣的問題改問 AI 整理用的那家（慢一點，約 1 秒）。

import { ask } from './editor.mjs';

async function askJev({ apiKey, model = 'jev-latest', state, questions, timeoutMs = 4000 }) {
  const url = process.env.VOICE_DICTATION_JEV_URL || 'https://api.typesafe.ai/v1/systemone';
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, state, questions }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Jev 決策失敗（HTTP ${res.status}）：${detail.slice(0, 160)}`);
  }
  return (await res.json()).answers ?? {};
}

// 沒有 Jev：把同樣的 state 和問題交給 LLM，要它照格式回答
async function askLlm({ ai, state, questions, timeoutMs = 8000 }) {
  const lines = Object.entries(questions).map(([id, q]) => {
    if (q.type === 'choice') return `- ${id}（choice）：${q.instructions}\n  選項：${Object.entries(q.criteria).map(([k, v]) => `${k}＝${v ?? k}`).join('；')}`;
    return `- ${id}（noul，是的機率 0–1）：${q.instructions}`;
  });
  const raw = await ask({
    ...ai,
    timeoutMs,
    system: '你是程式裡的決策器。看 state 回答每個問題：choice 從選項 key 裡挑一個並給信心（0–1）；noul 給「是」的機率（0–1）。'
      + '只輸出 JSON：{"answers": {"<問題 id>": {"choice": "<選項 key>", "confidence": 0.0} 或 {"noul": 0.0}}}',
    user: `<state>${JSON.stringify(state)}</state>\n<questions>\n${lines.join('\n')}\n</questions>`,
  });
  const answers = JSON.parse(String(raw).match(/\{[\s\S]*\}/)?.[0] ?? '{}').answers ?? {};
  // 只收選項裡有的
  for (const [id, q] of Object.entries(questions)) {
    const a = answers[id];
    if (q.type === 'choice' && a && !(a.choice in q.criteria)) delete answers[id];
  }
  return answers;
}

// settings：{ jevKey, jevModel, ai }（ai 是 editor.ask 的參數，沒有 Jev 時用）
export function createDecider(settings) {
  return {
    available: () => !!(settings().jevKey || settings().ai?.apiKey),
    engine: () => (settings().jevKey ? 'Jev' : 'AI'),
    async decide(state, questions) {
      const s = settings();
      if (s.jevKey) return askJev({ apiKey: s.jevKey, model: s.jevModel, state, questions });
      if (s.ai?.apiKey) return askLlm({ ai: s.ai, state, questions });
      throw new Error('沒有 Jev key，也沒有 AI 的 key，做不了決策');
    },
  };
}

// ---- 問題 ----

export const intentQuestion = () => ({
  type: 'choice',
  instructions: '使用者對電腦講了 `transcript`。這是要打進輸入框的字（dictation），還是要電腦去操作 app 的指令（command）？`field` 是游標所在的輸入框（空的表示游標不在輸入框）。',
  criteria: {
    dictation: '要寫進輸入框的內容：訊息、文件、給 AI 的提示、筆記。就算內容是請別人或 AI 做事，只要是要打出來的字就算這個。',
    command: '要電腦直接操作目前的 app：打開某頁、進到某個畫面、切換分頁、搜尋某個東西、點某個按鈕。',
  },
});

const where = (e, win) => {
  if (!win?.w || !win?.h) return '';
  const cx = (e.x + e.w / 2 - win.x) / win.w;
  const cy = (e.y + e.h / 2 - win.y) / win.h;
  return `${cy < 0.33 ? '上' : cy < 0.66 ? '中' : '下'}${cx < 0.33 ? '左' : cx < 0.66 ? '中' : '右'}`;
};

const ROLE_NAMES = {
  AXButton: '按鈕', AXLink: '連結', AXTextField: '輸入框', AXTextArea: '多行輸入框', AXComboBox: '下拉輸入框', AXSearchField: '搜尋框',
  AXPopUpButton: '選單按鈕', AXMenuButton: '選單按鈕', AXCheckBox: '勾選框', AXRadioButton: '分頁／選項', AXRow: '清單列', AXCell: '格子',
};

export const describeElement = (e, win) => `${ROLE_NAMES[e.role] ?? e.role}${e.subrole === 'AXSearchField' ? '（搜尋框）' : ''}「${e.label || '沒有標籤'}」（${where(e, win)}）${e.focused ? '，游標在這' : ''}`;

// 游標不在輸入框：這段字要寫進哪個框
export function fieldQuestions(candidates, win) {
  const criteria = {};
  candidates.forEach((c, i) => { criteria[`e${i}`] = describeElement(c, win); });
  return {
    target: { type: 'choice', instructions: '使用者講了 `transcript`，游標不在輸入框。這段字最該寫進哪個輸入框？', criteria },
    obvious: { type: 'noul', instructions: '這個視窗裡有明顯就是要寫這段字的輸入框嗎？' },
  };
}

// 指令模式的一步：做什麼、對哪個元件
export function stepQuestions(elements, win) {
  const criteria = {};
  elements.forEach((e, i) => { criteria[`e${i}`] = describeElement(e, win); });
  return {
    action: {
      type: 'choice',
      instructions: '要達成 `goal`，看 `screen`（目前畫面上可以操作的東西）和 `done_steps`（已經做過的步驟），下一步要做什麼？',
      criteria: {
        click: '點畫面上的某個按鈕、連結、分頁或清單項目',
        fill: '在某個輸入框（多半是搜尋框）填入 `text`',
        enter: '在剛填好字的輸入框按 Enter（送出搜尋）',
        done: '目標已經達成：畫面已經是使用者要的',
        stuck: '這個畫面做不到，或不知道下一步',
      },
    },
    target: { type: 'choice', instructions: '要點或要填的是哪一個？（action 是 click 或 fill 時才用得到）', criteria },
  };
}
