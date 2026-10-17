// 跟常駐的 AX 小幫手（bin/ax-agent.js）講話：開一個 osascript 留著，一問一答。
// 小幫手掛了或卡住就重開；用一陣子也重開一次（JXA 長時間跑會一直吃記憶體）。

import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const RECYCLE_AFTER = 400;

export function createAx({ log = () => {}, script = join(HERE, 'ax-agent.js') } = {}) {
  let child = null;
  let buffer = '';
  let nextId = 1;
  let served = 0;
  const pending = new Map(); // id → { resolve, reject, timer }

  function failAll(message) {
    for (const [id, p] of pending) {
      clearTimeout(p.timer);
      p.reject(new Error(message));
      pending.delete(id);
    }
  }

  function start() {
    const proc = spawn('/usr/bin/osascript', ['-l', 'JavaScript', script], { stdio: ['pipe', 'pipe', 'pipe'] });
    child = proc;
    buffer = '';
    served = 0;
    let errText = '';
    proc.stderr.on('data', (d) => { errText = (errText + d.toString()).slice(-400); });
    proc.stdout.on('data', (data) => {
      buffer += data.toString();
      let newline = buffer.indexOf('\n');
      while (newline >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf('\n');
        let message;
        try { message = JSON.parse(line); } catch { continue; }
        const p = pending.get(message.id);
        if (!p) continue;
        pending.delete(message.id);
        clearTimeout(p.timer);
        if (message.error) p.reject(new Error(message.error));
        else p.resolve(message);
      }
    });
    proc.on('close', (code) => {
      if (child === proc) child = null;
      if (pending.size) failAll(`AX 小幫手結束了（${code}）${errText.trim() ? `：${errText.trim().split('\n').at(-1)}` : ''}`);
    });
    proc.on('error', (err) => {
      if (child === proc) child = null;
      failAll(`AX 小幫手開不起來：${err.message}`);
    });
  }

  function stop() {
    const proc = child;
    child = null;
    try { proc?.stdin.end(); proc?.kill('SIGKILL'); } catch { /* 已經結束 */ }
  }

  function call(op, args = {}, timeoutMs = 4000) {
    if (!child) start();
    // 沒有在等的請求時才換新的，免得換到一半
    if (served >= RECYCLE_AFTER && !pending.size) { stop(); start(); }
    served += 1;
    const id = nextId;
    nextId += 1;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        log(`AX 小幫手 ${op} 超過 ${timeoutMs} ms 沒回，重開`);
        stop();
        reject(new Error(`AX 小幫手 ${op} 逾時`));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      child.stdin.write(`${JSON.stringify({ id, op, ...args })}\n`);
    });
  }

  return { call, close: stop };
}
