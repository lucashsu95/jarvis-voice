// 「語音輸入」選單列的介面與常駐程式管理。由 app/main.js（包進 .app 的外殼）啟動時讀進來執行，
// 所以改這個檔不用重包 app，麥克風與輔助使用權限也不用重給；改完從選單「結束」再打開 app 就生效。
// 帶起常駐程式 bin/listen.mjs（它掛了 3 秒後自己重開），狀態全顯示在選單列的圖示上。
// 圖示固定寬度、不加字（加字會讓旁邊的圖示跳來跳去），顏色交給系統（跟其他選單列圖示同色），只換形狀：
//   實心麥克風＝收音中、聲波＝聽到你講話、打勾＝剛貼好、驚嘆號＝游標不在輸入框所以沒貼、
//   劃掉的麥克風＝暫停、空心麥克風＝待命、三角形＝出錯（點開選單看原因）。
// BUILD（{ node, repo, state }）由外殼放在全域。
const LISTEN = `${BUILD.repo}/bin/listen.mjs`;
const NODE_DIR = BUILD.node.replace(/\/[^/]*$/, '');
const ENGINE_NAMES = { local: '本機', openai: 'OpenAI', parallelsandbox: '平行沙盒' };
const GUIDE_URL = 'https://github.com/urusaqqrun/voice-dictation#readme';

let statusItem = null;
let statusLine = null;
let toggleItem = null;
let controller = null;
let task = null;
let quitting = false;
let buffer = '';
let view = { state: 'starting', message: '', engine: '' };
let hearing = false; // 常駐程式說聽到人聲
let flash = null; // { kind: 'pasted' | 'nofield', until }：短暫顯示的結果

const statePath = (name) => `${BUILD.state}/${name}`;
const fm = () => $.NSFileManager.defaultManager;

function label() {
  const name = ENGINE_NAMES[view.engine] ? `（${ENGINE_NAMES[view.engine]}）` : '';
  switch (view.state) {
    case 'listening': return `聽著${name}：講完一句就貼進游標所在的輸入框`;
    case 'standby': return `待命${name}：最前面的 app 不收音`;
    case 'paused': return `已暫停${name}`;
    case 'error': return `出錯：${view.message}`;
    case 'already-running': return '已經有另一個語音輸入在跑，等它結束後接手';
    case 'off': return '常駐程式沒在跑，重新啟動中…';
    default: return '啟動中…';
  }
}

// 選單列圖示要用哪個 SF Symbol，以及滑鼠停上去的說明
function look() {
  if (flash && Date.now() < flash.until) {
    return flash.kind === 'pasted' ? ['checkmark.circle.fill', '已貼上'] : ['exclamationmark.circle', '游標不在輸入框，沒貼'];
  }
  if (view.state === 'listening') return hearing ? ['waveform', '說話中'] : ['mic.fill', ''];
  if (view.state === 'paused') return ['mic.slash', ''];
  if (view.state === 'error') return ['exclamationmark.triangle', ''];
  return ['mic', ''];
}

// 測試用：目前選單列圖示旁的字與選單第一行
function uiSnapshot() {
  return statusItem ? { title: ObjC.unwrap(statusItem.button.title), line: ObjC.unwrap(statusLine.title) } : null;
}

// 診斷：選單列圖示實際的位置寫進 menubar.json（瀏海機型圖示太多時會被擠到瀏海後面看不到）
function dumpFrame() {
  try {
    const win = statusItem.button.window;
    const f = win.frame;
    const screen = $.NSScreen.mainScreen;
    const notch = screen.auxiliaryTopLeftArea;
    const info = {
      x: f.origin.x, y: f.origin.y, width: f.size.width, height: f.size.height,
      visible: statusItem.isVisible, onScreen: win.isVisible,
      appearance: ObjC.unwrap(statusItem.button.effectiveAppearance.name),
      screenWidth: screen.frame.size.width, notchStart: notch ? notch.size.width : null,
      notchEnd: screen.auxiliaryTopRightArea ? screen.frame.size.width - screen.auxiliaryTopRightArea.size.width : null,
    };
    $(JSON.stringify(info)).writeToFileAtomicallyEncodingError(statePath('menubar.json'), true, $.NSUTF8StringEncoding, null);
  } catch (err) { /* 拿不到就算了 */ }
}

function refresh() {
  if (!statusItem) return;
  const [symbol, hint] = look();
  const image = $.NSImage.imageWithSystemSymbolNameAccessibilityDescription(symbol, '語音輸入');
  image.setTemplate(true); // 範本圖：顏色由系統依選單列決定
  statusItem.button.setImage(image);
  statusItem.button.setToolTip(`語音輸入：${hint || label()}`);
  statusLine.setTitle(label());
  toggleItem.setTitle(view.state === 'paused' ? '繼續收音' : '暫停收音');
}

function ensureFile(path, text) {
  if (!fm().fileExistsAtPath(path)) $(text).writeToFileAtomicallyEncodingError(path, true, $.NSUTF8StringEncoding, null);
}

function openInTextEdit(path) {
  $.NSWorkspace.sharedWorkspace.openFileWithApplication(path, 'TextEdit');
}

function togglePause() {
  const paused = statePath('paused');
  if (fm().fileExistsAtPath(paused)) {
    fm().removeItemAtPathError(paused, null);
    view = { ...view, state: 'starting', message: '' };
  } else {
    fm().createFileAtPathContentsAttributes(paused, $(), $());
    view = { ...view, state: 'paused', message: '' };
  }
  refresh();
}

function copyLast() {
  const text = $.NSString.stringWithContentsOfFileEncodingError(statePath('last.txt'), $.NSUTF8StringEncoding, null);
  if (!text || text.isNil()) return;
  const pb = $.NSPasteboard.generalPasteboard;
  pb.clearContents;
  pb.setStringForType(text, $.NSPasteboardTypeString);
}

function showFlash(kind, ms) {
  flash = { kind, until: Date.now() + ms };
  refresh();
  $.NSTimer.scheduledTimerWithTimeIntervalTargetSelectorUserInfoRepeats(ms / 1000 + 0.05, controller, 'flashEnd:', $(), false);
}

function onLine(line) {
  let event;
  try { event = JSON.parse(line); } catch { return; }
  if (event.type === 'state') {
    view = { state: event.state, message: event.message || '', engine: event.engine || view.engine };
    if (view.state !== 'listening') hearing = false;
    refresh();
  } else if (event.type === 'hud') {
    // 常駐程式的即時狀態：hearing／listening（有沒有聽到人聲）、pasted、nofield
    if (event.line === 'hearing') { hearing = true; refresh(); }
    else if (event.line === 'listening') { hearing = false; refresh(); }
    else if (event.line === 'pasted') showFlash('pasted', 1200);
    else if (event.line === 'nofield') showFlash('nofield', 1800);
  }
}

function onStdout(note) {
  const data = note.userInfo.objectForKey($.NSFileHandleNotificationDataItem);
  if (!data || Number(data.length) === 0) return; // 常駐程式結束，等 ended: 處理
  buffer += ObjC.unwrap($.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding)) || '';
  const lines = buffer.split('\n');
  buffer = lines.pop();
  for (const line of lines) if (line.trim()) onLine(line.trim());
  note.object.readInBackgroundAndNotify;
}

function scheduleRestart(seconds) {
  if (quitting) return;
  $.NSTimer.scheduledTimerWithTimeIntervalTargetSelectorUserInfoRepeats(seconds, controller, 'restart:', $(), false);
}

function onEnded() {
  const waitOther = view.state === 'already-running';
  task = null;
  if (quitting) return;
  if (!waitOther) view = { ...view, state: 'off', message: '' };
  refresh();
  scheduleRestart(waitOther ? 10 : 3);
}

function startListener() {
  if (quitting || task) return;
  try {
    const t = $.NSTask.alloc.init;
    t.setLaunchPath(BUILD.node);
    t.setArguments($([LISTEN, '--app']));
    const env = $.NSMutableDictionary.dictionaryWithDictionary($.NSProcessInfo.processInfo.environment);
    env.setObjectForKey($(`${NODE_DIR}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`), $('PATH'));
    env.setObjectForKey($(BUILD.state), $('VOICE_DICTATION_STATE_DIR'));
    t.setEnvironment(env);
    const pipe = $.NSPipe.pipe;
    t.setStandardOutput(pipe);
    t.setStandardError($.NSFileHandle.fileHandleWithNullDevice);
    const reader = pipe.fileHandleForReading;
    const center = $.NSNotificationCenter.defaultCenter;
    center.addObserverSelectorNameObject(controller, 'stdout:', $.NSFileHandleReadCompletionNotification, reader);
    center.addObserverSelectorNameObject(controller, 'ended:', $.NSTaskDidTerminateNotification, t);
    reader.readInBackgroundAndNotify;
    t.launch;
    task = t;
  } catch (err) {
    view = { ...view, state: 'error', message: `常駐程式開不起來（${BUILD.node}）：${err}` };
    refresh();
    scheduleRestart(30);
  }
}

function quitApp() {
  quitting = true;
  if (task) task.terminate;
  $.NSApplication.sharedApplication.terminate($());
}

ObjC.registerSubclass({
  name: 'VoiceDictationController',
  methods: {
    'toggle:': { types: ['void', ['id']], implementation() { togglePause(); } },
    'copyLast:': { types: ['void', ['id']], implementation() { copyLast(); } },
    'openVocabulary:': {
      types: ['void', ['id']],
      implementation() {
        const path = statePath('vocabulary.txt');
        ensureFile(path, '# 專有名詞：一行一個，# 後面是註解。可以請你的 AI 照 AI_SETUP.md 幫你填。\n');
        openInTextEdit(path);
      },
    },
    'openConfig:': {
      types: ['void', ['id']],
      implementation() {
        const path = statePath('config.json');
        ensureFile(path, '{\n  "engine": "local"\n}\n');
        openInTextEdit(path);
      },
    },
    'openGuide:': { types: ['void', ['id']], implementation() { $.NSWorkspace.sharedWorkspace.openURL($.NSURL.URLWithString(GUIDE_URL)); } },
    'quitApp:': { types: ['void', ['id']], implementation() { quitApp(); } },
    'stdout:': { types: ['void', ['id']], implementation(note) { onStdout(note); } },
    'ended:': { types: ['void', ['id']], implementation() { onEnded(); } },
    'restart:': { types: ['void', ['id']], implementation() { startListener(); } },
    'dumpFrame:': { types: ['void', ['id']], implementation() { dumpFrame(); } },
    'flashEnd:': { types: ['void', ['id']], implementation() { if (flash && Date.now() >= flash.until) { flash = null; refresh(); } } },
  },
});

function menuItem(title, action) {
  const item = $.NSMenuItem.alloc.initWithTitleActionKeyEquivalent(title, action, '');
  if (action) item.setTarget(controller);
  return item;
}

function startUI() {
  fm().createDirectoryAtPathWithIntermediateDirectoriesAttributesError(BUILD.state, true, $(), null);
  controller = $.VoiceDictationController.alloc.init;
  // 新的選單列圖示預設排在最左邊，瀏海機型圖示一多就被擠到瀏海後面看不到：
  // 第一次先放在離螢幕右邊 260 點的位置；之後使用者按 Cmd 拖過的位置系統會自己記住
  const positionKey = 'NSStatusItem Preferred Position VoiceDictation';
  const defaults = $.NSUserDefaults.standardUserDefaults;
  if (defaults.objectForKey(positionKey).isNil()) defaults.setDoubleForKey(260, positionKey);
  statusItem = $.NSStatusBar.systemStatusBar.statusItemWithLength(-2); // NSSquareStatusItemLength：固定寬度
  statusItem.setAutosaveName('VoiceDictation');
  const menu = $.NSMenu.alloc.init;
  menu.setAutoenablesItems(false);
  statusLine = menuItem('啟動中…', null);
  statusLine.setEnabled(false);
  menu.addItem(statusLine);
  menu.addItem($.NSMenuItem.separatorItem);
  toggleItem = menuItem('暫停收音', 'toggle:');
  menu.addItem(toggleItem);
  menu.addItem(menuItem('複製上一句', 'copyLast:'));
  menu.addItem($.NSMenuItem.separatorItem);
  menu.addItem(menuItem('編輯專有名詞…', 'openVocabulary:'));
  menu.addItem(menuItem('編輯設定檔…', 'openConfig:'));
  menu.addItem(menuItem('說明', 'openGuide:'));
  menu.addItem($.NSMenuItem.separatorItem);
  menu.addItem(menuItem('結束語音輸入', 'quitApp:'));
  statusItem.setMenu(menu);
  refresh();
  $.NSTimer.scheduledTimerWithTimeIntervalTargetSelectorUserInfoRepeats(2, controller, 'dumpFrame:', $(), false);
  startListener();
}
