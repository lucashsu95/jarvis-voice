import { atom, read, update } from 'claude-code'
import type { ProcessSpawnChunk, Register } from 'claude-code'

import type { ListenerView } from '../types'
import { describe, parseStatus } from './text'

// 語音自動輸入：不用按。Claude 在最前面時自動收音，講完一句就貼進目前游標所在的輸入框
// （你在哪個 session，字就進哪個 session，新開的也一樣），只貼不送出。
// 收音、轉寫、貼上都在 bin/listen.mjs，整台電腦只跑一個；每個 session 的 mod 定時檢查，
// 沒人在跑就由自己起，起它的 session 結束時它跟著結束，別的 session 在下一輪接手。
// 輸入框上方一行顯示狀態，可暫停／繼續（暫停＝~/.claude/voice-dictation/paused 存在）。

const view = atom({ plugin: 'voice-dictation', key: 'view' } as const, { state: 'starting', message: '', engine: '' } as ListenerView)

const CHECK_EVERY_MS = 5000
const ENSURE_EVERY_TICKS = 4 // 每 20 秒看一次常駐程式還在不在

export const register: Register = on => {
  // 這個 session 起的常駐程式還在跑時為 true（hot reload 會連它一起結束）
  let owning = false
  let dir = ''

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    dir = `${(await $.env.get('HOME')) ?? ''}/.claude/voice-dictation`

    const isRunning = async (): Promise<boolean> => {
      const pid = (await $.fs.read(`${dir}/listener.lock`).catch(() => '')).toString().trim()
      if (!/^\d+$/.test(pid)) return false
      const ps = await $.process.run(['/bin/ps', '-p', pid, '-o', 'command=']).catch(() => null)
      return ps !== null && ps.exitCode === 0 && ps.stdout.includes('listen.mjs')
    }

    const ensure = async () => {
      if (owning || (await isRunning())) return
      owning = true
      const path = (await $.env.get('PATH')) ?? '/usr/bin:/bin'
      void (async () => {
        try {
          const child = $.process.spawn({
            argv: ['/usr/bin/env', 'node', `${$.plugin.root}/bin/listen.mjs`],
            env: { PATH: `${path}:/opt/homebrew/bin:/usr/local/bin` },
          })
          for await (const piece of child as AsyncIterable<ProcessSpawnChunk>) {
            if (piece.stream === 'stderr') $.ui.log(`voice-dictation: ${piece.text.trim()}`, { to: 'debug' })
          }
        } catch (error) {
          $.ui.log(`voice-dictation: 常駐程式開不起來：${error instanceof Error ? error.message : String(error)}`, { to: 'debug' })
        } finally {
          owning = false
        }
      })()
    }

    const refresh = async () => {
      const running = owning || (await isRunning())
      const raw = (await $.fs.read(`${dir}/status.json`).catch(() => '')).toString()
      const latest: ListenerView = running ? parseStatus(raw) : { state: 'starting', message: '', engine: '' }
      await update($, view, current =>
        current.state === latest.state && current.message === latest.message && current.engine === latest.engine
          ? current
          : latest,
      )
    }

    await ensure()
    await refresh()
    let ticks = 0
    $.clock.every(CHECK_EVERY_MS, () => {
      ticks += 1
      void (async () => {
        if (ticks % ENSURE_EVERY_TICKS === 0) await ensure()
        await refresh()
      })()
    })
    return started
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const current = await read($, view)
    const { label, color } = describe(current)
    const { Box, Text, Button } = $.ui.resolve(e)
    const isPaused = current.state === 'paused'

    const toggle = async () => {
      if (!dir) return
      if (isPaused) await $.process.run(['/bin/rm', '-f', `${dir}/paused`]).catch(() => null)
      else await $.fs.write(`${dir}/paused`, '')
      await update($, view, (): ListenerView => ({ state: isPaused ? 'listening' : 'paused', message: '', engine: current.engine }))
    }

    return (
      <Box gap={1}>
        <Text color={color}>●</Text>
        <Text dimColor wrap="truncate-end">
          {label}
        </Text>
        <Button key="toggle" label={isPaused ? '繼續' : '暫停'} onPress={toggle} />
      </Box>
    )
  })
}
