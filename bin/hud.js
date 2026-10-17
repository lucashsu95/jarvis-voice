// 錄音標示：浮在目前收音的 app 視窗標題列正中間的小標籤，不搶焦點、不擋點擊。
// 由 listen.mjs 起（osascript -l JavaScript hud.js），從 stdin 一行一個指令：
//   target:<pid>     跟著這個程序最前面的視窗（沒給就找名叫 Claude 的視窗）
//   listening        ● 錄音中
//   hearing          ● 說話中（聽到人聲）
//   pasted           已貼上（亮 1.2 秒後回到上一個狀態）
//   nofield          游標不在輸入框（亮 1.6 秒，那句沒貼）
//   error:<訊息>     橘點＋訊息
//   hide             收起來
// stdin 關掉（listen.mjs 結束）就自己結束。
ObjC.import('Cocoa');
ObjC.import('CoreGraphics');
ObjC.import('stdlib');

const H = 24;
const PAD = 10;
const RED = $.NSColor.colorWithSRGBRedGreenBlueAlpha(1, 0.23, 0.19, 1);
const RED_DIM = $.NSColor.colorWithSRGBRedGreenBlueAlpha(1, 0.23, 0.19, 0.55);
const ORANGE = $.NSColor.colorWithSRGBRedGreenBlueAlpha(1, 0.62, 0.04, 1);
const GREEN = $.NSColor.colorWithSRGBRedGreenBlueAlpha(0.2, 0.78, 0.35, 1);

let mode = 'hide';
let targetPid = 0;
let message = '';
let flashUntil = 0;
let flashKind = 'pasted';
let panel;
let dot;
let label;

function targetWindow() {
  const list = ObjC.castRefToObject($.CGWindowListCopyWindowInfo(1 | 16, 0)); // 畫面上的、不含桌面
  for (let i = 0; i < list.count; i += 1) {
    const w = list.objectAtIndex(i);
    const owner = targetPid
      ? ObjC.unwrap(w.objectForKey('kCGWindowOwnerPID')) === targetPid
      : ObjC.unwrap(w.objectForKey('kCGWindowOwnerName')) === 'Claude';
    if (!owner) continue;
    if (ObjC.unwrap(w.objectForKey('kCGWindowLayer')) !== 0) continue;
    const b = w.objectForKey('kCGWindowBounds');
    const rect = {
      x: ObjC.unwrap(b.objectForKey('X')),
      y: ObjC.unwrap(b.objectForKey('Y')),
      width: ObjC.unwrap(b.objectForKey('Width')),
      height: ObjC.unwrap(b.objectForKey('Height')),
    };
    if (rect.width >= 300 && rect.height >= 200) return rect; // 最前面那個主視窗
  }
  return null;
}

function render() {
  const flashing = Date.now() < flashUntil;
  if (mode === 'hide' && !flashing) {
    panel.orderOut($());
    return;
  }
  const win = targetWindow();
  if (!win) {
    panel.orderOut($());
    return;
  }
  let text = '錄音中';
  let color = RED_DIM;
  if (flashing && flashKind === 'nofield') { text = '游標不在輸入框，沒貼'; color = ORANGE; }
  else if (flashing) { text = '已貼上'; color = GREEN; }
  else if (mode === 'hearing') { text = '說話中'; color = RED; }
  else if (mode === 'error') { text = message.length > 24 ? `${message.slice(0, 24)}…` : message; color = ORANGE; }
  label.setStringValue($(text));
  dot.setTextColor(color);
  label.sizeToFit;
  const labelWidth = label.frame.size.width;
  const width = PAD + 12 + 4 + labelWidth + PAD;
  label.setFrameOrigin($.NSMakePoint(PAD + 16, (H - label.frame.size.height) / 2));
  // CG 座標原點在主螢幕左上，Cocoa 在左下；標籤放在視窗標題列正中間
  const screenHeight = $.NSScreen.screens.objectAtIndex(0).frame.size.height;
  const x = win.x + win.width / 2 - width / 2;
  const y = screenHeight - (win.y + 11 + H);
  panel.setFrameDisplay($.NSMakeRect(x, y, width, H), true);
  panel.orderFrontRegardless;
}

function handleLine(line) {
  if (line.startsWith('target:')) targetPid = Number(line.slice(7)) || 0;
  else if (line === 'listening' || line === 'hearing' || line === 'hide') mode = line;
  else if (line === 'pasted') { flashKind = 'pasted'; flashUntil = Date.now() + 1200; }
  else if (line === 'nofield') { flashKind = 'nofield'; flashUntil = Date.now() + 1600; }
  else if (line.startsWith('error:')) { mode = 'error'; message = line.slice(6); }
  render();
}

ObjC.registerSubclass({
  name: 'VoiceDictationHud',
  methods: {
    'tick:': { types: ['void', ['id']], implementation() { render(); } },
    'stdinData:': {
      types: ['void', ['id']],
      implementation(note) {
        const data = note.userInfo.objectForKey($.NSFileHandleNotificationDataItem);
        if (!data || Number(data.length) === 0) $.exit(0); // JXA 的 length 是字串
        const text = ObjC.unwrap($.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding)) || '';
        for (const line of text.split('\n')) if (line.trim()) handleLine(line.trim());
        note.object.readInBackgroundAndNotify;
      },
    },
  },
});

function run() {
  const app = $.NSApplication.sharedApplication;
  app.setActivationPolicy(1); // accessory：不出現在 Dock、不搶前景
  panel = $.NSPanel.alloc.initWithContentRectStyleMaskBackingDefer($.NSMakeRect(0, 0, 100, H), 128, 2, false); // nonactivating、無邊框
  panel.setLevel(25); // 狀態列等級，浮在一般視窗上
  panel.setOpaque(false);
  panel.setBackgroundColor($.NSColor.clearColor);
  panel.setHasShadow(true);
  panel.setIgnoresMouseEvents(true);
  panel.setHidesOnDeactivate(false);
  panel.setCollectionBehavior(1 | 16 | 256); // 每個桌面都在、不跟著 Exposé、全螢幕時也顯示
  const view = panel.contentView;
  view.setWantsLayer(true);
  view.layer.setCornerRadius(H / 2);
  view.layer.setBackgroundColor($.NSColor.colorWithSRGBRedGreenBlueAlpha(0.12, 0.12, 0.12, 0.92).CGColor);
  dot = $.NSTextField.labelWithString($('●'));
  dot.setFont($.NSFont.systemFontOfSize(11));
  dot.sizeToFit;
  dot.setFrameOrigin($.NSMakePoint(PAD, (H - dot.frame.size.height) / 2));
  label = $.NSTextField.labelWithString($('錄音中'));
  label.setFont($.NSFont.systemFontOfSizeWeight(12, 0.23));
  label.setTextColor($.NSColor.colorWithSRGBRedGreenBlueAlpha(1, 1, 1, 0.92));
  view.addSubview(dot);
  view.addSubview(label);

  const hud = $.VoiceDictationHud.alloc.init;
  const stdin = $.NSFileHandle.fileHandleWithStandardInput;
  $.NSNotificationCenter.defaultCenter.addObserverSelectorNameObject(hud, 'stdinData:', $.NSFileHandleReadCompletionNotification, stdin);
  stdin.readInBackgroundAndNotify;
  // 跟著 Claude 視窗移動
  $.NSTimer.scheduledTimerWithTimeIntervalTargetSelectorUserInfoRepeats(0.3, hud, 'tick:', $(), true);
  app.run;
}
