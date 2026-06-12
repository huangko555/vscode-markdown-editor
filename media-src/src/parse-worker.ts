// Web Worker:把 markdown 源解析成 hits(带源行号 + 内容签名)返回主线程。
// 构建时本文件的 bundle 会被拼接在 lute.min.js 之后(self.Lute 全局可用)。
// 之所以独立 worker:Lute 全文解析 3000+ 行要 ~550ms,放主线程会卡死光标/输入,移到这里后台跑。
// parseHits 直接从 source-map.ts 复用(同一套逻辑,避免两份实现漂移);source-map 顶层的 window
// 副作用都有 typeof window 守卫,worker 里安全。
import { parseHits } from './source-map'

;(self as any).onmessage = (e: MessageEvent) => {
  const source = e.data
  if (typeof source !== 'string') return
  let hits: any[] = []
  try {
    hits = parseHits(source)
  } catch {
    hits = []
  }
  ;(self as any).postMessage({ source, hits })
}
