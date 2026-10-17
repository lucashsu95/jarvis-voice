// 常駐的「輔助使用」小幫手（JXA）：listen.mjs 開一個一直留著，stdin／stdout 一行一個 JSON。
// 讀上下文（app、視窗、網址、輸入框、游標前後、選取）、貼上、選回剛貼的字換掉、找視窗裡的輸入框、對焦。
// 不用每句都重開 osascript，每次省 100–200 ms。
//
// 請求 { id, op, ... } → 回覆 { id, ... } 或 { id, error }：
//   check   { ask }                   → { trusted }
//   context { pid, chars }            → { app, window, url, field: { editable, known, role, subrole, secure, label, before, selected, after, handle } }
//   paste   { pid, text, dry }        → { result: ok | no-accessibility | not-text-field:<角色> | not-front | dry:<字>, handle }
//   replace { pid, old, text }        → { result: ok | mismatch | no-field | not-front }：游標前面正好是 old 就選起來換成 text（空字串＝刪掉）
//   按鍵（Cmd+V、Delete）只在 pid 確實是最前面的 app 時才送，不然回 not-front
//   targets { pid }                   → { window: {x,y,w,h,title}, candidates: [{ handle, role, subrole, label, x, y, w, h, focused, enabled }] }
//   focus   { handle }                → { ok }
//   read    { handle }                → { value }
//   elements { pid, limit }           → { window, elements: [{ handle, role, subrole, label, x, y, w, h, focused }] }：畫面上可以操作的東西
//   act     { pid, handle, action, text } → { result: ok | gone | not-front | failed }：press 點、fill 填字、enter 按 Enter
ObjC.import('Cocoa');
ObjC.import('ApplicationServices');

// AXUIElementRef 在執行期是 CF 物件，全部當 id 傳：JXA 對 AX 的 out 參數型別對不上，自己綁簽名
ObjC.bindFunction('AXUIElementCreateApplication', ['id', ['int']]);
ObjC.bindFunction('AXUIElementCopyAttributeValue', ['int', ['id', 'id', 'void **']]);
ObjC.bindFunction('AXUIElementSetAttributeValue', ['int', ['id', 'id', 'id']]);
ObjC.bindFunction('AXUIElementCopyParameterizedAttributeValue', ['int', ['id', 'id', 'id', 'void **']]);
ObjC.bindFunction('AXValueCreate', ['id', ['int', 'void *']]);
ObjC.bindFunction('AXUIElementPerformAction', ['int', ['id', 'id']]);

const TEXT_ROLES = ['AXTextField', 'AXTextArea', 'AXComboBox', 'AXSearchField'];
const K_CFRANGE = 4; // kAXValueCFRangeType

// ---- 讀寫屬性 ----

function attr(el, name) {
  if (!el) return null;
  const ref = Ref();
  return $.AXUIElementCopyAttributeValue(el, $(name), ref) === 0 ? ObjC.castRefToObject(ref[0]) : null;
}

function text(el, name) {
  const v = attr(el, name);
  if (!v) return '';
  const u = ObjC.unwrap(v);
  return typeof u === 'string' ? u : '';
}

function flag(el, name) {
  const v = attr(el, name);
  return v ? ObjC.unwrap(v) === true || ObjC.unwrap(v) === 1 : null;
}

// AXValue 沒辦法直接拆，從 description 讀數字
const describe = (v) => (v ? ObjC.unwrap(v.description) : '');

function rangeOf(el) {
  const m = describe(attr(el, 'AXSelectedTextRange')).match(/location:(-?\d+) length:(\d+)/);
  return m ? { location: Number(m[1]), length: Number(m[2]) } : null;
}

function frameOf(el) {
  const p = describe(attr(el, 'AXPosition')).match(/x:(-?[\d.]+) y:(-?[\d.]+)/);
  const s = describe(attr(el, 'AXSize')).match(/w:([\d.]+) h:([\d.]+)/);
  return p && s ? { x: Number(p[1]), y: Number(p[2]), w: Number(s[1]), h: Number(s[2]) } : null;
}

// CFRange 是兩個 64-bit 整數，拼成 16 bytes 再包成 AXValue
function rangeValue(location, length) {
  const bytes = [];
  for (let n of [location, length]) for (let i = 0; i < 8; i += 1) { bytes.push(n & 0xff); n = Math.floor(n / 256); }
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let b64 = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    b64 += A[(n >> 18) & 63] + A[(n >> 12) & 63] + (i + 1 < bytes.length ? A[(n >> 6) & 63] : '=') + (i + 2 < bytes.length ? A[n & 63] : '=');
  }
  const data = $.NSData.alloc.initWithBase64EncodedStringOptions($(b64), 0);
  return $.AXValueCreate(K_CFRANGE, data.bytes);
}

function setRange(el, location, length) {
  return $.AXUIElementSetAttributeValue(el, $('AXSelectedTextRange'), rangeValue(location, length)) === 0;
}

function stringForRange(el, location, length) {
  const ref = Ref();
  if ($.AXUIElementCopyParameterizedAttributeValue(el, $('AXStringForRange'), rangeValue(location, length), ref) !== 0) return null;
  const u = ObjC.unwrap(ObjC.castRefToObject(ref[0]));
  return typeof u === 'string' ? u : null;
}

// ---- 元件代號：回給 node 的是數字，之後可以拿來對焦、讀回 ----

const handles = new Map();
let nextHandle = 1;
function keep(el) {
  const id = nextHandle;
  nextHandle += 1;
  handles.set(id, el);
  if (handles.size > 300) handles.delete(handles.keys().next().value);
  return id;
}

function appElement(pid) {
  const app = $.AXUIElementCreateApplication(pid);
  // Chromium、Electron 要先打開輔助樹才讀得到網頁裡的欄位；其他 app 會忽略
  $.AXUIElementSetAttributeValue(app, $('AXManualAccessibility'), $.NSNumber.numberWithBool(true));
  return app;
}

function labelOf(el) {
  const title = attr(el, 'AXTitleUIElement');
  return text(el, 'AXDescription') || text(el, 'AXPlaceholderValue') || text(el, 'AXTitle')
    || (title ? text(title, 'AXValue') : '') || text(el, 'AXHelp');
}

// 目前焦點的輸入框：{ known, editable, el, root, role, subrole, secure }。讀不到（app 不支援輔助功能）就當不知道
function focusedField(app) {
  const el = attr(app, 'AXFocusedUIElement');
  if (!el) return { known: false };
  const role = text(el, 'AXRole');
  const subrole = text(el, 'AXSubrole');
  const secure = subrole === 'AXSecureTextField' || role === 'AXSecureTextField';
  if (TEXT_ROLES.includes(role) || secure) return { known: true, editable: true, el, root: el, role, subrole, secure };
  // 網頁裡的 contenteditable 編輯器：Chromium／WebKit 會掛可編輯的祖先，值和游標要從祖先讀
  const ancestor = attr(el, 'AXEditableAncestor');
  if (ancestor) return { known: true, editable: true, el, root: ancestor, role, subrole, secure: false };
  return { known: true, editable: false, el, role, subrole };
}

function webAreaOf(el) {
  let cur = el;
  for (let i = 0; cur && i < 80; i += 1) {
    if (text(cur, 'AXRole') === 'AXWebArea') return cur;
    cur = attr(cur, 'AXParent');
  }
  return null;
}

// 廣度優先走 AX 樹：webAreas 收網頁區塊（不往裡走），fields 收原生輸入框
function walk(root, limit) {
  const webAreas = [];
  const fields = [];
  const queue = [root];
  let seen = 0;
  while (queue.length && seen < limit) {
    const el = queue.shift();
    seen += 1;
    const role = text(el, 'AXRole');
    if (role === 'AXWebArea') { webAreas.push(el); continue; }
    if (TEXT_ROLES.includes(role)) { fields.push(el); continue; }
    const kids = attr(el, 'AXChildren');
    if (kids) for (let i = 0; i < kids.count; i += 1) queue.push(kids.objectAtIndex(i));
  }
  return { webAreas, fields };
}

function urlOf(web) {
  const v = attr(web, 'AXURL');
  if (!v) return '';
  try { return ObjC.unwrap(v.absoluteString) || ''; } catch (err) { return ''; }
}

// ---- 操作 ----

function context({ pid, chars = 400 }) {
  const app = appElement(pid);
  const running = $.NSRunningApplication.runningApplicationWithProcessIdentifier(pid);
  const win = attr(app, 'AXFocusedWindow');
  const out = {
    app: running && !running.isNil() ? ObjC.unwrap(running.localizedName) || '' : '',
    window: text(win, 'AXTitle'),
    url: '',
    field: { known: false, editable: false },
  };
  const f = focusedField(app);
  const web = f.el ? webAreaOf(f.el) : null;
  out.url = web ? urlOf(web) : win ? (walk(win, 300).webAreas.map(urlOf).find(Boolean) || '') : '';
  if (!f.known) return out;
  out.field = { known: true, editable: f.editable, role: f.role, subrole: f.subrole, secure: !!f.secure };
  if (!f.editable) return out;
  out.field.label = labelOf(f.root) || labelOf(f.el);
  out.field.handle = keep(f.root);
  if (f.secure) return out; // 密碼欄不讀內容
  const range = rangeOf(f.root);
  const count = Number(ObjC.unwrap(attr(f.root, 'AXNumberOfCharacters')) || 0);
  if (!range) return out;
  const { location, length } = range;
  let value = null;
  let offset = 0;
  if (count > 20000) {
    // 很長的文件只讀游標附近
    offset = Math.max(0, location - chars);
    value = stringForRange(f.root, offset, Math.min(count - offset, length + chars * 2 + (location - offset)));
  } else {
    value = text(f.root, 'AXValue');
  }
  if (typeof value !== 'string') return out;
  const at = location - offset;
  out.field.before = value.slice(Math.max(0, at - chars), at);
  out.field.selected = value.slice(at, at + length);
  out.field.after = value.slice(at + length, at + length + chars);
  return out;
}

function snapshot(pb) {
  const saved = [];
  const items = pb.pasteboardItems;
  for (let i = 0; i < items.count; i += 1) {
    const item = items.objectAtIndex(i);
    const types = item.types;
    const entry = [];
    for (let j = 0; j < types.count; j += 1) {
      const type = types.objectAtIndex(j);
      const data = item.dataForType(type);
      if (data && !data.isNil()) entry.push([type, data]);
    }
    saved.push(entry);
  }
  return saved;
}

function restore(pb, saved) {
  pb.clearContents;
  if (!saved.length) return;
  const objects = $.NSMutableArray.array;
  for (const entry of saved) {
    const item = $.NSPasteboardItem.alloc.init;
    for (const [type, data] of entry) item.setDataForType(data, type);
    objects.addObject(item);
  }
  pb.writeObjects(objects);
}

function pressKey(code, command) {
  const source = $.CGEventSourceCreate(0); // kCGEventSourceStateCombinedSessionState
  const down = $.CGEventCreateKeyboardEvent(source, code, true);
  const up = $.CGEventCreateKeyboardEvent(source, code, false);
  const flags = command ? 0x100000 : 0; // kCGEventFlagMaskCommand
  $.CGEventSetFlags(down, flags);
  $.CGEventSetFlags(up, flags);
  $.CGEventPost(0, down); // kCGHIDEventTap
  $.CGEventPost(0, up);
}

const KEY_V = 9;
const KEY_A = 0;
const KEY_DELETE = 51;
const KEY_RETURN = 36;

// 暫存剪貼簿 → 放字 → Cmd+V → 等 app 讀完 → 還原剪貼簿
function pasteText(value, dry) {
  const pb = $.NSPasteboard.generalPasteboard;
  const saved = snapshot(pb);
  pb.clearContents;
  pb.setStringForType($(value), $.NSPasteboardTypeString);
  let placed = '';
  if (dry) placed = ObjC.unwrap(pb.stringForType($.NSPasteboardTypeString)) || '';
  else pressKey(KEY_V, true);
  delay(0.35);
  restore(pb, saved);
  return placed;
}

// 按鍵只會送到最前面的 app：送之前確認最前面的就是要寫的那個，不然 Cmd+V、Delete 會落到別的 app。
// 問 app 自己的 AXFrontmost（系統層的 AXFocusedApplication 在這裡讀不到）
function isFront(pid) {
  return flag($.AXUIElementCreateApplication(pid), 'AXFrontmost') === true;
}

function trusted(ask) {
  if ($.AXIsProcessTrusted()) return true;
  if (ask) $.AXIsProcessTrustedWithOptions($.NSDictionary.dictionaryWithObjectForKey($.NSNumber.numberWithBool(true), $('AXTrustedCheckOptionPrompt')));
  return false;
}

function paste({ pid, text: value, dry, ask }) {
  if (!dry && !trusted(ask)) return { result: 'no-accessibility' };
  const f = pid ? focusedField(appElement(pid)) : { known: false };
  if (f.known && !f.editable) return { result: `not-text-field:${f.role}` };
  if (!dry && pid && !isFront(pid)) return { result: 'not-front' };
  const placed = pasteText(value, dry);
  return { result: dry ? `dry:${placed}` : 'ok', handle: f.root ? keep(f.root) : 0 };
}

// 游標前面正好是剛貼的 old：選起來，換成 text（空字串就刪掉）。對不上就不動
function replace({ pid, old, text: value }) {
  if (!trusted(false)) return { result: 'no-accessibility' };
  const f = focusedField(appElement(pid));
  if (!f.editable || f.secure) return { result: 'no-field' };
  const range = rangeOf(f.root);
  if (!range || range.length || range.location < old.length) return { result: 'mismatch' };
  const start = range.location - old.length;
  const before = stringForRange(f.root, start, old.length) ?? text(f.root, 'AXValue').slice(start, range.location);
  if (before !== old) return { result: 'mismatch' };
  if (!isFront(pid)) return { result: 'not-front' };
  if (!setRange(f.root, start, old.length) || text(f.root, 'AXSelectedText') !== old) {
    setRange(f.root, range.location, 0);
    return { result: 'mismatch' };
  }
  if (value) pasteText(value, false);
  else pressKey(KEY_DELETE, false);
  return { result: 'ok' };
}

function targets({ pid }) {
  const app = appElement(pid);
  const win = attr(app, 'AXFocusedWindow') || attr(app, 'AXMainWindow');
  if (!win) return { window: null, candidates: [] };
  const found = walk(win, 2000);
  const elements = [...found.fields];
  const params = $.NSDictionary.dictionaryWithObjectsForKeys(
    $([$('AXTextFieldSearchKey'), $.NSNumber.numberWithInt(60), $('AXDirectionNext'), $.NSNumber.numberWithBool(false)]),
    $(['AXSearchKey', 'AXResultsLimit', 'AXDirection', 'AXImmediateDescendantsOnly']),
  );
  for (const web of found.webAreas) {
    const ref = Ref();
    if ($.AXUIElementCopyParameterizedAttributeValue(web, $('AXUIElementsForSearchPredicate'), params, ref) !== 0) continue;
    const list = ObjC.castRefToObject(ref[0]);
    for (let i = 0; i < list.count; i += 1) elements.push(list.objectAtIndex(i));
  }
  const candidates = elements.map((el) => ({
    handle: keep(el),
    role: text(el, 'AXRole'),
    subrole: text(el, 'AXSubrole'),
    label: labelOf(el),
    ...(frameOf(el) ?? { x: 0, y: 0, w: 0, h: 0 }),
    focused: flag(el, 'AXFocused') === true,
    enabled: flag(el, 'AXEnabled') !== false,
  }));
  return { window: { ...(frameOf(win) ?? {}), title: text(win, 'AXTitle') }, candidates };
}

function focus({ handle }) {
  const el = handles.get(handle);
  if (!el) return { ok: false };
  $.AXUIElementSetAttributeValue(el, $('AXFocused'), $.NSNumber.numberWithBool(true));
  delay(0.05);
  return { ok: flag(el, 'AXFocused') === true };
}

function read({ handle }) {
  const el = handles.get(handle);
  if (!el) return { value: null };
  const value = attr(el, 'AXValue');
  const u = value ? ObjC.unwrap(value) : null;
  return { value: typeof u === 'string' ? u : null };
}

// ---- 指令模式：列出畫面上可以操作的東西、點、填字 ----

const CONTROL_ROLES = ['AXButton', 'AXLink', 'AXTextField', 'AXTextArea', 'AXComboBox', 'AXSearchField', 'AXPopUpButton',
  'AXMenuButton', 'AXCheckBox', 'AXRadioButton', 'AXRow', 'AXCell', 'AXDisclosureTriangle', 'AXIncrementor'];
const LEAF_ROLES = ['AXButton', 'AXLink', 'AXTextField', 'AXTextArea', 'AXComboBox', 'AXSearchField', 'AXPopUpButton', 'AXMenuButton', 'AXCheckBox', 'AXRadioButton'];

// 元件上的字：標題、說明、值，沒有就拿底下第一段字（清單列、連結常這樣）
function textInside(el, depth = 0) {
  const own = text(el, 'AXTitle') || text(el, 'AXDescription') || text(el, 'AXValue');
  if (own || depth > 3) return own;
  const kids = attr(el, 'AXChildren');
  if (!kids) return '';
  const parts = [];
  for (let i = 0; i < kids.count && parts.join(' ').length < 60; i += 1) {
    const t = textInside(kids.objectAtIndex(i), depth + 1);
    if (t) parts.push(t);
  }
  return parts.join(' ');
}

function elements({ pid, limit = 150 }) {
  const app = appElement(pid);
  const win = attr(app, 'AXFocusedWindow') || attr(app, 'AXMainWindow');
  if (!win) return { window: null, elements: [] };
  const box = frameOf(win);
  const found = [];
  const webAreas = [];
  const queue = [win];
  let seen = 0;
  while (queue.length && seen < 2500) {
    const el = queue.shift();
    seen += 1;
    const role = text(el, 'AXRole');
    if (role === 'AXWebArea') { webAreas.push(el); continue; }
    if (CONTROL_ROLES.includes(role)) found.push(el);
    if (LEAF_ROLES.includes(role) || role === 'AXRow') continue;
    const kids = attr(el, 'AXChildren');
    if (kids) for (let i = 0; i < kids.count; i += 1) queue.push(kids.objectAtIndex(i));
  }
  const params = $.NSDictionary.dictionaryWithObjectsForKeys(
    $([$(['AXLinkSearchKey', 'AXButtonSearchKey', 'AXTextFieldSearchKey']), $.NSNumber.numberWithInt(300), $('AXDirectionNext'),
      $.NSNumber.numberWithBool(false), $.NSNumber.numberWithBool(true)]),
    $(['AXSearchKey', 'AXResultsLimit', 'AXDirection', 'AXImmediateDescendantsOnly', 'AXVisibleOnly']),
  );
  for (const web of webAreas) {
    const ref = Ref();
    if ($.AXUIElementCopyParameterizedAttributeValue(web, $('AXUIElementsForSearchPredicate'), params, ref) !== 0) continue;
    const list = ObjC.castRefToObject(ref[0]);
    for (let i = 0; i < list.count; i += 1) found.push(list.objectAtIndex(i));
  }
  const out = [];
  for (const el of found) {
    const frame = frameOf(el);
    if (!frame || frame.w < 4 || frame.h < 4) continue;
    // 只留視窗裡看得到的
    if (box && (frame.x + frame.w < box.x || frame.x > box.x + box.w || frame.y + frame.h < box.y || frame.y > box.y + box.h)) continue;
    const label = (labelOf(el) || textInside(el)).replace(/\s+/g, ' ').trim().slice(0, 60);
    const role = text(el, 'AXRole');
    if (!label && !TEXT_ROLES.includes(role)) continue;
    out.push({ handle: keep(el), role, subrole: text(el, 'AXSubrole'), label, ...frame, focused: flag(el, 'AXFocused') === true });
    if (out.length >= limit) break;
  }
  return { window: { ...(box ?? {}), title: text(win, 'AXTitle') }, elements: out };
}

function act({ pid, handle, action, text: value = '' }) {
  const el = handles.get(handle);
  if (!el && !(action === 'enter' && isFront(pid))) return { result: 'gone' };
  if (!el) { pressKey(KEY_RETURN, false); return { result: 'ok' }; }
  if (action === 'press') {
    for (const name of ['AXPress', 'AXConfirm', 'AXPick']) {
      if ($.AXUIElementPerformAction(el, $(name)) === 0) return { result: 'ok' };
    }
    // 清單列這類沒有 AXPress 的：選起來
    if ($.AXUIElementSetAttributeValue(el, $('AXSelected'), $.NSNumber.numberWithBool(true)) === 0) return { result: 'ok' };
    return { result: 'failed' };
  }
  // app 在最前面：照真人的方式按鍵（網頁的輸入框最穩）；不在前面：直接設值、觸發確認，不送按鍵
  const front = isFront(pid);
  if (action === 'fill') {
    if (!front) {
      if ($.AXUIElementSetAttributeValue(el, $('AXValue'), $(value)) !== 0 || text(el, 'AXValue') !== value) return { result: 'not-front' };
      return { result: 'ok' };
    }
    $.AXUIElementSetAttributeValue(el, $('AXFocused'), $.NSNumber.numberWithBool(true));
    delay(0.1);
    pressKey(KEY_A, true); // 全選，填進去的字取代原本的
    pasteText(value, false);
    return { result: 'ok' };
  }
  if (action === 'enter') {
    if (!front) return { result: $.AXUIElementPerformAction(el, $('AXConfirm')) === 0 ? 'ok' : 'not-front' };
    pressKey(KEY_RETURN, false);
    return { result: 'ok' };
  }
  return { result: 'failed' };
}

const OPS = {
  check: ({ ask }) => ({ trusted: trusted(ask) }),
  context,
  paste,
  replace,
  targets,
  focus,
  read,
  elements,
  act,
};

// ---- 主迴圈：一行一個請求 ----

function reply(out, message) {
  out.writeData($(`${JSON.stringify(message)}\n`).dataUsingEncoding($.NSUTF8StringEncoding));
}

function run() {
  const input = $.NSFileHandle.fileHandleWithStandardInput;
  const out = $.NSFileHandle.fileHandleWithStandardOutput;
  let buffer = '';
  for (;;) {
    const data = input.availableData;
    if (Number(data.length) === 0) return ''; // node 關掉 stdin 就結束
    buffer += ObjC.unwrap($.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding)) || '';
    let newline = buffer.indexOf('\n');
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf('\n');
      if (!line) continue;
      let request = {};
      try {
        request = JSON.parse(line);
        const op = OPS[request.op];
        if (!op) throw new Error(`不認得的操作 ${request.op}`);
        reply(out, { id: request.id, ...op(request) });
      } catch (err) {
        reply(out, { id: request.id, error: String(err) });
      }
    }
  }
}
