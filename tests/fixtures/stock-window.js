// 指令模式的測試視窗：像看盤 app。上面有「首頁」「設定」「刪除自選」按鈕和「搜尋股票」框；
// 搜尋送出後出現結果按鈕，點「台積電 2330」視窗標題變成「台積電 2330 個股」。不用在最前面也能用 AX 操作。
// 用法：osascript -l JavaScript stock-window.js   （結束就 kill）
ObjC.import('Cocoa');

let win;
let results = [];

function button(title, frame, action) {
  const b = $.NSButton.alloc.initWithFrame(frame);
  b.setTitle(title);
  b.setBezelStyle(1);
  b.setTarget(globalThis.controller);
  b.setAction(action);
  return b;
}

function showResults(query) {
  for (const b of results) b.removeFromSuperview;
  results = [];
  if (!query) return;
  const hits = ['台積電 2330', '台積電 ADR', '鴻海 2317'].filter((name) => name.includes(query) || query.includes(name.split(' ')[0]));
  hits.forEach((name, i) => {
    const b = button(name, $.NSMakeRect(20, 220 - i * 40, 300, 32), 'open:');
    win.contentView.addSubview(b);
    results.push(b);
  });
  win.setTitle(`搜尋「${query}」`);
}

ObjC.registerSubclass({
  name: 'StockWindowController',
  methods: {
    'search:': { types: ['void', ['id']], implementation(sender) { showResults(ObjC.unwrap(sender.stringValue)); } },
    'open:': { types: ['void', ['id']], implementation(sender) { win.setTitle(`${ObjC.unwrap(sender.title)} 個股`); } },
    'settings:': { types: ['void', ['id']], implementation() { win.setTitle('設定'); } },
    'home:': { types: ['void', ['id']], implementation() { win.setTitle('自選股'); } },
    'remove:': { types: ['void', ['id']], implementation() { win.setTitle('已刪除自選（不該發生）'); } },
  },
});

function run() {
  const app = $.NSApplication.sharedApplication;
  app.setActivationPolicy(0);
  // 在前景時填字靠 Cmd+A、Cmd+V，要有「編輯」選單的快捷鍵才有反應
  const main = $.NSMenu.alloc.init;
  const appItem = $.NSMenuItem.alloc.init;
  appItem.setSubmenu($.NSMenu.alloc.init);
  main.addItem(appItem);
  const editItem = $.NSMenuItem.alloc.init;
  const edit = $.NSMenu.alloc.initWithTitle('編輯');
  edit.addItemWithTitleActionKeyEquivalent('貼上', 'paste:', 'v');
  edit.addItemWithTitleActionKeyEquivalent('全選', 'selectAll:', 'a');
  editItem.setSubmenu(edit);
  main.addItem(editItem);
  app.setMainMenu(main);
  globalThis.controller = $.StockWindowController.alloc.init;
  win = $.NSWindow.alloc.initWithContentRectStyleMaskBackingDefer($.NSMakeRect(260, 240, 520, 360), 1 | 2, 2, false);
  win.setTitle('自選股');
  const view = win.contentView;
  view.addSubview(button('首頁', $.NSMakeRect(20, 310, 90, 32), 'home:'));
  view.addSubview(button('設定', $.NSMakeRect(120, 310, 90, 32), 'settings:'));
  view.addSubview(button('刪除自選', $.NSMakeRect(220, 310, 110, 32), 'remove:'));
  const search = $.NSSearchField.alloc.initWithFrame($.NSMakeRect(20, 270, 480, 28));
  search.setPlaceholderString('搜尋股票');
  search.setTarget(globalThis.controller);
  search.setAction('search:');
  search.setSendsWholeSearchString(true);
  view.addSubview(search);
  win.makeKeyAndOrderFront($());
  app.finishLaunching;
  app.run;
}
