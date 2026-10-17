// 選單列小程式「語音輸入」（JXA，由 app/build.sh 用 osacompile 包成 .app，不用 Xcode）。
// 開起來就帶起常駐程式 bin/listen.mjs（它掛了 3 秒後自己重開），在選單列顯示狀態：
//   紅色麥克風＝收音中、劃掉的麥克風＝暫停、三角形＝出錯、灰色麥克風＝待命（這個 app 不收音）。
// 麥克風與「輔助使用」權限都算在這個 app 頭上。BUILD 由 build.sh 在包的時候填進來。
ObjC.import('Cocoa');

const BUILD = __BUILD__; // { node, repo, state }
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

function refresh() {
  if (!statusItem) return;
  let symbol = 'mic';
  let tint = $();
  if (view.state === 'listening') { symbol = 'mic.fill'; tint = $.NSColor.systemRedColor; }
  else if (view.state === 'paused') symbol = 'mic.slash';
  else if (view.state === 'error') { symbol = 'exclamationmark.triangle'; tint = $.NSColor.systemOrangeColor; }
  const image = $.NSImage.imageWithSystemSymbolNameAccessibilityDescription(symbol, '語音輸入');
  image.setTemplate(true);
  statusItem.button.setImage(image);
  statusItem.button.setContentTintColor(tint);
  statusItem.button.setToolTip(`語音輸入：${label()}`);
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

function onLine(line) {
  let event;
  try { event = JSON.parse(line); } catch { return; }
  if (event.type !== 'state') return;
  view = { state: event.state, message: event.message || '', engine: event.engine || view.engine };
  refresh();
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
  },
});

function menuItem(title, action) {
  const item = $.NSMenuItem.alloc.initWithTitleActionKeyEquivalent(title, action, '');
  if (action) item.setTarget(controller);
  return item;
}

function run() {
  fm().createDirectoryAtPathWithIntermediateDirectoriesAttributesError(BUILD.state, true, $(), null);
  controller = $.VoiceDictationController.alloc.init;
  statusItem = $.NSStatusBar.systemStatusBar.statusItemWithLength(-1); // NSVariableStatusItemLength
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
  startListener();
}
