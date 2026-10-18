// 「JarvisVoice」選單列的介面與常駐程式管理。由 app/main.js（包進 .app 的外殼）啟動時讀進來執行，
// 所以改這個檔不用重包 app，麥克風與輔助使用權限也不用重給；改完從選單「結束」再打開 app 就生效。
// 帶起常駐程式 bin/listen.mjs（它掛了 3 秒後自己重開），狀態全顯示在選單列的圖示上。
// 圖示是「JarvisVoice」自己的：單循環箭頭包住三條聲波（自動＋聲音）。固定寬度、不加字（加字會讓旁邊的
// 圖示跳來跳去），顏色交給系統（範本圖，跟其他選單列圖示同色），只換箭頭裡面的東西：
//   三條聲波＝收音中、聲波變高＝聽到你講話、打勾＝剛貼好、叉叉＝游標不在輸入框所以沒貼、
//   ‖＝暫停、聲波變淡＝待命（最前面的 app 不收音）、驚嘆號＝出錯（點開選單看原因）。
// 選單可以切 AI 整理（關／OpenAI／DeepSeek／Claude）、自動找輸入框、語音指令，改的是設定檔，常駐程式會自己換；
// 「換回原文」把上一段 AI 整理過的字換回轉寫原稿。
// BUILD（{ node, repo, state }）由外殼放在全域。
const LISTEN = `${BUILD.repo}/bin/listen.mjs`;
const NODE_DIR = BUILD.node.replace(/\/[^/]*$/, '');
// 系統語言是中文就顯示中文，其他都用英文（VOICE_DICTATION_LANG 可以指定，測試用）
const LANG = ObjC.unwrap($.NSProcessInfo.processInfo.environment.objectForKey('VOICE_DICTATION_LANG'))
  || ObjC.unwrap($.NSLocale.preferredLanguages.firstObject) || '';
const ZH = /^zh/i.test(LANG);
const t = (zh, en) => (ZH ? zh : en);
const ENGINE_NAMES = { local: t('本機', 'on-device'), openai: 'OpenAI', parallelsandbox: t('平行沙盒', 'ParallelSandbox') };
const GUIDE_URL = 'https://github.com/urusaqqrun/jarvis-voice#readme';
const AI_NAMES = { openai: 'OpenAI', deepseek: 'DeepSeek', claude: 'Claude' };

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
// 常駐程式報上來的設定（settings 事件）
let settings = { ai: { enabled: false, provider: 'deepseek', ready: false }, autoFocus: false, commands: false, decider: '' };
let aiMenuItem = null;
let aiOffItem = null;
const aiItems = {};
let autoFocusItem = null;
let commandsItem = null;

const statePath = (name) => `${BUILD.state}/${name}`;
const fm = () => $.NSFileManager.defaultManager;

function label() {
  const name = ENGINE_NAMES[view.engine] ? t(`（${ENGINE_NAMES[view.engine]}）`, ` (${ENGINE_NAMES[view.engine]})`) : '';
  switch (view.state) {
    case 'listening': return settings.ai.enabled && settings.ai.ready
      ? t(`聽著${name}：講完一段，${AI_NAMES[settings.ai.provider]} 整理後寫進輸入框`, `Listening${name}: each passage is cleaned up by ${AI_NAMES[settings.ai.provider]} and typed in`)
      : t(`聽著${name}：講完一句就貼進游標所在的輸入框`, `Listening${name}: each sentence is pasted where your cursor is`);
    case 'standby': return t(`待命${name}：最前面的 app 不收音`, `Standing by${name}: the frontmost app is excluded`);
    case 'paused': return t(`已暫停${name}`, `Paused${name}`);
    case 'error': return t(`出錯：${view.message}`, `Error: ${view.message}`);
    case 'already-running': return t('已經有另一個 JarvisVoice 在跑，等它結束後接手', 'Another JarvisVoice is running; taking over when it exits');
    case 'off': return t('常駐程式沒在跑，重新啟動中…', 'The background process stopped; restarting…');
    default: return t('啟動中…', 'Starting…');
  }
}

// ── 選單列圖示：18×18 點的格子（左下角原點），黑色加透明度畫，系統再依選單列換成白或黑 ──

function iconPath(points) {
  const p = $.NSBezierPath.bezierPath;
  points.forEach(([x, y], i) => (i ? p.lineToPoint($.NSMakePoint(x, y)) : p.moveToPoint($.NSMakePoint(x, y))));
  return p;
}

function iconBar(cx, h, alpha = 1, cy = 9) {
  $.NSColor.colorWithWhiteAlpha(0, alpha).set;
  $.NSBezierPath.bezierPathWithRoundedRectXRadiusYRadius($.NSMakeRect(cx - 0.75, cy - h / 2, 1.5, h), 0.75, 0.75).fill;
}

function iconStroke(points, width = 1.5) {
  $.NSColor.blackColor.set;
  const p = iconPath(points);
  p.setLineWidth(width);
  p.setLineCapStyle(1); // 圓頭
  p.setLineJoinStyle(1);
  p.stroke;
}

// 暫停：外圈裡一支麥克風，一條斜線從外圈一邊連到另一邊（像「禁止」標誌），跟「在聽」的聲波一眼分得出來。
// 斜線兩旁先把麥克風挖空一點，線才不會黏在麥克風上
function drawMutedMic() {
  $.NSColor.blackColor.set;
  $.NSBezierPath.bezierPathWithRoundedRectXRadiusYRadius($.NSMakeRect(7.5, 8.9, 3, 4.9), 1.5, 1.5).fill;
  const holder = $.NSBezierPath.bezierPath;
  holder.appendBezierPathWithArcWithCenterRadiusStartAngleEndAngleClockwise($.NSMakePoint(9, 10.7), 3.1, 200, 340, false);
  holder.setLineWidth(1.25);
  holder.setLineCapStyle(1);
  holder.stroke;
  iconStroke([[9, 7.6], [9, 5.7]], 1.25);
  const d = 7.2 / Math.SQRT2; // 斜線兩端壓進外圈，不留細縫
  const gap = iconPath([[9 - 4.2, 9 + 4.2], [9 + 4.2, 9 - 4.2]]);
  gap.setLineWidth(3.05);
  $.NSGraphicsContext.currentContext.setCompositingOperation(0); // NSCompositingOperationClear
  gap.stroke;
  $.NSGraphicsContext.currentContext.setCompositingOperation(2); // NSCompositingOperationSourceOver
  const slash = iconPath([[9 - d, 9 + d], [9 + d, 9 - d]]);
  slash.setLineWidth(1.25);
  slash.stroke;
}

// kind：listening、speaking、standby、paused、pasted、nofield、error
function drawGlyph(kind) {
  $.NSColor.blackColor.set;
  // 單循環箭頭：圓心 (9, 9)、半徑 6.9，缺口在右上。箭頭底邊中點在 50°，尖端落在圓上 80°，
  // 圓線畫到 52°（藏在箭頭裡），另一頭停在 100°，跟箭頭尖端留一段空隙
  const R = 6.9;
  const at = (deg) => [9 + R * Math.cos((deg * Math.PI) / 180), 9 + R * Math.sin((deg * Math.PI) / 180)];
  const ring = $.NSBezierPath.bezierPath;
  ring.appendBezierPathWithArcWithCenterRadiusStartAngleEndAngleClockwise($.NSMakePoint(9, 9), R, 52, 100, true);
  ring.setLineWidth(1.5);
  ring.stroke;
  const [bx, by] = at(50);
  const [tx, ty] = at(80);
  const len = Math.hypot(tx - bx, ty - by);
  const [nx, ny] = [(ty - by) / len, -(tx - bx) / len]; // 跟箭頭方向垂直
  const half = 2.3;
  const tip = iconPath([[tx, ty], [bx + nx * half, by + ny * half], [bx - nx * half, by - ny * half]]);
  tip.closePath;
  tip.fill;
  if (kind === 'speaking') [[6.6, 3.8], [9, 7.2], [11.4, 4.8]].forEach(([x, h]) => iconBar(x, h));
  else if (kind === 'standby') [[6.6, 2.6], [9, 5.2], [11.4, 3.2]].forEach(([x, h]) => iconBar(x, h, 0.35));
  else if (kind === 'paused') drawMutedMic();
  else if (kind === 'pasted') iconStroke([[6.3, 9.1], [8.3, 7.1], [11.9, 10.9]], 1.6);
  else if (kind === 'nofield') { iconStroke([[6.9, 11.1], [11.1, 6.9]]); iconStroke([[6.9, 6.9], [11.1, 11.1]]); }
  else if (kind === 'error') {
    // 驚嘆號整體（直線 5、空隙 1.1、圓點 1.6）的中心對齊圓心
    iconBar(9, 5, 1, 10.35);
    $.NSBezierPath.bezierPathWithOvalInRect($.NSMakeRect(8.2, 5.15, 1.6, 1.6)).fill;
  }
  else [[6.6, 2.6], [9, 5.2], [11.4, 3.2]].forEach(([x, h]) => iconBar(x, h));
}

const iconCache = {};
function iconImage(kind) {
  if (iconCache[kind]) return iconCache[kind];
  const image = $.NSImage.alloc.initWithSize($.NSMakeSize(18, 18));
  image.lockFocus;
  drawGlyph(kind);
  image.unlockFocus;
  image.setTemplate(true);
  iconCache[kind] = image;
  return image;
}

// 選單列圖示要畫哪一種，以及滑鼠停上去的說明
function look() {
  if (flash && Date.now() < flash.until) return flash.kind === 'pasted' ? ['pasted', t('已貼上', 'Pasted')] : ['nofield', t('游標不在輸入框，沒貼', 'Not in a text field; nothing pasted')];
  if (view.state === 'listening') return hearing ? ['speaking', t('說話中', 'Hearing you')] : ['listening', ''];
  if (view.state === 'paused') return ['paused', ''];
  if (view.state === 'error') return ['error', ''];
  return ['standby', ''];
}

// 測試用：目前選單列圖示旁的字、選單第一行、AI 與開關的勾選狀態
function uiSnapshot() {
  if (!statusItem) return null;
  return {
    title: ObjC.unwrap(statusItem.button.title),
    line: ObjC.unwrap(statusLine.title),
    ai: ObjC.unwrap(aiMenuItem.title),
    checked: [aiOffItem, ...Object.values(aiItems), autoFocusItem, commandsItem].map((item) => item.state).join(''),
    commands: ObjC.unwrap(commandsItem.title),
  };
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
  const [kind, hint] = look();
  statusItem.button.setImage(iconImage(kind));
  statusItem.button.setToolTip(`JarvisVoice：${hint || label()}`);
  statusLine.setTitle(label());
  toggleItem.setTitle(view.state === 'paused' ? t('繼續收音', 'Resume listening') : t('暫停收音', 'Pause listening'));
}

function refreshSettings() {
  if (!aiMenuItem) return;
  const { ai } = settings;
  aiMenuItem.setTitle(`${t('AI 整理：', 'AI cleanup: ')}${ai.enabled ? `${AI_NAMES[ai.provider]}${ai.ready ? '' : t('（沒有 key）', ' (no key)')}` : t('關', 'Off')}`);
  aiOffItem.setState(ai.enabled ? 0 : 1);
  for (const [provider, item] of Object.entries(aiItems)) item.setState(ai.enabled && ai.provider === provider ? 1 : 0);
  autoFocusItem.setState(settings.autoFocus ? 1 : 0);
  commandsItem.setState(settings.commands ? 1 : 0);
  commandsItem.setTitle(settings.decider
    ? t(`語音指令（直接操作 app，${settings.decider} 決策）`, `Voice commands (operate apps, decided by ${settings.decider})`)
    : t('語音指令（直接操作 app）', 'Voice commands (operate apps)'));
}

// 改設定檔：讀進來、改、寫回去；常駐程式看到檔案改了會自己換設定
function updateConfig(change) {
  const path = statePath('config.json');
  let config = {};
  const text = $.NSString.stringWithContentsOfFileEncodingError(path, $.NSUTF8StringEncoding, null);
  if (text && !text.isNil()) {
    try { config = JSON.parse(ObjC.unwrap(text)); } catch (err) {
      openInTextEdit(path); // 設定檔壞了不要蓋掉，打開給人看
      return;
    }
  }
  change(config);
  $(`${JSON.stringify(config, null, 2)}\n`).writeToFileAtomicallyEncodingError(path, true, $.NSUTF8StringEncoding, null);
}

function chooseAi(provider) {
  updateConfig((config) => {
    config.ai = config.ai ?? {};
    config.ai.enabled = !!provider;
    if (provider) config.ai.provider = provider;
  });
}

// 開關型的設定（autoFocus、commands）：照常駐程式目前報的狀態反過來
function toggleSetting(key) {
  updateConfig((config) => { config[key] = !settings[key]; });
}

function requestRevert() {
  fm().createFileAtPathContentsAttributes(statePath('revert-request'), $(), $());
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
  if (event.type === 'settings') {
    settings = { ...settings, ...event };
    refreshSettings();
    refresh();
  } else if (event.type === 'state') {
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
    view = { ...view, state: 'error', message: t(`常駐程式開不起來（${BUILD.node}）：${err}`, `Can't start the background process (${BUILD.node}): ${err}`) };
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
        ensureFile(path, t('# 專有名詞：一行一個，# 後面是註解。可以請你的 AI 照 AI_SETUP.md 幫你填。\n', '# Vocabulary: one term per line; # starts a comment. Your AI can fill this in by following AI_SETUP.md.\n'));
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
    'openGuide:': {
      types: ['void', ['id']],
      implementation() {
        const url = ZH ? 'https://github.com/urusaqqrun/jarvis-voice/blob/main/README.zh-TW.md' : GUIDE_URL;
        $.NSWorkspace.sharedWorkspace.openURL($.NSURL.URLWithString(url));
      },
    },
    'quitApp:': { types: ['void', ['id']], implementation() { quitApp(); } },
    'aiOff:': { types: ['void', ['id']], implementation() { chooseAi(''); } },
    'aiOpenai:': { types: ['void', ['id']], implementation() { chooseAi('openai'); } },
    'aiDeepseek:': { types: ['void', ['id']], implementation() { chooseAi('deepseek'); } },
    'aiClaude:': { types: ['void', ['id']], implementation() { chooseAi('claude'); } },
    'toggleAutoFocus:': { types: ['void', ['id']], implementation() { toggleSetting('autoFocus'); } },
    'toggleCommands:': { types: ['void', ['id']], implementation() { toggleSetting('commands'); } },
    'revert:': { types: ['void', ['id']], implementation() { requestRevert(); } },
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
  statusLine = menuItem(t('啟動中…', 'Starting…'), null);
  statusLine.setEnabled(false);
  menu.addItem(statusLine);
  menu.addItem($.NSMenuItem.separatorItem);
  toggleItem = menuItem(t('暫停收音', 'Pause listening'), 'toggle:');
  menu.addItem(toggleItem);
  menu.addItem(menuItem(t('複製上一句', 'Copy last sentence'), 'copyLast:'));
  menu.addItem(menuItem(t('換回原文（上一段 AI 整理前）', 'Revert to original (before AI cleanup)'), 'revert:'));
  menu.addItem($.NSMenuItem.separatorItem);
  aiMenuItem = menuItem(t('AI 整理：關', 'AI cleanup: Off'), null);
  const aiMenu = $.NSMenu.alloc.init;
  aiMenu.setAutoenablesItems(false);
  aiOffItem = menuItem(t('關（講完一句直接貼）', 'Off (paste each sentence as is)'), 'aiOff:');
  aiMenu.addItem(aiOffItem);
  aiMenu.addItem($.NSMenuItem.separatorItem);
  for (const [provider, name] of Object.entries(AI_NAMES)) {
    aiItems[provider] = menuItem(name, `ai${provider[0].toUpperCase()}${provider.slice(1)}:`);
    aiMenu.addItem(aiItems[provider]);
  }
  aiMenuItem.setSubmenu(aiMenu);
  menu.addItem(aiMenuItem);
  autoFocusItem = menuItem(t('自動找輸入框（游標不在輸入框時）', 'Auto-focus (when the cursor isn\'t in a text field)'), 'toggleAutoFocus:');
  menu.addItem(autoFocusItem);
  commandsItem = menuItem(t('語音指令', 'Voice commands'), 'toggleCommands:');
  menu.addItem(commandsItem);
  menu.addItem($.NSMenuItem.separatorItem);
  menu.addItem(menuItem(t('編輯專有名詞…', 'Edit vocabulary…'), 'openVocabulary:'));
  menu.addItem(menuItem(t('編輯設定檔…', 'Edit config…'), 'openConfig:'));
  menu.addItem(menuItem(t('說明', 'Help'), 'openGuide:'));
  menu.addItem($.NSMenuItem.separatorItem);
  menu.addItem(menuItem(t('結束 JarvisVoice', 'Quit JarvisVoice'), 'quitApp:'));
  statusItem.setMenu(menu);
  refreshSettings();
  refresh();
  $.NSTimer.scheduledTimerWithTimeIntervalTargetSelectorUserInfoRepeats(2, controller, 'dumpFrame:', $(), false);
  startListener();
}
