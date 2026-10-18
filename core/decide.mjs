// JarvisVoice 核心：第三層的快速決策。題目與門檻都在這裡；誰來回答由呼叫端傳進來：
//   jev({ state, questions })：TypeSafe 的 System One 模型 Jev（只在給定選項裡挑、給機率，一次約 0.2 秒）
//   complete({ system, user })：一般 LLM（沒有 Jev、或 Jev 拿不準時用，約 1 秒）
// 用在：這段話是「要打的字」還是「要操作 app 的指令」、游標不在輸入框時寫進哪個框、指令每一步點哪裡、寫訊息前確認對象。

// 沒有 Jev：把同樣的 state 和問題交給 LLM，要它照格式回答
async function askLlm({ complete, state, questions, timeoutMs = 8000 }) {
  const lines = Object.entries(questions).map(([id, q]) => {
    if (q.type === 'choice') return `- ${id}（choice）：${q.instructions}\n  選項：${Object.entries(q.criteria).map(([k, v]) => `${k}＝${v ?? k}`).join('；')}`;
    return `- ${id}（noul，是的機率 0–1）：${q.instructions}`;
  });
  const raw = await complete({
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

// service() 回傳 { jev?, complete? }（每次決策時才拿，設定換了馬上生效）
// escalate：Jev 拿不準時，同一題改問 LLM（慢一點、會想）
export function createDecider(service) {
  return {
    available: () => !!(service().jev || service().complete),
    engine: () => (service().jev ? 'Jev' : 'AI'),
    async decide(state, questions) {
      const s = service();
      if (s.jev) return s.jev({ state, questions });
      if (s.complete) return askLlm({ complete: s.complete, state, questions });
      throw new Error('沒有 Jev，也沒有 AI，做不了決策');
    },
    canEscalate: () => !!(service().jev && service().complete),
    async escalate(state, questions) {
      return askLlm({ complete: service().complete, state, questions });
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
  OCRText: '畫面上的字（截圖認出來的，可以點）',
};

export const describeElement = (e, win) => `${ROLE_NAMES[e.role] ?? e.role}${e.subrole === 'AXSearchField' ? '（搜尋框）' : ''}「${e.label || '沒有標籤'}」（${where(e, win)}）${e.value ? `，裡面已經有「${e.value}」` : ''}${e.focused ? '，游標在這' : ''}`;

// 游標在輸入框裡也可能是指令（Claude、聊天 app 的游標幾乎都停在輸入框）：把畫面上的東西一起給 Jev 看
export const inFieldIntentQuestion = () => ({
  type: 'choice',
  instructions: '游標在輸入框 `field` 裡。使用者講了 `transcript`。這是要打進這個輸入框的字（dictation），還是要電腦操作 `screen` 上的東西（command）？',
  criteria: {
    dictation: '要打進輸入框的字：訊息、問題、給 AI 的提示、抱怨或描述（就算句子裡有「切到」「打開」這些字，只要是在描述或討論，而不是叫電腦現在去做，就算這個）',
    command: '叫電腦現在去操作畫面：切到、打開、點、進到、回到 `screen` 上的某個項目（通常會講出那個項目的名字），或搜尋某個東西',
  },
});

// `transcript` 講到的是畫面上哪一個（沒講到就 none）
export function referenceQuestion(items, win) {
  const criteria = { none: '畫面上沒有使用者講到的東西' };
  items.forEach((e, i) => { criteria[`e${i}`] = describeElement(e, win); });
  return { type: 'choice', instructions: '`transcript` 講到的是 `screen` 上的哪一個項目？沒有講到就選 none', criteria };
}

// 游標在輸入框時算不算指令：Jev 很確定（≥ 0.9），或滿確定（≥ 0.75）而且講到畫面上的某個東西
export const IN_FIELD_SURE = 0.9;
export const IN_FIELD_NAMED = 0.75;
export function inFieldVerdict(answers, items) {
  const command = answers.intent?.probabilities?.command ?? 0;
  const t = answers.target;
  const named = !!t && t.choice !== 'none' && (t.confidence ?? 0) >= 0.5 ? items[Number(String(t.choice).slice(1))] ?? null : null;
  return { command, named, isCommand: command >= IN_FIELD_SURE || (command >= IN_FIELD_NAMED && !!named) };
}

// 寫訊息前確認：現在打開的對話是不是和這個人的
export const recipientQuestion = (name) => ({
  type: 'noul',
  instructions: `看 \`screen\`（目前畫面，包括截圖認出來的字），現在打開的對話（看對話區上方的標題）是不是和「${name}」這個人的對話？標題可以多了表情符號、大小寫不同或是暱稱的疊字；但只是另一個名字裡剛好包含它（例如找「BU」時的「Bubu科技有限公司」）、群組、或只是左邊清單裡有這個名字，都不算。`,
});

// 游標不在輸入框：這段字要寫進哪個框
export function fieldQuestions(candidates, win) {
  const criteria = {};
  candidates.forEach((c, i) => { criteria[`e${i}`] = describeElement(c, win); });
  return {
    target: { type: 'choice', instructions: '使用者講了 `transcript`，游標不在輸入框。這段字最該寫進哪個輸入框？', criteria },
  };
}

// 指令模式的一步：做什麼、對哪個元件
export function stepQuestions(elements, win) {
  const criteria = {};
  elements.forEach((e, i) => { criteria[`e${i}`] = describeElement(e, win); });
  return {
    action: {
      type: 'choice',
      instructions: '要達成 `goal`，看 `screen`（目前畫面上可以操作的東西，包括截圖認出來的字）和 `done_steps`（已經做過的步驟），下一步要做什麼？要找的東西不在 `screen` 上時，先用搜尋：有搜尋框就填 `text`，沒有就點「搜尋／Search」按鈕把搜尋框叫出來。`text` 是網址（例如 mail.google.com）而且在瀏覽器裡：畫面上有直接通往 `goal` 的連結就點它，沒有就在瀏覽器的網址列（網址與搜尋列）填 `text`，再按 Enter。搜尋框裡已經有 `text`、畫面上也列出結果時，下一步是點結果裡名字對得上的那一個（例如人名、對話名稱、股票），不是再點搜尋框，也不要按 Enter 期待它自己打開。',
      criteria: {
        click: '點畫面上的某個按鈕、連結、分頁、清單項目或截圖認出來的字（包括把搜尋框叫出來的「搜尋／Search」按鈕、搜尋結果裡的人名）',
        fill: '在某個輸入框填入 `text`（多半是搜尋框；`text` 是網址時是瀏覽器的網址列）',
        enter: '在剛填好字的輸入框按 Enter（送出搜尋）',
        write: '已經打開和對的人的對話：在訊息框寫入 `message`（只有 `message` 有字時才用；不送出）',
        done: '目標已經達成：畫面已經是使用者要的',
        stuck: '這個畫面做不到，或不知道下一步',
      },
    },
    target: {
      type: 'choice',
      instructions: '要點或要填的是哪一個？（action 是 click 或 fill 時才用得到）名字要對得上 `goal` 講的那個項目；要找的項目不在 `screen` 上時，選搜尋框或「搜尋／Search」按鈕；`text` 是網址時選瀏覽器的網址列。',
      criteria,
    },
  };
}
