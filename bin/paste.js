// 把一段字貼進目前游標所在的輸入框：確認游標在輸入框 → 暫存剪貼簿 → 放字 → 送 Cmd+V → 還原剪貼簿。
// 用法：osascript -l JavaScript paste.js <字> [--pid <前景 app 的 pid>] [--dry] [--ask]
//       osascript -l JavaScript paste.js '' --check   只查有沒有「輔助使用」權限
//   --pid  檢查那個 app 目前的焦點是不是文字欄位；明確不是（例如在看網頁本身）就不貼，回 not-text-field:<角色>
//   --dry  不送按鍵，只做剪貼簿暫存與還原（測試用）
//   --ask  沒有「輔助使用」權限時跳出系統的詢問（只在第一次沒權限時帶）
// 回傳：ok、no-accessibility、not-text-field:<角色>、dry:<字>
ObjC.import('Cocoa');
ObjC.import('ApplicationServices');

// JXA 對 AX 的 out 參數型別對不上，自己綁簽名
ObjC.bindFunction('AXUIElementCreateApplication', ['void *', ['int']]);
ObjC.bindFunction('AXUIElementCopyAttributeValue', ['int', ['void *', 'id', 'void **']]);
ObjC.bindFunction('AXUIElementSetAttributeValue', ['int', ['void *', 'id', 'id']]);

const TEXT_ROLES = ['AXTextField', 'AXTextArea', 'AXComboBox', 'AXSearchField'];

// 回傳 { known, editable, role }：讀不到（app 不支援輔助功能）就當不知道，照貼
function focusedField(pid) {
  if (!pid) return { known: false };
  const app = $.AXUIElementCreateApplication(pid);
  // Chromium、Electron 要先打開輔助樹才讀得到網頁裡的欄位；其他 app 會忽略
  $.AXUIElementSetAttributeValue(app, $('AXManualAccessibility'), $.NSNumber.numberWithBool(true));
  const focused = Ref();
  if ($.AXUIElementCopyAttributeValue(app, $('AXFocusedUIElement'), focused) !== 0) return { known: false };
  const roleRef = Ref();
  if ($.AXUIElementCopyAttributeValue(focused[0], $('AXRole'), roleRef) !== 0) return { known: false };
  const role = ObjC.unwrap(ObjC.castRefToObject(roleRef[0])) || '';
  if (TEXT_ROLES.includes(role)) return { known: true, editable: true, role };
  // 網頁裡的 contenteditable 編輯器：Chromium／WebKit 會掛可編輯的祖先
  const ancestor = Ref();
  if ($.AXUIElementCopyAttributeValue(focused[0], $('AXEditableAncestor'), ancestor) === 0) return { known: true, editable: true, role };
  return { known: true, editable: false, role };
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

function pressCommandV() {
  const V = 9; // kVK_ANSI_V
  const COMMAND = 0x100000; // kCGEventFlagMaskCommand
  const source = $.CGEventSourceCreate(0); // kCGEventSourceStateCombinedSessionState
  const down = $.CGEventCreateKeyboardEvent(source, V, true);
  const up = $.CGEventCreateKeyboardEvent(source, V, false);
  $.CGEventSetFlags(down, COMMAND);
  $.CGEventSetFlags(up, COMMAND);
  $.CGEventPost(0, down); // kCGHIDEventTap
  $.CGEventPost(0, up);
}

function run(argv) {
  const text = argv[0] || '';
  const dry = argv.includes('--dry');
  if (argv.includes('--check')) {
    // 只查權限；帶 --ask 時沒權限就跳系統詢問，順便把 app 登記進「輔助使用」清單
    if ($.AXIsProcessTrusted()) return 'trusted';
    if (argv.includes('--ask')) {
      $.AXIsProcessTrustedWithOptions($.NSDictionary.dictionaryWithObjectForKey($.NSNumber.numberWithBool(true), $('AXTrustedCheckOptionPrompt')));
    }
    return 'no-accessibility';
  }
  const pidAt = argv.indexOf('--pid');
  const pid = pidAt >= 0 ? Number(argv[pidAt + 1]) || 0 : 0;
  if (!dry && !$.AXIsProcessTrusted()) {
    if (argv.includes('--ask')) {
      $.AXIsProcessTrustedWithOptions($.NSDictionary.dictionaryWithObjectForKey($.NSNumber.numberWithBool(true), $('AXTrustedCheckOptionPrompt')));
    }
    return 'no-accessibility';
  }
  const field = focusedField(pid);
  if (field.known && !field.editable) return `not-text-field:${field.role}`;
  const pb = $.NSPasteboard.generalPasteboard;
  const saved = snapshot(pb);
  pb.clearContents;
  pb.setStringForType($(text), $.NSPasteboardTypeString);
  let placed = '';
  if (dry) placed = ObjC.unwrap(pb.stringForType($.NSPasteboardTypeString)) || '';
  else pressCommandV();
  // 等 app 讀完剪貼簿再還原
  delay(0.35);
  restore(pb, saved);
  return dry ? `dry:${placed}` : 'ok';
}
