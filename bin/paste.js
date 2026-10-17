// 把一段字貼進目前游標所在的輸入框：暫存剪貼簿 → 放字 → 送 Cmd+V → 還原剪貼簿。
// 用法：osascript -l JavaScript paste.js <字> [--dry] [--ask]
// --dry 不送按鍵，只做剪貼簿暫存與還原（測試用）。送按鍵要「輔助使用」權限；
// --ask 沒權限時跳出系統的權限詢問（只在第一次沒權限時帶）。
ObjC.import('Cocoa');
ObjC.import('ApplicationServices');

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
  if (!dry && !$.AXIsProcessTrusted()) {
    if (argv.includes('--ask')) {
      $.AXIsProcessTrustedWithOptions($.NSDictionary.dictionaryWithObjectForKey($.NSNumber.numberWithBool(true), $('AXTrustedCheckOptionPrompt')));
    }
    return 'no-accessibility';
  }
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
