// 常駐聽寫程式（bin/listen.mjs）的狀態：starting 剛起；listening 收音中；standby Claude 不在最前面；
// paused 使用者暫停；error 出錯（message 寫原因）；off 沒在跑。
export type ListenerState = 'starting' | 'listening' | 'standby' | 'paused' | 'error' | 'off'

// local 本機 SenseVoice、openai 自己的 OpenAI key、parallelsandbox 平行沙盒；空字串＝還不知道
export type ListenerEngine = 'local' | 'openai' | 'parallelsandbox' | ''

export type ListenerView = {
  state: ListenerState
  message: string
  engine: ListenerEngine
}

declare module 'claude-code' {
  interface PluginState {
    'voice-dictation': { view: ListenerView }
  }
}
