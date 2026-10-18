// 測試共用：macOS 新開的視窗會不會跑到最前面不一定，要在前景的就用 AX 設成最前面，要在背景的就把原本的 app 叫回來，
// 等確定了再動作。
import { execFileSync } from 'node:child_process';

const lsappinfo = (...args) => execFileSync('/usr/bin/lsappinfo', args).toString();
const frontInfo = () => lsappinfo('info', '-only', 'bundleid', '-only', 'pid', lsappinfo('front').trim());
export const frontPid = () => Number(frontInfo().match(/"pid"=(\d+)/)?.[1] ?? 0);
export const startBundle = frontInfo().match(/"CFBundleIdentifier"="([^"]*)"/)?.[1];

export async function waitFront(check) {
  for (let i = 0; i < 30 && !check(frontPid()); i += 1) await new Promise((r) => setTimeout(r, 100));
  return check(frontPid());
}

export async function sendToBack(pid) {
  if (startBundle) execFileSync('/usr/bin/open', ['-b', startBundle]);
  return waitFront((p) => p !== pid);
}

export async function bringToFront(pid) {
  execFileSync('/usr/bin/osascript', ['-l', 'JavaScript', '-e', `ObjC.import('ApplicationServices');
    ObjC.bindFunction('AXUIElementCreateApplication', ['id', ['int']]);
    ObjC.bindFunction('AXUIElementSetAttributeValue', ['int', ['id', 'id', 'id']]);
    $.AXUIElementSetAttributeValue($.AXUIElementCreateApplication(${pid}), $('AXFrontmost'), $.NSNumber.numberWithBool(true));`]);
  return waitFront((p) => p === pid);
}

// 把原本在最前面的 app 叫回來
export function restoreFront() {
  if (startBundle) execFileSync('/usr/bin/open', ['-b', startBundle]);
}
