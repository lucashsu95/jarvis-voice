// 第三層：游標不在輸入框時，從視窗裡的輸入框挑一個最像「要寫字的地方」的。
// 先看這個視窗上次寫進去的那個；再看標籤（Prompt、訊息、回覆……）、多行優先、越下面越大越像聊天輸入框。
// 搜尋框、密碼框、網址列不選；分不出高下就不動（寧可不寫，也不要寫錯地方）。

const SKIP_LABEL = /search|搜尋|搜索|查詢|find|filter|篩選|網址|address|url|password|密碼/i;
const GOOD_LABEL = /prompt|message|訊息|reply|回覆|回應|comment|留言|compose|撰寫|輸入|write|ask|問|chat|聊天|內文|body|note|筆記/i;
const MARGIN = 30; // 第一名要贏第二名這麼多分才算確定

export function usable(c) {
  return c.enabled !== false && c.w >= 40 && c.h >= 12
    && c.subrole !== 'AXSecureTextField' && c.subrole !== 'AXSearchField' && c.role !== 'AXSearchField'
    && !SKIP_LABEL.test(c.label ?? '');
}

export function score(c, window) {
  let s = 0;
  if (GOOD_LABEL.test(c.label ?? '')) s += 100;
  if (c.role === 'AXTextArea') s += 40;
  if (window?.h) {
    s += Math.max(0, Math.min(1, (c.y + c.h - window.y) / window.h)) * 40; // 越下面越像聊天輸入框
    s += Math.min(30, ((c.w * c.h) / (window.w * window.h)) * 100); // 越大越像主要的編輯區
  }
  return s;
}

const sameField = (c, r) => c.role === r.role && (c.label ?? '') === (r.label ?? '')
  && (!r.frame || Math.abs(c.y - r.frame.y) < 80);

// 回傳 { choice, reason, sure, list }：choice 是 null 表示不確定，不要動；
// sure 表示不用再問決策器（上次寫的那個、或只有一個）；list 是能寫的輸入框
export function rankTargets({ candidates = [], window = null, remembered = null }) {
  const list = candidates.filter(usable);
  if (!list.length) return { choice: null, reason: '視窗裡沒有可以寫字的輸入框', sure: true, list };
  if (remembered) {
    const again = list.find((c) => sameField(c, remembered));
    if (again) return { choice: again, reason: '這個視窗上次寫的地方', sure: true, list };
  }
  if (list.length === 1) return { choice: list[0], reason: '視窗裡只有這一個輸入框', sure: true, list };
  const ranked = list.map((c) => ({ c, s: score(c, window) })).sort((a, b) => b.s - a.s);
  if (ranked[0].s - ranked[1].s < MARGIN) {
    return { choice: null, reason: `「${ranked[0].c.label || ranked[0].c.role}」和「${ranked[1].c.label || ranked[1].c.role}」分不出要寫哪個`, sure: false, list };
  }
  return { choice: ranked[0].c, reason: '最像要寫字的輸入框', sure: false, list };
}
