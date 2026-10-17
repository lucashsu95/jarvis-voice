import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { describe, parseStatus } from '../hooks/text'

// 常駐程式（bin/listen.mjs）、檔案與 ps 都換成假的：只看 mod 會不會在沒人跑時起它、
// 有人跑時不重起，以及輸入框上方那一行的狀態與暫停。

const HOME = '/Users/tester'
const DIR = `${HOME}/.claude/voice-dictation`

const BAND = {
  plugin: 'voice-dictation',
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 6,
    bodyColumns: 80,
    scroll: { offset: 0, bodyRows: 6 },
    view: {},
  },
} as const

type World = { files: Map<string, string>; spawned: string[][]; listenerPid: string | null }

function fakeWorld(on: On, files: Record<string, string>, listenerPid: string | null): World {
  const world: World = { files: new Map(Object.entries(files)), spawned: [], listenerPid }
  mock.env(on, { HOME, PATH: '/usr/bin:/bin' })
  mock.clock(on)
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('fs.read', ($, e) => {
    const text = world.files.get(e.path)
    return text === undefined ? { deny: `ENOENT: ${e.path}` } : { value: text }
  })
  on('fs.write', ($, e) => {
    world.files.set(e.path, e.text)
    return { value: undefined }
  })
  on('process.run', ($, e) => {
    const [cmd, ...args] = e.argv
    if (cmd === '/bin/rm') {
      world.files.delete(args.at(-1) ?? '')
      return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    const alive = cmd === '/bin/ps' && args[1] === world.listenerPid
    return {
      value: {
        exitCode: alive ? 0 : 1,
        stdout: alive ? '/usr/local/bin/node /mods/voice-dictation/bin/listen.mjs\n' : '',
        stderr: '',
        isStdoutTruncated: false,
        isStderrTruncated: false,
      },
    }
  })
  on('process.spawn', async function* ($, e) {
    world.spawned.push([...e.argv])
    yield { stream: 'stdout' as const, text: '{"type":"state","state":"standby","message":""}\n' }
    return { value: { code: 0, signal: null } }
  })
  return world
}

const SESSION = { cwd: '/tmp', surface: 'desktop', isInteractive: true } as const

test('狀態檔讀得懂就照寫，讀不懂當成啟動中', () => {
  expect(parseStatus('{"state":"listening","message":"","engine":"local"}')).toEqual({ state: 'listening', message: '', engine: 'local' })
  expect(parseStatus('{"state":"error","message":"麥克風開不起來"}')).toEqual({ state: 'error', message: '麥克風開不起來', engine: '' })
  expect(parseStatus('壞掉')).toEqual({ state: 'starting', message: '', engine: '' })
  expect(describe({ state: 'error', message: '麥克風開不起來', engine: '' }).label).toBe('語音自動輸入：麥克風開不起來')
  expect(describe({ state: 'listening', message: '', engine: 'local' }).label).toBe('語音自動輸入（本機）：聽著，講完一句就貼進游標所在的輸入框')
  expect(describe({ state: 'paused', message: '', engine: 'openai' }).label).toBe('語音自動輸入（OpenAI）：已暫停')
})

test('沒有常駐程式在跑：session 一開就把它起起來', async ($, on) => {
  const world = fakeWorld(on, {}, null)
  await $.session.start(SESSION)
  expect(world.spawned).toHaveLength(1)
  expect(world.spawned[0]?.at(-1)).toMatch(/\/bin\/listen\.mjs$/)
})

test('別的 session 的常駐程式還在：不再起第二個', async ($, on) => {
  const world = fakeWorld(on, { [`${DIR}/listener.lock`]: '4321', [`${DIR}/status.json`]: '{"state":"listening","message":"","engine":"local"}' }, '4321')
  await $.session.start(SESSION)
  expect(world.spawned).toHaveLength(0)
})

test('輸入框上方顯示狀態，可以暫停再繼續', async ($, on) => {
  const world = fakeWorld(on, { [`${DIR}/listener.lock`]: '4321', [`${DIR}/status.json`]: '{"state":"listening","message":"","engine":"local"}' }, '4321')
  await $.session.start(SESSION)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect(await ui.find({ type: 'Text', text: /（本機）：聽著，講完一句就貼進/ })).toBeDefined()
    expect((await ui.find({ key: 'toggle' }))?.text).toBe('暫停')

    await ui.press({ key: 'toggle' })
    expect(world.files.has(`${DIR}/paused`)).toBe(true)
    expect(await ui.find({ type: 'Text', text: /已暫停/ })).toBeDefined()
    expect((await ui.find({ key: 'toggle' }))?.text).toBe('繼續')

    await ui.press({ key: 'toggle' })
    expect(world.files.has(`${DIR}/paused`)).toBe(false)
    expect((await ui.find({ key: 'toggle' }))?.text).toBe('暫停')
    await ui.unmount()
  }
})
