#!/usr/bin/env node
// 語音自動輸入的常駐程式：指定的 app（預設 Claude 桌面版）在最前面時自動收音，講完一句（停頓約 0.85 秒）
// 就把定稿貼進目前游標所在的輸入框——你在哪個 session，字就進哪個 session；只貼不送出。
// 不在最前面或暫停時關麥克風。整台電腦同時只跑一個（鎖檔），由各 session 的 mod 輪流確保有人在跑。
//
// 轉寫引擎看設定檔（bin/config.mjs）：local 本機 SenseVoice、openai 自己的 key（預設 gpt-transcribe 一般轉寫，
// 也可以選 gpt-live-transcribe 即時）、parallelsandbox。
// 設定檔改了會自動換引擎。狀態寫在 status.json 給狀態列讀；有 paused 檔就暫停。
// stdout 每行一個 JSON（state、pasted）。
// 測試選項：--file <音檔> 用音檔代替麥克風、讀完收尾結束；--dry-paste 只印不貼；--always 不看前景 app；--hud 測試時也顯示標籤。

import { execFile, spawn } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AudioTurnDetector, BATCH_BYTES, SAMPLE_RATE, findFfmpeg } from './common.mjs';
import { STATE_DIR, configMtime, isLiveModel, loadConfig } from './config.mjs';
import { createBatchEngine } from './engines/batch.mjs';
import { createLocalEngine } from './engines/local.mjs';
import { createRealtimeEngine, openaiConnector, parallelSandboxConnector } from './engines/realtime.mjs';
import { finishText, isSpeech, withSpacing } from './text.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const LOCK = join(STATE_DIR, 'listener.lock');
const PAUSED = join(STATE_DIR, 'paused');
const STATUS = join(STATE_DIR, 'status.json');
const POLL_MS = 500;
const HOLD_MS = 60_000; // 定稿時目標 app 不在最前面，最多等一分鐘回來再貼

const argv = process.argv.slice(2);
const fileIndex = argv.indexOf('--file');
const inputFile = fileIndex >= 0 ? argv[fileIndex + 1] : null;
const dryPaste = argv.includes('--dry-paste');
const always = argv.includes('--always') || !!inputFile;

const emit = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);
const log = (...parts) => process.stderr.write(`[listen] ${parts.join(' ')}\n`);
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

// ---- 錄音標示（bin/hud.js：浮在目標 app 視窗標題列中間的小標籤）----

const showHud = !inputFile || argv.includes('--hud');
let stopping = false;
let hud = null;
let hudMode = '';
let hudTarget = 0;

function hudWrite(line) {
  if (!showHud) return;
  if (!hud) {
    hud = spawn('/usr/bin/osascript', ['-l', 'JavaScript', join(HERE, 'hud.js')], { stdio: ['pipe', 'ignore', 'ignore'] });
    hud.stdin.on('error', () => {});
    const self = hud;
    hud.on('exit', () => {
      if (hud !== self) return;
      hud = null;
      const again = hudMode;
      hudMode = '';
      hudTarget = 0;
      if (again && again !== 'hide' && !stopping) setTimeout(() => hudShow(again), 1000);
    });
    if (hudTarget) hud.stdin.write(`target:${hudTarget}\n`);
  }
  hud.stdin.write(`${line}\n`);
}

// 標籤要顯示的狀態：listening、hearing、error:<訊息>、hide
function hudShow(mode) {
  if (mode === hudMode) return;
  hudMode = mode;
  hudWrite(mode);
}

function hudFollow(pid) {
  if (!pid || pid === hudTarget) return;
  hudTarget = pid;
  if (hud) hud.stdin.write(`target:${pid}\n`);
}

// 貼上後閃一下「已貼上」
const hudFlash = () => { if (hudMode && hudMode !== 'hide') hudWrite('pasted'); };

// ---- 設定與引擎 ----

let { config, error: configError } = loadConfig();
let configStamp = configMtime();
let engine = null;

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
      if (isSpeech(text)) enqueuePaste(text);
    },
  };
  if (config.engine === 'local') engine = createLocalEngine({ ...config.local, ...callbacks });
  else if (config.engine === 'openai' && isLiveModel(config.openai.model)) engine = createRealtimeEngine({ connector: openaiConnector(config.openai), ...callbacks });
  else if (config.engine === 'openai') engine = createBatchEngine({ ...config.openai, ...callbacks });
  else engine = createRealtimeEngine({ connector: parallelSandboxConnector(config.parallelsandbox), ...callbacks });
  log(`轉寫引擎：${config.engine}${config.engine === 'openai' ? `（${config.openai.model}）` : ''}`);
  if (configError) setError(configError);
}

function reloadConfigIfChanged() {
  const stamp = configMtime();
  if (stamp === configStamp) return;
  configStamp = stamp;
  ({ config, error: configError } = loadConfig());
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
  emit({ type: 'state', state, message });
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

const targetApps = () => (process.env.VOICE_DICTATION_APPS ? process.env.VOICE_DICTATION_APPS.split(',') : config.apps);

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

function takeBatch(chunk) {
  const samples = new Int16Array(chunk.buffer, chunk.byteOffset, chunk.length / 2);
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
  if (detector.speaking !== wasSpeaking && state === 'listening') hudShow(detector.speaking ? 'hearing' : 'listening');
  if (turn) queueTurn();
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

// ---- 貼上 ----

const pasteQueue = [];
let pasting = false;
let askedAccessibility = false;

function enqueuePaste(text) {
  pasteQueue.push({ text, at: Date.now() });
  void drainPaste();
}

async function drainPaste() {
  if (pasting) return;
  pasting = true;
  try {
    while (pasteQueue.length) {
      const item = pasteQueue[0];
      if (Date.now() - item.at > HOLD_MS) {
        pasteQueue.shift();
        log('目標 app 一直不在最前面，丟掉一句：', item.text);
        continue;
      }
      if (!always && !targetApps().includes((await frontApp()).bundle)) break;
      pasteQueue.shift();
      const text = withSpacing(item.text);
      if (dryPaste) {
        emit({ type: 'pasted', text, dry: true });
        continue;
      }
      const args = ['-l', 'JavaScript', join(HERE, 'paste.js'), text];
      if (!askedAccessibility) args.push('--ask');
      const out = (await exec('/usr/bin/osascript', args, 5000)).trim();
      if (out === 'no-accessibility') {
        askedAccessibility = true;
        setError('沒有「輔助使用」權限，字貼不進去：系統設定 → 隱私權與安全性 → 輔助使用，打開 Claude Code');
        continue;
      }
      if (out !== 'ok') log('貼上沒成功：', out || '（osascript 沒有回應）');
      else hudFlash();
      emit({ type: 'pasted', text });
    }
  } finally {
    pasting = false;
  }
}

// ---- 主迴圈 ----

function shutdown(code) {
  if (stopping) return;
  stopping = true;
  stopCapture();
  engine?.close();
  releaseLock();
  setState('off');
  try { hud?.stdin.end(); hud?.kill(); } catch { /* 已經結束 */ }
  process.stdout.write('', () => process.exit(code));
}

async function tick() {
  if (stopping) return;
  reloadConfigIfChanged();
  const paused = existsSync(PAUSED);
  const front = always ? { bundle: targetApps()[0], pid: 0 } : await frontApp();
  const active = !paused && targetApps().includes(front.bundle);
  frontActive = active;
  if (active) hudFollow(front.pid);

  if (active && !ffmpeg && !inputFile && Date.now() >= captureRetryAt) startCapture();
  if (!active && ffmpeg && !inputFile) stopCapture();

  stageAudio();
  engine.flush();
  engine.housekeeping({ active, quietForMs: Date.now() - lastSpeechAt, speaking: detector.speaking });
  void drainPaste();

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
  process.on('SIGTERM', () => shutdown(0));
  process.on('SIGINT', () => shutdown(0));
  process.on('exit', releaseLock);
  setState('standby');
  startEngine();

  if (inputFile) {
    startCapture();
    setState('listening');
    const timer = setInterval(() => { stageAudio(); engine.flush(); }, 250);
    await captureEnded;
    finishTurn();
    // 等所有句子轉完、貼完
    const until = Date.now() + 30_000;
    while (Date.now() < until && (engine.busy() || pasteQueue.length || pasting)) {
      engine.flush();
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
