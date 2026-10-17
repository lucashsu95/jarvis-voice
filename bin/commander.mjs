// Mac 小程式的語音指令：步驟、決策、安全限制在核心（core/commander.mjs），這裡用 AX 小幫手當畫面接頭。

import { runCommand as coreRunCommand } from '../core/commander.mjs';

export { messageBox } from '../core/commander.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// frontApp() 取最前面的 app（{ pid }）；openApp(name) 把 app 叫到前面
export async function runCommand({ ax, frontApp, openApp, ...rest }) {
  let front = await frontApp();
  const screen = {
    elements: (opts) => ax.call('elements', { pid: front.pid, ...opts }, 15000),
    act: (req) => ax.call('act', { pid: front.pid, ...req }),
  };
  const switchApp = async (name) => {
    if (!(await openApp(name))) return false;
    await sleep(700);
    front = await frontApp();
    return true;
  };
  return coreRunCommand({ ...rest, screen, switchApp });
}
