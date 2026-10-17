// 測試用視窗：多行文字框、單行框、搜尋框、密碼框，給 AX 小幫手與端對端測試用。
// 用法：osascript -l JavaScript test-window.js [--activate]  （結束就 kill 這個 osascript）
ObjC.import('Cocoa');

function field(cls, frame, placeholder) {
  const f = cls.alloc.initWithFrame(frame);
  f.setPlaceholderString(placeholder);
  return f;
}

function run(argv) {
  const app = $.NSApplication.sharedApplication;
  app.setActivationPolicy(0); // 一般 app，才能到最前面收鍵盤
  const win = $.NSWindow.alloc.initWithContentRectStyleMaskBackingDefer($.NSMakeRect(200, 200, 560, 420), 1 | 2, 2, false);
  win.setTitle('全語音輸入測試視窗');
  const view = win.contentView;
  const search = field($.NSSearchField, $.NSMakeRect(20, 370, 520, 26), '搜尋');
  const single = field($.NSTextField, $.NSMakeRect(20, 330, 520, 26), '主旨');
  const secret = field($.NSSecureTextField, $.NSMakeRect(20, 290, 520, 26), '密碼');
  const scroll = $.NSScrollView.alloc.initWithFrame($.NSMakeRect(20, 20, 520, 250));
  const text = $.NSTextView.alloc.initWithFrame($.NSMakeRect(0, 0, 520, 250));
  text.setRichText(false);
  text.setAutomaticQuoteSubstitutionEnabled(false);
  text.setAutomaticTextReplacementEnabled(false);
  text.setAutomaticSpellingCorrectionEnabled(false);
  text.setString($(argv.includes('--empty') ? '' : '今天的待辦：'));
  text.setAccessibilityLabel('訊息');
  scroll.setDocumentView(text);
  scroll.setHasVerticalScroller(true);
  for (const v of [search, single, secret, scroll]) view.addSubview(v);
  win.makeKeyAndOrderFront($());
  win.makeFirstResponder(argv.includes('--focus-none') ? $() : text);
  if (argv.includes('--activate')) app.activateIgnoringOtherApps(true);
  app.finishLaunching;
  app.run;
}
