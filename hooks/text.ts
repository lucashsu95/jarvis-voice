import type { ListenerEngine, ListenerState, ListenerView } from '../types'

const STATES: readonly ListenerState[] = ['starting', 'listening', 'standby', 'paused', 'error', 'off']
const ENGINES: readonly ListenerEngine[] = ['local', 'openai', 'parallelsandbox']
const ENGINE_NAMES: Record<ListenerEngine, string> = { local: '本機', openai: 'OpenAI', parallelsandbox: '平行沙盒', '': '' }

// status.json 是常駐程式寫的；讀不懂就當它還在起來。
export function parseStatus(raw: string): ListenerView {
  try {
    const value = JSON.parse(raw) as { state?: unknown; message?: unknown; engine?: unknown }
    const state = STATES.find(s => s === value.state) ?? 'starting'
    const engine = ENGINES.find(e => e === value.engine) ?? ''
    return { state, message: typeof value.message === 'string' ? value.message : '', engine }
  } catch {
    return { state: 'starting', message: '', engine: '' }
  }
}

// 輸入框上方那一行的字與點的顏色。
export function describe(view: ListenerView): { label: string; color: string } {
  const name = ENGINE_NAMES[view.engine]
  const title = name ? `語音自動輸入（${name}）` : '語音自動輸入'
  switch (view.state) {
    case 'listening':
      return { label: `${title}：聽著，講完一句就貼進游標所在的輸入框`, color: 'success' }
    case 'standby':
      return { label: `${title}：待命，Claude 在最前面時才收音`, color: 'subtle' }
    case 'paused':
      return { label: `${title}：已暫停`, color: 'subtle' }
    case 'error':
      return { label: `${title}：${view.message || '出錯了'}`, color: 'warning' }
    default:
      return { label: `${title}：啟動中`, color: 'subtle' }
  }
}
