#!/usr/bin/env node
// 語音輸入的常駐程式（由選單列小程式「全語音輸入」帶起來）：自動收音，講完就寫進目前游標所在的輸入框——
// 在哪個 app、哪個欄位，字就進哪裡；只貼不送出。開會、通話的 app 在最前面或按了暫停時關麥克風。
// 整台電腦同時只跑一個（鎖檔）。
//
// 三層：
//   1. 全語音輸入：停頓 0.85 秒切一句，轉寫完就貼（AI 整理關著時）。
//   2. AI 整理（ai.enabled）：停頓超過 ai.segmentPauseMs 算一段講完，讀游標前後與 app、視窗、網址，
//      整段交給 AI（OpenAI／DeepSeek／Claude）整理再貼；選取了字又講指令就改寫選取的字。原稿留著可以換回。
//   3. 自動找輸入框（autoFocus）：游標不在輸入框時，挑視窗裡最像要寫字的輸入框，對焦後寫進去。
//
// 轉寫引擎看設定檔（bin/config.mjs）：local 本機 SenseVoice、openai 自己的 key（預設 gpt-transcribe 一般轉寫，
// 也可以選 gpt-live-transcribe 即時）、parallelsandbox。設定檔改了會自動換。
// 狀態寫在 status.json 給狀態列讀；有 paused 檔就暫停；有 revert-request 檔就把上一段換回原稿。
// stdout 每行一個 JSON（state、settings、hud、pasted、skipped）。
// 選項：--app 由選單列小程式帶起（log 寫進 listen.log，小程式不在了就結束）。
// 測試選項：--file <音檔> 用音檔代替麥克風、讀完收尾結束；--dry-paste 只印不貼；--always 不看前景 app。

import { execFile, spawn } from 'node:child_process';
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createAx } from './ax.mjs';
import { runCommand } from './commander.mjs';
import { AudioTurnDetector, BATCH_BYTES, SAMPLE_RATE, findFfmpeg } from './common.mjs';
import { STATE_DIR, aiKey, appAllowed, configMtime, isLiveModel, loadConfig, styleFor } from './config.mjs';
import { DEFAULT_MODELS, PROVIDER_NAMES, editSegment } from './editor.mjs';
import { createBatchEngine } from './engines/batch.mjs';
import { createLocalEngine } from './engines/local.mjs';
import { createRealtimeEngine, openaiConnector, parallelSandboxConnector } from './engines/realtime.mjs';
import { appendHistory } from './history.mjs';
import { createDecider, describeElement, fieldQuestions, inFieldIntentQuestion, inFieldVerdict, intentQuestion, referenceQuestion } from './decide.mjs';
import { createLearner } from './learn.mjs';
import { rankTargets } from './targeter.mjs';
import { finishText, isSpeech, withSpacing } from './text.mjs';

const LOCK = join(STATE_DIR, 'listener.lock');
const PAUSED = join(STATE_DIR, 'paused');
const REVERT = join(STATE_DIR, 'revert-request');
const STATUS = join(STATE_DIR, 'status.json');
const LAST = join(STATE_DIR, 'last.txt');
const LOG = join(STATE_DIR, 'listen.log');
const POLL_MS = 500;
const SEGMENT_CHECK_MS = 100;
const HOLD_MS = 60_000; // 寫的時候前景是不收音的 app（例如開會），最多等一分鐘回來再寫
const MAX_SEGMENT_CHARS = 1500; // 一直講不停太長就先整理這一段
const COMMAND_MIN = 0.5; // AI 說是指令時，Jev 也要覺得是的機率

const argv = process.argv.slice(2);
const fileIndex = argv.indexOf('--file');
const inputFile = fileIndex >= 0 ? argv[fileIndex + 1] : null;
const dryPaste = argv.includes('--dry-paste');
const always = argv.includes('--always') || !!inputFile;
const appMode = argv.includes('--app');
const parentPid = process.ppid;

const emit = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);
const log = (...parts) => {
  const line = `[listen] ${parts.join(' ')}\n`;
  if (!appMode) { process.stderr.write(line); return; }
  try { appendFileSync(LOG, `${new Date().toISOString()} ${line}`); } catch { /* 寫不進就算了 */ }
};
const exec = (cmd, args, timeout = 3000) => new Promise((resolve) => {
  execFile(cmd, args, { timeout }, (err, stdout) => resolve(err ? '' : stdout));
});

// ---- 鎖：同時只跑一個 ----

const isAlive = (pid) => {
  try { process.kill(pid, 0); return true; } catch (err) { return err.code === 'EPERM'; }
};

function takeLock() {
  mkdirSync(STATE_DIR, { recursive: true });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = openSync(LOCK, 'wx');
      writeFileSync(fd, String(process.pid));
      closeSync(fd);
      return true;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      const pid = Number(readFileSync(LOCK, 'utf8').trim());
      if (pid && pid !== process.pid && isAlive(pid)) return false;
      try { unlinkSync(LOCK); } catch { /* 別人剛清掉 */ }
    }
  }
  return false;
}

function releaseLock() {
  try { if (readFileSync(LOCK, 'utf8').trim() === String(process.pid)) unlinkSync(LOCK); } catch { /* 已經不在 */ }
}

// ---- 即時狀態（選單列小程式顯示：說話中、已貼上、沒有輸入框）----

let stopping = false;
let hudMode = '';

// 交給選單列小程式（--app 時從 stdout 送出）；hearing、listening、hide、error:<訊息>、pasted、nofield
function hudWrite(line) {
  if (appMode) emit({ type: 'hud', line });
}

function hudShow(mode) {
  if (mode === hudMode) return;
  hudMode = mode;
  hudWrite(mode);
}

// ---- 設定與引擎 ----

let { config, error: configError } = loadConfig();
let configStamp = configMtime(config);
let engine = null;

// AI 整理開著而且有 key 才走第二層
const aiReady = () => config.ai.enabled && !!aiKey(config);
const aiSettings = () => ({
  provider: config.ai.provider,
  model: config.ai.models[config.ai.provider] || '',
  apiKey: aiKey(config),
  timeoutMs: config.ai.timeoutMs,
});

function announceSettings() {
  const provider = config.ai.provider;
  const model = config.ai.models[provider] || DEFAULT_MODELS[provider];
  const deciderName = config.jev.apiKey ? 'Jev' : aiReady() ? PROVIDER_NAMES[provider] : '';
  emit({
    type: 'settings',
    ai: { enabled: config.ai.enabled, provider, ready: aiReady() },
    autoFocus: config.autoFocus,
    commands: config.commands,
    decider: deciderName,
  });
  log(`AI 整理：${config.ai.enabled ? `${PROVIDER_NAMES[provider]}（${model}）${aiReady() ? '' : '，但沒有 key，先不整理'}` : '關'}；`
    + `自動找輸入框：${config.autoFocus ? '開' : '關'}；指令模式：${config.commands ? (aiReady() ? '開' : '開，但要先開 AI 整理') : '關'}；`
    + `第三層決策：${deciderName || '沒有（照規則）'}`);
  if (config.ai.enabled && !aiReady()) {
    setError(`AI 整理選了 ${PROVIDER_NAMES[provider]}，但沒有 key（設定檔 ai.keys.${provider} 或 ai.keyFiles.${provider}）`);
  }
}

function startEngine() {
  engine?.close();
  const callbacks = {
    log,
    onError: (message) => setError(message),
    onFinal: (raw) => {
      const text = finishText(raw, {
        output: config.output,
        replacements: config.replacements,
        alreadyTraditional: config.engine === 'parallelsandbox',
      });
      log(`轉寫結果：${text || '（空的）'}`);
      if (!isSpeech(text)) return;
      if (aiReady()) addToSegment(text);
      else enqueueOutput({ kind: 'text', text });
    },
  };
  if (config.engine === 'local') engine = createLocalEngine({ ...config.local, ...callbacks });
  else if (config.engine === 'openai' && isLiveModel(config.openai.model)) engine = createRealtimeEngine({ connector: openaiConnector(config.openai), ...callbacks });
  else if (config.engine === 'openai') engine = createBatchEngine({ ...config.openai, ...callbacks });
  else engine = createRealtimeEngine({ connector: parallelSandboxConnector(config.parallelsandbox), ...callbacks });
  log(`轉寫引擎：${config.engine}${config.engine === 'openai' ? `（${config.openai.model}，詞彙 ${config.openai.keywords.length} 個）` : ''}`);
  if (configError) setError(configError);
  announceSettings();
}

function reloadConfigIfChanged() {
  const stamp = configMtime(config);
  if (stamp === configStamp) return;
  configStamp = stamp;
  ({ config, error: configError } = loadConfig());
  configStamp = configMtime(config);
  startEngine();
}

// ---- 狀態 ----

let state = '';
let stateMessage = '';
let frontActive = false; // 目標 app 在最前面且沒暫停
let lastError = null; // { message, at }：錯誤在狀態列留 15 秒
function setError(message) {
  lastError = { message, at: Date.now() };
  setState('error', message);
}
function setState(next, message = '') {
  if (next === state && message === stateMessage) return;
  state = next;
  stateMessage = message;
  emit({ type: 'state', state, message, engine: config.engine });
  if (state === 'listening') hudShow(detector.speaking ? 'hearing' : 'listening');
  else if (state === 'error' && frontActive) hudShow(`error:${message}`);
  else hudShow('hide');
  try {
    const tmp = `${STATUS}.${process.pid}`;
    writeFileSync(tmp, JSON.stringify({ state, message, engine: config.engine, pid: process.pid, at: Date.now() }));
    renameSync(tmp, STATUS);
  } catch { /* 狀態列看不到而已 */ }
}

async function frontApp() {
  const asn = (await exec('/usr/bin/lsappinfo', ['front'])).trim();
  if (!asn) return { bundle: '', pid: 0 };
  const info = await exec('/usr/bin/lsappinfo', ['info', '-only', 'bundleid', '-only', 'pid', asn]);
  return {
    bundle: info.match(/"CFBundleIdentifier"="([^"]*)"/)?.[1] ?? '',
    pid: Number(info.match(/"pid"=(\d+)/)?.[1] ?? 0),
  };
}

// 這個 app 在最前面時要不要收音（VOICE_DICTATION_APPS 給測試用：只認這些）
const allowed = (bundle) => (process.env.VOICE_DICTATION_APPS
  ? process.env.VOICE_DICTATION_APPS.split(',').includes(bundle)
  : appAllowed(config, bundle));

// ---- 收音與切句 ----

let ffmpeg = null;
let captureRetryAt = 0;
let detector = new AudioTurnDetector();
let pendingChunks = [];
let pendingBytes = 0;
let preRoll = [];
let carry = Buffer.alloc(0);
let sentSamples = 0;
let lastSpeechAt = 0;
let lastVoiceAt = 0; // 最後一次真的聽到人聲（算一段講完了沒）

// 講話中的音訊邊講邊交給引擎（雲端引擎會先送出去），講完一句再 commit
const stageAudio = () => {
  if (!pendingBytes) return;
  engine.append(Buffer.concat(pendingChunks, pendingBytes));
  pendingChunks = [];
  pendingBytes = 0;
};

const queueTurn = () => {
  stageAudio();
  engine.commit();
};

// 診斷：每 15 秒記一次這段時間的最大音量，看麥克風到底有沒有收到聲音（全 0＝沒權限或被別的程式占住）
let levelPeak = 0;
let reopenCapture = false;
let levelSince = Date.now();
function trackLevel(samples) {
  for (const v of samples) { const a = Math.abs(v) / 32768; if (a > levelPeak) levelPeak = a; }
  if (Date.now() - levelSince < 15_000) return;
  log(`麥克風 15 秒內最大音量 ${levelPeak.toFixed(3)}（人聲門檻 0.055）${levelPeak === 0 ? '：完全沒聲音，多半是剛給麥克風權限前就開了，重開麥克風' : ''}`);
  // 權限詢問還沒按允許時開的麥克風，允許之後也一直收到 0：重開一次就好
  if (levelPeak === 0) reopenCapture = true;
  levelPeak = 0;
  levelSince = Date.now();
}

function takeBatch(chunk) {
  const samples = new Int16Array(chunk.buffer, chunk.byteOffset, chunk.length / 2);
  trackLevel(samples);
  const startMs = sentSamples / 24;
  sentSamples += samples.length;
  const wasSpeaking = detector.speaking;
  const turn = detector.push(samples, startMs);
  if (wasSpeaking) {
    pendingChunks.push(chunk);
    pendingBytes += chunk.length;
  } else if (detector.speaking) {
    for (const b of [...preRoll, chunk]) { pendingChunks.push(b); pendingBytes += b.length; }
    preRoll = [];
  } else {
    preRoll.push(chunk);
    if (preRoll.length > 4) preRoll.shift();
  }
  if (detector.speaking) lastSpeechAt = Date.now();
  if ((detector.speaking || turn) && detector.lastVoiced) lastVoiceAt = Date.now();
  if (detector.speaking !== wasSpeaking && state === 'listening') hudShow(detector.speaking ? 'hearing' : 'listening');
  if (turn) {
    log(`切出一句 ${((turn.endMs - turn.startMs) / 1000).toFixed(1)} 秒，送去轉寫`);
    queueTurn();
  }
}

// 停麥克風時把講到一半的那句送出去
function finishTurn() {
  if (carry.length >= 2) takeBatch(Buffer.from(carry.subarray(0, carry.length - (carry.length % 2))));
  carry = Buffer.alloc(0);
  const turn = detector.finish();
  if (turn) {
    for (const b of preRoll) { pendingChunks.push(b); pendingBytes += b.length; }
    queueTurn();
  }
  preRoll = [];
  pendingChunks = [];
  pendingBytes = 0;
}

let captureEnded = null;
function startCapture() {
  log('開麥克風');
  levelPeak = 0;
  levelSince = Date.now();
  detector = new AudioTurnDetector();
  preRoll = [];
  carry = Buffer.alloc(0);
  const input = inputFile ? ['-re', '-i', inputFile] : ['-f', 'avfoundation', '-i', ':default'];
  const child = spawn(findFfmpeg(), [
    '-hide_banner', '-loglevel', 'error', '-nostdin', ...input,
    '-ac', '1', '-ar', String(SAMPLE_RATE), '-f', 's16le', 'pipe:1',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  ffmpeg = child;
  let errText = '';
  let gotAudio = false;
  child.stderr.on('data', (d) => { errText = (errText + d.toString()).slice(-400); });
  child.stdout.on('data', (data) => {
    if (ffmpeg !== child) return;
    gotAudio = true;
    carry = carry.length ? Buffer.concat([carry, data]) : data;
    while (carry.length >= BATCH_BYTES) {
      takeBatch(Buffer.from(carry.subarray(0, BATCH_BYTES)));
      carry = carry.subarray(BATCH_BYTES);
    }
  });
  captureEnded = new Promise((resolve) => child.on('close', resolve));
  child.on('close', (code) => {
    if (ffmpeg !== child) return;
    ffmpeg = null;
    finishTurn();
    if (inputFile) return;
    const detail = errText.trim().split('\n').at(-1) || `ffmpeg 結束（${code}）`;
    setError(gotAudio ? `麥克風中斷：${detail}` : `麥克風開不起來：${detail}`);
    captureRetryAt = Date.now() + 10_000;
  });
  child.on('error', (err) => {
    if (ffmpeg !== child) return;
    ffmpeg = null;
    setError(`ffmpeg 開不起來：${err.message}（brew install ffmpeg）`);
    captureRetryAt = Date.now() + 30_000;
  });
}

function stopCapture() {
  const child = ffmpeg;
  ffmpeg = null;
  try { child?.kill('SIGKILL'); } catch { /* 已經結束 */ }
  finishTurn();
}

// ---- 第二層：一段話（幾句）講完才整理 ----

let segment = null; // { parts: [], chars }
let segmentForce = false;

function addToSegment(text) {
  segment ??= { parts: [], chars: 0 };
  segment.parts.push(text);
  segment.chars += text.length;
}

// 每句都已經轉完、而且停了夠久，才算一段講完
function checkSegment() {
  if (!segment) return;
  if (engine.busy() || pendingBytes) return;
  const long = segment.chars >= MAX_SEGMENT_CHARS;
  if (!segmentForce && !long && (detector.speaking || Date.now() - lastVoiceAt < config.ai.segmentPauseMs)) return;
  const raw = segment.parts.map(withSpacing).join('').trim();
  segment = null;
  segmentForce = false;
  enqueueOutput({ kind: 'segment', raw });
}

// ---- 寫進輸入框 ----

const ax = createAx({ log });
const outputQueue = [];
let outputBusy = false;
let askedAccessibility = false;
let lastInserted = null; // { pid, text：實際貼上的字, raw：原稿, ai：是不是 AI 整理過 }
const rememberedTargets = new Map(); // `${pid}:${視窗標題}` → 上次寫進去的輸入框
const learner = createLearner({
  ax,
  log,
  settings: () => ({ enabled: aiReady() && config.ai.learn, ai: aiSettings(), vocabularyFile: config.openai.vocabularyFile }),
});

const writeLast = (text) => { try { writeFileSync(LAST, text); } catch { /* 選單「複製上一句」拿不到而已 */ } };

function enqueueOutput(item) {
  outputQueue.push({ ...item, at: Date.now() });
  if (item.kind === 'text') writeLast(item.text);
  void drainOutput();
}

async function axCall(op, args, timeoutMs) {
  try {
    return await ax.call(op, args, timeoutMs);
  } catch (err) {
    log(`AX 小幫手 ${op} 失敗：${err.message}`);
    return null;
  }
}

const decider = createDecider(() => ({ jevKey: config.jev.apiKey, jevModel: config.jev.model, ai: aiReady() ? aiSettings() : null }));
const commandsOn = () => config.commands && aiReady();

// 第三層（輸入）：游標不在輸入框，挑視窗裡要寫的輸入框對焦。上次寫的那個或只有一個就直接用，
// 其他交給決策器（Jev 或 AI）挑，沒有決策器就照規則排第一的
async function focusBestField(pid, transcript, ctx) {
  const found = await axCall('targets', { pid });
  if (!found) return false;
  const remembered = rememberedTargets.get(`${pid}:${found.window?.title ?? ''}`);
  let { choice, reason, sure, list } = rankTargets({ candidates: found.candidates, window: found.window, remembered });
  if (!sure && decider.available()) {
    try {
      const started = Date.now();
      const a = await decider.decide({ transcript, app: ctx?.app ?? '', window: found.window?.title ?? '' }, fieldQuestions(list, found.window));
      const pick = list[Number(String(a.target?.choice ?? '').slice(1))];
      if (pick) {
        choice = pick;
        reason = `${decider.engine()} 挑的，信心 ${(a.target.confidence ?? 0).toFixed(2)}，${Date.now() - started} ms`;
      }
    } catch (err) {
      log(`決策器失敗，改照規則挑：${err.message}`);
    }
  }
  if (!choice) {
    log(`游標不在輸入框，${reason}`);
    return false;
  }
  await axCall('focus', { handle: choice.handle });
  log(`游標不在輸入框，自動對焦到「${choice.label || choice.role}」（${reason}）`);
  return true;
}

const readContext = (front) => (dryPaste || !front.pid ? null : axCall('context', { pid: front.pid, chars: config.ai.contextChars }));

// 游標在輸入框時問 Jev：看畫面上有什麼，判斷這句是不是要操作畫面
async function judgeInField(raw, front, ctx) {
  const snap = await axCall('elements', { pid: front.pid, limit: 150 }, 3000);
  const items = (snap?.elements ?? []).filter((e) => !['AXTextField', 'AXTextArea', 'AXComboBox', 'AXSearchField'].includes(e.role)).slice(0, 120);
  const field = [ctx.field.label, ctx.field.role].filter(Boolean).join('，');
  const answers = await decider.decide({
    transcript: raw, app: ctx.app ?? '', window: ctx.window ?? '', field: `${field}（游標在這）`,
    screen: items.map((e) => describeElement(e, snap?.window)),
  }, { intent: inFieldIntentQuestion(), target: referenceQuestion(items, snap?.window) });
  return inFieldVerdict(answers, items);
}

// AI 整理。開了指令模式而且有 Jev，同時問 Jev（不多花時間）：
//   游標不在輸入框：AI 和 Jev 都說是指令才算；
//   游標在輸入框：Jev 看了畫面很確定是要操作畫面才算（這時再請 AI 拆出目標和要搜尋的字）。
// 沒有 Jev 就照 AI 整理的判斷（游標在輸入框時只有開頭講「指令」才算）
async function aiEdit(raw, front, ctx) {
  if (!aiReady()) return null;
  if (config.ai.skipApps.includes(front.bundle) || ctx?.field.secure) {
    log('密碼欄或排除的 app，不送 AI，直接貼原稿');
    return null;
  }
  const inField = !!ctx?.field.editable;
  const field = inField ? [ctx.field.label, ctx.field.role].filter(Boolean).join('，') : '';
  const jev = commandsOn() && config.jev.apiKey && front.pid;
  const judge = !jev ? null
    : inField
      ? judgeInField(raw, front, ctx).catch((err) => { log(`Jev 判斷指令失敗：${err.message}`); return null; })
      : decider.decide({ transcript: raw, app: ctx?.app ?? '', window: ctx?.window ?? '', field }, { intent: intentQuestion() })
        .then((a) => ({ command: a.intent?.probabilities?.command ?? 0, named: null, isCommand: (a.intent?.probabilities?.command ?? 0) >= COMMAND_MIN }),
          (err) => { log(`Jev 判斷指令失敗：${err.message}`); return null; });
  const edit = (transcript) => editSegment({
    ...aiSettings(),
    transcript,
    context: { app: ctx?.app, bundle: front.bundle, window: ctx?.window, url: ctx?.url, field: ctx?.field },
    style: styleFor(config, front.bundle, ctx?.url),
    vocabulary: config.openai.keywords,
    commands: commandsOn(),
  });
  try {
    let result = await edit(raw);
    const verdict = judge ? await judge : null;
    const jevNote = verdict ? `；Jev：是指令的機率 ${verdict.command.toFixed(2)}${verdict.named ? `，講到「${verdict.named.label}」` : ''}` : '';
    log(`AI 整理（${result.model}，${result.ms} ms，${result.mode}）：${result.mode === 'command' ? result.goal : result.text || '（無）'}${jevNote}`);
    if (result.mode === 'command' && verdict && !verdict.isCommand && !inField) {
      log('AI 說是指令、Jev 說不是：當成要打的字，貼原稿');
      return null;
    }
    if (result.mode !== 'command' && inField && verdict?.isCommand) {
      // Jev 看了畫面很確定是要操作：照「指令，……」再請 AI 拆一次目標和要搜尋的字
      const forced = await edit(`指令，${raw}`);
      if (forced.mode === 'command') {
        log(`游標在輸入框，但 Jev 確定是要操作畫面：當成指令（${forced.goal}）`);
        result = forced;
      }
    }
    return result;
  } catch (err) {
    log(`AI 整理失敗，改貼原稿：${err.message}`);
    lastError = { message: err.message, at: Date.now() };
    return null;
  }
}

const openApp = (name) => new Promise((resolve) => {
  execFile('/usr/bin/open', ['-a', name], { timeout: 5000 }, (err) => resolve(!err));
});

// 第三層（指令）：直接操作 app
async function runVoiceCommand(result, raw, front, ctx) {
  log(`指令：${result.goal}${result.text ? `（要填「${result.text}」）` : ''}${result.app ? `，先切到 ${result.app}` : ''}`);
  if (dryPaste) {
    emit({ type: 'command', goal: result.goal, text: result.text, app: result.app, dry: true });
    return '';
  }
  let outcome;
  try {
    outcome = await runCommand({
      ax, decider, log, frontApp, openApp, goal: result.goal, text: result.text, app: result.app, context: { app: ctx?.app ?? '' },
    });
  } catch (err) {
    outcome = { ok: false, reason: err.message, steps: [] };
  }
  log(outcome.ok ? `指令完成：${outcome.steps.join(' → ') || '畫面本來就是'}` : `指令沒完成：${outcome.reason}`);
  hudWrite(outcome.ok ? 'pasted' : 'nofield');
  writeLast(raw);
  emit({ type: 'command', goal: result.goal, ok: outcome.ok, steps: outcome.steps ?? [], reason: outcome.reason ?? '' });
  if (config.ai.history) {
    appendHistory({ app: ctx?.app ?? '', bundle: front.bundle, raw, mode: 'command', goal: result.goal, ok: outcome.ok, steps: outcome.steps ?? [] });
  }
  return '';
}

// 把游標前剛貼的那段換掉（換回原稿、或刪掉）
async function replaceLast(front, replacement, label) {
  if (!lastInserted || lastInserted.pid !== front.pid) {
    log(`${label}：這個 app 裡沒有剛寫進去的字`);
    return;
  }
  const r = await axCall('replace', { pid: front.pid, old: lastInserted.text, text: replacement });
  if (r?.result === 'ok') {
    log(`${label}：完成`);
    lastInserted = replacement ? { ...lastInserted, text: replacement, ai: false } : null;
    hudWrite('pasted');
    return;
  }
  writeLast(lastInserted.raw);
  hudWrite('nofield');
  log(`${label}：游標前面已經不是剛貼的字（${r?.result ?? '小幫手沒回'}），沒動；原稿放在「複製上一句」`);
}

function skipNoField(raw, role) {
  writeLast(raw);
  log('游標不在輸入框，這段沒寫：', raw, `（${role}）`);
  hudWrite('nofield');
  emit({ type: 'skipped', text: raw, reason: `not-text-field:${role}` });
  return '';
}

// 回傳 'retry' 表示現在寫不進去（沒權限、前景換了），放回佇列等一下
async function deliver(item, front) {
  if (item.kind === 'revert') {
    if (lastInserted?.ai) await replaceLast(front, withSpacing(lastInserted.raw), '換回原文');
    else log('換回原文：上一段沒有經過 AI 整理');
    return '';
  }
  const raw = item.kind === 'segment' ? item.raw : item.text;
  let ctx = await readContext(front);
  const inField = !ctx?.field.known || ctx.field.editable;
  // 不在輸入框、也沒開自動找或指令：不用送 AI
  if (!inField && !config.autoFocus && !commandsOn()) return skipNoField(raw, ctx.field.role);
  // 上次已經整理好、只是當時寫不進去：直接用，不再問一次 AI
  if (item.kind === 'segment' && !('result' in item)) item.result = await aiEdit(raw, front, ctx);
  const result = item.kind === 'segment' ? item.result : null;
  if (result?.mode === 'command') return runVoiceCommand(result, raw, front, ctx);
  if (result?.mode === 'delete_last') { await replaceLast(front, '', '刪掉剛剛那段'); return ''; }
  if (result?.mode === 'revert_last') {
    if (lastInserted?.ai) await replaceLast(front, withSpacing(lastInserted.raw), '換回原文');
    return '';
  }
  if (result?.mode === 'insert' && !result.text.trim()) {
    writeLast(raw);
    log('AI 整理後沒有要寫的字（只有贅字或雜音），不寫：', raw);
    return '';
  }
  if (!inField) {
    if (!config.autoFocus || !(await focusBestField(front.pid, result ? result.text : raw, ctx))) return skipNoField(raw, ctx.field.role);
    ctx = await readContext(front);
  }
  const text = withSpacing(result ? result.text : raw);
  writeLast(result ? result.text : raw);
  if (dryPaste) {
    emit({ type: 'pasted', text, raw, mode: result?.mode ?? 'insert', dry: true });
    return '';
  }
  const pasted = await axCall('paste', { pid: front.pid, text, ask: !askedAccessibility }, 6000);
  if (pasted?.result === 'no-accessibility') {
    if (!askedAccessibility) log('貼不進去：「全語音輸入」還沒有輔助使用權限，開了就會補貼：', text);
    askedAccessibility = true;
    setError('沒有「輔助使用」權限，字貼不進去：系統設定 → 隱私權與安全性 → 輔助使用，打開「全語音輸入」');
    return 'retry';
  }
  if (pasted?.result === 'not-front') {
    if (!item.notFront) log('要寫的時候最前面換了 app，等它回到最前面再寫');
    item.notFront = true;
    return 'retry';
  }
  if (pasted?.result?.startsWith('not-text-field')) {
    log('游標不在輸入框，這段沒寫：', text, `（${pasted.result.slice(15)}）`);
    hudWrite('nofield');
    emit({ type: 'skipped', text, reason: pasted.result });
    return '';
  }
  if (pasted?.result !== 'ok') {
    log('貼上沒成功：', pasted?.result ?? '（小幫手沒回應）');
    return '';
  }
  hudWrite('pasted');
  log(`已貼上：${text}`);
  emit({ type: 'pasted', text, raw, mode: result?.mode ?? 'insert' });
  lastInserted = { pid: front.pid, text, raw, ai: !!result && result.text !== raw };
  if (ctx?.field.editable) rememberedTargets.set(`${front.pid}:${ctx.window}`, { role: ctx.field.role, label: ctx.field.label });
  if (config.ai.history) {
    appendHistory({
      app: ctx?.app ?? '', bundle: front.bundle, raw, text: result ? result.text : raw, mode: result?.mode ?? 'insert',
      ai: result ? `${config.ai.provider}/${result.model}` : '', ms: result?.ms ?? 0,
    });
  }
  // AI 整理後貼的，盯一下使用者有沒有自己改專有名詞
  if (result?.mode === 'insert' && pasted.handle && ctx?.field && !ctx.field.selected) {
    learner.watch({ handle: pasted.handle, inserted: text, before: ctx.field.before ?? '', after: ctx.field.after ?? '' });
  }
  return '';
}

async function drainOutput() {
  if (outputBusy) return;
  outputBusy = true;
  try {
    while (outputQueue.length) {
      const item = outputQueue[0];
      if (Date.now() - item.at > HOLD_MS) {
        outputQueue.shift();
        log('一分鐘內都寫不進去（前景是不收音的 app，或沒有輔助使用權限），丟掉一段：', item.text ?? item.raw ?? '');
        continue;
      }
      const front = always ? { bundle: '', pid: 0 } : await frontApp();
      if (!always && !allowed(front.bundle)) break;
      outputQueue.shift();
      let outcome = '';
      try {
        outcome = await deliver(item, front);
      } catch (err) {
        log(`寫入出錯：${err?.stack || err}`);
      }
      if (outcome === 'retry') { outputQueue.unshift(item); break; }
    }
  } finally {
    outputBusy = false;
  }
}

// ---- 主迴圈 ----

function shutdown(code) {
  if (stopping) return;
  stopping = true;
  stopCapture();
  engine?.close();
  ax.close();
  releaseLock();
  setState('off');
  process.stdout.write('', () => process.exit(code));
}

async function tick() {
  if (stopping) return;
  reloadConfigIfChanged();
  const paused = existsSync(PAUSED);
  if (appMode && process.ppid !== parentPid) { shutdown(0); return; } // 選單列小程式不在了
  const front = always ? { bundle: 'test', pid: 0 } : await frontApp();
  const active = !paused && (always || allowed(front.bundle));
  frontActive = active;

  if (reopenCapture && ffmpeg && !inputFile) { reopenCapture = false; stopCapture(); }
  if (active && !ffmpeg && !inputFile && Date.now() >= captureRetryAt) startCapture();
  if (!active && ffmpeg && !inputFile) stopCapture();
  if (!active && segment) segmentForce = true; // 暫停或切到不收音的 app：講到一半的那段先整理

  if (existsSync(REVERT)) {
    try { unlinkSync(REVERT); } catch { /* 已經處理 */ }
    enqueueOutput({ kind: 'revert' });
  }

  stageAudio();
  engine.flush();
  engine.housekeeping({ active, quietForMs: Date.now() - lastSpeechAt, speaking: detector.speaking });
  void drainOutput();
  void learner.tick();

  if (paused) setState('paused');
  else if (!active) setState('standby');
  else if (lastError && Date.now() - lastError.at < 15_000) setState('error', lastError.message);
  else if (ffmpeg) setState('listening');
}

async function main() {
  if (!takeLock()) {
    emit({ type: 'state', state: 'already-running' });
    process.exit(3);
  }
  if (appMode) {
    try { if (statSync(LOG).size > 1_000_000) writeFileSync(LOG, ''); } catch { /* 還沒有 log */ }
    // 沒權限就在啟動時跳系統詢問，「全語音輸入」才會出現在輔助使用清單裡
    const access = await axCall('check', { ask: true });
    if (!access?.trusted) askedAccessibility = true;
    log(`輔助使用權限：${access?.trusted ? '有' : '沒有（字貼不進去：系統設定 → 隱私權與安全性 → 輔助使用，打開「全語音輸入」）'}`);
  }
  process.on('SIGTERM', () => shutdown(0));
  process.on('SIGINT', () => shutdown(0));
  process.on('exit', releaseLock);
  setState('standby');
  startEngine();
  setInterval(checkSegment, SEGMENT_CHECK_MS);

  if (inputFile) {
    startCapture();
    setState('listening');
    const timer = setInterval(() => { stageAudio(); engine.flush(); }, 250);
    await captureEnded;
    finishTurn();
    // 等所有句子轉完、整理完、貼完
    const until = Date.now() + 30_000;
    while (Date.now() < until && (engine.busy() || segment || outputQueue.length || outputBusy)) {
      engine.flush();
      if (!engine.busy()) segmentForce = true;
      await new Promise((r) => setTimeout(r, 200));
    }
    clearInterval(timer);
    shutdown(0);
    return;
  }

  for (;;) {
    await tick();
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

main().catch((err) => {
  log(err?.stack || String(err));
  setError(err?.message || String(err));
  releaseLock();
  process.exit(1);
});
