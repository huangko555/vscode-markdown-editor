// 方案 F:按内容查表对齐
//
// 行号注入要靠两个东西:
//   1) 源 = VS Code 文件 buffer 原文(由扩展端 postMessage 推过来,存到 window.__vscodeBuffer)
//      ——不能用 vditor.getValue(),它返回 vditor 内部"压缩源",会丢空 marker 行
//   2) Lute(已 patch,AST Node 带 Line 字段) 解析这个 buffer,得到一系列 Hit:
//      { tag, sourceLine, signature, isAnchor, hasContent }
//
// 配对:不再用纯顺序双指针(那种中间一处错位下游全错),改成 "顺序游标 + 按内容签名查表 + 锚点强制重锚"
//   - 每个 DOM 块独立从 hits 队列里按 signature 找匹配,找不到就标 unmatched,不污染后续
//   - heading / code / hr 等锚点块配对成功后强制把游标跳到那里,把"前面没消费的 hit"清零
//   - 错位最多在两个锚点之间局部出现,绝不蔓延全文
//
// 诊断:每次 attach 都会把 hits / blocks / unmatched / orphans / anchors 全量 dump 到磁盘,
//      新 corner case 出现一查 dump 立刻定位,不靠猜

declare const Lute: any
declare const vscode: any

export type Hit = {
  tag: string          // 'p' | 'h' | 'list' | 'li' | 'blockquote' | 'table' | 'tr' | 'code' | 'hr'
  sourceLine: number   // 1-based 行号(VS Code buffer 行号)
  lineEnd: number
  signature: string    // 归一化后的首段文字签名,用于内容匹配
  isAnchor: boolean    // 是否结构强锚点(heading/code/hr),用于重锚
  hasContent: boolean  // 有没有可见文字(没有 vditor 可能不渲染对应 DOM)
}

// 独立 Lute 实例,避免动 vditor 的 lute renderer
let _lute: any = null
function getLute(): any | null {
  if (_lute) return _lute
  if (typeof Lute === 'undefined' || !Lute || !Lute.New) return null
  _lute = Lute.New()
  _lute.SetVditorIR(true)
  return _lute
}

// hits 缓存:源没变就不重 parse,大幅减少编辑期间的 Lute 解析开销
let _lastSource: string = ''
let _lastHits: Hit[] = []
// attach 整体短路:source + DOM 块数都没变就跳过整套对齐 + DOM 写入
let _lastAppliedSource: string = ''
let _lastAppliedBlockCount: number = -1

// ----------------------------------------------------------------------------
// 强 normalize:把任意一段文字归一化成签名,buffer 端跟 DOM 端都用同一套
// ----------------------------------------------------------------------------
export function normalizeSig(s: string): string {
  if (!s) return ''
  let r = s
  // 全角字符转半角(ASCII 范围内)
  r = r.replace(/[！-～]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
  // Smart punctuation → ASCII
  r = r.replace(/[“”]/g, '"').replace(/[‘’]/g, "'")
  r = r.replace(/[–—]/g, '-').replace(/…/g, '...')
  // 中文标点统一成英文等价
  r = r.replace(/[，]/g, ',').replace(/[。]/g, '.').replace(/[：]/g, ':')
  r = r.replace(/[；]/g, ';').replace(/[！]/g, '!').replace(/[？]/g, '?')
  r = r.replace(/[（]/g, '(').replace(/[）]/g, ')')
  r = r.replace(/[【\[]/g, '[').replace(/[】\]]/g, ']')
  // HTML entity 大致剥掉
  r = r.replace(/&[a-z]+;/gi, '')
  // 零宽字符 + 控制字符
  r = r.replace(/[​-‍﻿ ]/g, '')
  // markdown 标记
  r = r.replace(/[*_`~#>\\\-+]/g, '')
  // 数字+点列表 marker:只在"去掉后还有剩"时去,防止 "432" 这种纯数字内容被吃光
  const stripped = r.replace(/^\d+[.)]\s*/, '')
  if (stripped) r = stripped
  // 所有空白折叠掉
  r = r.replace(/\s+/g, '')
  r = r.toLowerCase()
  return r.slice(0, 50)
}

// ----------------------------------------------------------------------------
// 用 Lute 走一遍 source,收集 Hit 序列
// ----------------------------------------------------------------------------
export function parseHits(source: string): Hit[] {
  // 缓存命中:源没变直接复用上次结果
  if (source === _lastSource && _lastHits.length > 0) return _lastHits

  const lute = getLute()
  if (!lute) return []

  const hits: Hit[] = []
  const openStack: { hit: Hit; texts: string[] }[] = []

  function getLine(node: any): number {
    const io = node && node.__internal_object__
    return (io && typeof io.Line === 'number' && io.Line > 0) ? io.Line : 0
  }
  function getLineEnd(node: any): number {
    const io = node && node.__internal_object__
    return (io && typeof io.LineEnd === 'number' && io.LineEnd > 0) ? io.LineEnd : 0
  }

  function block(tag: string, isAnchor: boolean) {
    return (node: any, entering: boolean) => {
      if (entering) {
        const line = getLine(node)
        const lineEnd = getLineEnd(node) || line
        const hit: Hit = {
          tag,
          sourceLine: line,
          lineEnd: Math.max(line, lineEnd),
          signature: '',
          isAnchor,
          hasContent: false,
        }
        hits.push(hit)
        openStack.push({ hit, texts: [] })
      } else {
        const f = openStack.pop()
        if (f) {
          const joined = f.texts.join('')
          f.hit.signature = normalizeSig(joined)
          f.hit.hasContent = !!f.hit.signature
          // LineEnd 已在 entering 时从 node 拿过,这里不再覆盖
        }
      }
      return ['', Lute.WalkContinue]
    }
  }

  const leafCb = (node: any, entering: boolean) => {
    if (entering) {
      const text = (node.TokensStr && node.TokensStr()) || ''
      if (text) {
        for (const f of openStack) f.texts.push(text)
      }
    }
    return ['', Lute.WalkContinue]
  }

  // hr 是 leaf-block,单独处理
  const hrCb = (node: any, entering: boolean) => {
    if (entering) {
      const line = getLine(node)
      hits.push({
        tag: 'hr',
        sourceLine: line,
        lineEnd: line,
        signature: '___hr___',
        isAnchor: true,
        hasContent: true,
      })
    }
    return ['', Lute.WalkContinue]
  }

  const renderers: any = {
    renderParagraph:     block('p', false),
    renderHeading:       block('h', true),
    renderList:          block('list', false),
    renderListItem:      block('li', false),
    renderBlockquote:    block('blockquote', false),
    renderTable:         block('table', true),
    renderTableRow:      block('tr', false),
    renderCodeBlock:     block('code', true),
    renderThematicBreak: hrCb,
    renderText:          leafCb,
    renderCodeBlockCode: leafCb,
    renderCodeSpanContent: leafCb,  // inline code 内文字(否则 DOM 走 textContent 会拿到,两边 sig 错配)
    renderLinkText:      leafCb,
    renderHeadingC8hMarker: leafCb,
  }

  try {
    lute.SetJSRenderers({ renderers: { Md2VditorIRDOM: renderers } })
    lute.Md2VditorIRDOM(source)
  } catch (e) {
    return []
  }
  _lastSource = source
  _lastHits = hits
  return hits
}

// ----------------------------------------------------------------------------
// DOM 端:扁平拿块元素 + 算 signature
// ----------------------------------------------------------------------------
const BLOCK_TAGS = new Set([
  'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'blockquote', 'ul', 'ol', 'li',
  'table', 'tr', 'hr',
])

function isMarkerEl(el: Element): boolean {
  return !!(el.classList && el.classList.contains('vditor-ir__marker'))
}

function isEffectivelyEmpty(el: Element): boolean {
  // 含媒体元素的段落不算空,要给它打行号(图片/视频/iframe 等)
  if (el.querySelector('img, video, audio, iframe, svg, picture, source')) return false
  const raw = el.textContent || ''
  return raw.replace(/[\s​-‍﻿　]+/g, '') === ''
}

function isBlockEl(el: Element): { yes: boolean; isCodeBlock: boolean; isAnchor: boolean } {
  const tag = el.tagName.toLowerCase()
  if (tag === 'p' && isEffectivelyEmpty(el)) return { yes: false, isCodeBlock: false, isAnchor: false }
  if (BLOCK_TAGS.has(tag)) {
    const isAnchor = /^h[1-6]$/.test(tag) || tag === 'hr' || tag === 'table'
    return { yes: true, isCodeBlock: false, isAnchor }
  }
  if (tag === 'div' && (el.className || '').toString().indexOf('vditor-ir__node') >= 0) {
    if (el.getAttribute('data-type') === 'code-block') {
      return { yes: true, isCodeBlock: true, isAnchor: true }
    }
  }
  return { yes: false, isCodeBlock: false, isAnchor: false }
}

function innerCandidates(el: Element): Element[] {
  if (el.tagName.toLowerCase() === 'table') {
    const out: Element[] = []
    for (let i = 0; i < el.children.length; i++) {
      const c = el.children[i] as Element
      const ct = c.tagName.toLowerCase()
      if (ct === 'thead' || ct === 'tbody') {
        for (let j = 0; j < c.children.length; j++) out.push(c.children[j] as Element)
      } else {
        out.push(c)
      }
    }
    return out
  }
  return Array.from(el.children) as Element[]
}

type DomBlock = { el: Element; tag: string; sig: string; isAnchor: boolean }

// 签名缓存:大文档 attach 主线程大头是 getDomBlocks 给每个块算签名(walkText 遍历 + normalizeSig 正则)。
// 编辑只动少数块,其余块内容没变 → 用 textContent 指纹(长度 + 前 24 字符)判断未变就复用上次签名,
// 跳过 walkText+normalizeSig。WeakMap 随元素回收自动清理。
const _domSigCache = new WeakMap<Element, { key: string; sig: string }>()

function getDomBlocks(root: HTMLElement): DomBlock[] {
  const out: DomBlock[] = []
  function walkText(el: Element, buf: string[], stopAt: number) {
    if (buf.join('').length >= stopAt) return
    for (let i = 0; i < el.childNodes.length; i++) {
      const n = el.childNodes[i]
      if (buf.join('').length >= stopAt) return
      if (n.nodeType === Node.TEXT_NODE) {
        buf.push(n.textContent || '')
      } else if (n.nodeType === Node.ELEMENT_NODE) {
        const e = n as Element
        if (isMarkerEl(e)) continue
        walkText(e, buf, stopAt)
      }
    }
  }
  function walk(el: Element) {
    const r = isBlockEl(el)
    if (r.yes) {
      const tag = el.tagName.toLowerCase()
      const tagN = r.isCodeBlock ? 'div' : tag
      // 指纹:textContent 原生拼接(C++ 实现,远快于 JS walkText),内容不变则复用缓存签名
      const tc = el.textContent || ''
      const key = tc.length + '|' + tc.slice(0, 24)
      const cached = _domSigCache.get(el)
      let sig: string
      if (cached && cached.key === key) {
        sig = cached.sig
      } else {
        const buf: string[] = []
        walkText(el, buf, 80)
        sig = normalizeSig(buf.join(''))
        _domSigCache.set(el, { key, sig })
      }
      out.push({ el, tag: tagN, sig, isAnchor: r.isAnchor })
      if (r.isCodeBlock) return
    }
    if (el.tagName.toLowerCase() === 'pre') return
    for (const c of innerCandidates(el)) walk(c)
  }
  for (let i = 0; i < root.children.length; i++) {
    walk(root.children[i] as Element)
  }
  return out
}

// ----------------------------------------------------------------------------
// tag 相容性
// ----------------------------------------------------------------------------
function tagMatch(domTag: string, hitTag: string): boolean {
  if (domTag === hitTag) return true
  if (hitTag === 'list' && (domTag === 'ul' || domTag === 'ol')) return true
  if (hitTag === 'h' && /^h[1-6]$/.test(domTag)) return true
  if (hitTag === 'code' && domTag === 'div') return true
  return false
}

// ----------------------------------------------------------------------------
// 配对算法:按内容查表 + 顺序游标 + 锚点强制重锚
// ----------------------------------------------------------------------------
const LOOKAHEAD = 30  // 从游标往后看多少个 hit
const SIG_PREFIX = 6  // 签名前缀匹配最小长度

type AlignResult = {
  matched: { block: DomBlock; hit: Hit; how: 'exact' | 'prefix' | 'tag-fallback' }[]
  unmatched: DomBlock[]
  orphans: { i: number; hit: Hit }[]
  anchorResets: string[]
}

function align(hits: Hit[], blocks: DomBlock[]): AlignResult {
  const result: AlignResult = { matched: [], unmatched: [], orphans: [], anchorResets: [] }
  const consumed: boolean[] = new Array(hits.length).fill(false)
  let cursor = 0

  for (const block of blocks) {
    let found = -1
    let how: 'exact' | 'prefix' | 'tag-fallback' = 'exact'

    // Pass 1:精确签名 + tag 相容(两边都空也算精确,覆盖图片/iframe 等无文字 block)
    for (let k = cursor; k < Math.min(cursor + LOOKAHEAD, hits.length); k++) {
      if (consumed[k]) continue
      if (!tagMatch(block.tag, hits[k].tag)) continue
      if (block.sig === hits[k].signature) {
        found = k; how = 'exact'; break
      }
    }

    // Pass 2:前缀签名匹配
    if (found < 0 && block.sig.length >= SIG_PREFIX) {
      for (let k = cursor; k < Math.min(cursor + LOOKAHEAD, hits.length); k++) {
        if (consumed[k]) continue
        if (!tagMatch(block.tag, hits[k].tag)) continue
        const hsig = hits[k].signature
        if (hsig.length >= SIG_PREFIX) {
          if (block.sig.startsWith(hsig.slice(0, SIG_PREFIX)) || hsig.startsWith(block.sig.slice(0, SIG_PREFIX))) {
            found = k; how = 'prefix'; break
          }
        }
      }
    }

    // Pass 3:tag fallback(锚点节点签名差异大也允许 tag 匹配)
    if (found < 0 && block.isAnchor) {
      for (let k = cursor; k < Math.min(cursor + LOOKAHEAD, hits.length); k++) {
        if (consumed[k]) continue
        if (tagMatch(block.tag, hits[k].tag) && hits[k].isAnchor) {
          found = k; how = 'tag-fallback'; break
        }
      }
    }

    if (found >= 0) {
      consumed[found] = true
      result.matched.push({ block, hit: hits[found], how })
      // 锚点重锚:游标跳过前面所有 unconsumed 节点,这些算 orphan
      if (block.isAnchor && hits[found].isAnchor) {
        for (let k = cursor; k < found; k++) {
          if (!consumed[k]) {
            // 标记为 consumed 防止后续误配,但记录为 anchor-skipped
            consumed[k] = true
          }
        }
        cursor = found + 1
        result.anchorResets.push(`<${block.tag}> L${hits[found].sourceLine} sig="${block.sig.slice(0, 25)}"`)
      } else {
        if (found >= cursor) cursor = found + 1
      }
    } else {
      result.unmatched.push(block)
    }
  }

  // orphan hits = 没被消费的 hits
  hits.forEach((h, i) => {
    if (!consumed[i] && h.hasContent) result.orphans.push({ i, hit: h })
  })

  return result
}

// ----------------------------------------------------------------------------
// 主入口
// ----------------------------------------------------------------------------
// 只在值真的变化时写 setAttribute / removeAttribute,避免不必要的 DOM mutation 触发 MutationObserver 回环
function setAttrIfChanged(el: Element, name: string, value: string | null) {
  const cur = el.getAttribute(name)
  if (value === null) {
    if (cur !== null) el.removeAttribute(name)
  } else if (cur !== value) {
    el.setAttribute(name, value)
  }
}

// ============================================================================
// Web Worker:把 550ms 的 Lute 全文解析移出主线程(实测 parse 占 attach 总耗时 95%+)。
// lute 不依赖 DOM(grep document/window 零命中),可在 worker 跑;用 blob worker(同源)避开
// vscode webview 跨源 worker 限制。worker 文件 = lute.min.js + parse-worker 逻辑,构建时拼接。
// 流程:buffer 变 → requestParse 发 worker(异步)→ 主线程先用上一版 hits 对齐 → worker 回传新
// hits → 触发重 attach 精确对齐。主线程永不 parse,只 align+apply(~40ms),停下来几乎无感。
// ============================================================================
let _worker: Worker | null = null
let _workerInitTried = false
let _workerHits: Hit[] = []
let _workerHitsSource = ''
let _inflightSource: string | null = null   // 正在 worker 解析的 source
let _pendingSource: string | null = null    // worker 忙时排队的最新 source
let _workerFailed = false                    // worker 不可用(fetch 被 CSP 拦 / 创建失败)→ 降级主线程解析

function ensureWorker() {
  if (_worker || _workerInitTried) return
  _workerInitTried = true
  try {
    const luteScript = document.getElementById('vditorLuteScript') as HTMLScriptElement | null
    if (!luteScript || !luteScript.src) { _workerFailed = true; return }
    const workerUrl = luteScript.src.replace(/lute\.min\.js(\?[^]*)?$/, 'parse-worker.js')
    // fetch worker 脚本文本 → blob URL → new Worker:blob worker 继承文档源(同源),
    // 内含 lute,无需 importScripts 跨源资源,绕开 webview CSP / 跨源 worker 限制
    fetch(workerUrl).then(r => r.text()).then(code => {
      const blob = new Blob([code], { type: 'application/javascript' })
      const w = new Worker(URL.createObjectURL(blob))
      w.onmessage = (e: MessageEvent) => {
        const d = e.data || {}
        _workerHits = d.hits || []
        _workerHitsSource = d.source || ''
        _inflightSource = null
        // 解析期间又有新 source 排队 → 继续发
        if (_pendingSource != null && _pendingSource !== _workerHitsSource) {
          _inflightSource = _pendingSource
          _pendingSource = null
          w.postMessage(_inflightSource)
        }
        // 用新 hits 触发一次重对齐
        try { (window as any).__attachLineNumbers && (window as any).__attachLineNumbers() } catch {}
      }
      _worker = w
      if (_pendingSource != null) {
        _inflightSource = _pendingSource
        _pendingSource = null
        w.postMessage(_inflightSource)
      }
    }).catch(() => {
      _workerFailed = true
      try { (window as any).__attachLineNumbers && (window as any).__attachLineNumbers() } catch {}
    })
  } catch { _workerFailed = true }
}

function requestParse(source: string) {
  if (source === _workerHitsSource) return   // 已是最新结果
  if (source === _inflightSource) return     // 正在解析同一个
  ensureWorker()
  if (!_worker || _inflightSource != null) { _pendingSource = source; return }  // 没就绪 / 忙 → 排队
  _inflightSource = source
  _worker.postMessage(source)
}

export function injectSourceLines(root: HTMLElement, _ignoredSource: string) {
  // 用 VS Code buffer 作为权威源,buffer 未到就退回到 vditor.getValue()(初始那一瞬间用)
  const buffer = (window as any).__vscodeBuffer
  const source = (typeof buffer === 'string' && buffer.length > 0)
    ? buffer
    : ((window as any).vditor && (window as any).vditor.getValue ? (window as any).vditor.getValue() : '')

  if (!source) return

  // worker 可用:异步请求解析,先用缓存 hits 对齐(回传后重对齐);worker 不可用:降级主线程同步 parse(会卡但保功能)
  let hits: Hit[]
  let hitsSource: string
  if (_workerFailed) {
    hits = parseHits(source)
    hitsSource = source
  } else {
    requestParse(source)
    hits = _workerHits
    hitsSource = _workerHitsSource
  }
  if (hits.length === 0) return   // worker 首次还没返回,行号稍后(~550ms)出现

  // 快速短路:hits 没更新 + DOM 块数没变 → 跳过整套对齐
  if (hitsSource === _lastAppliedSource) {
    const liveCount = root.querySelectorAll('[data-source-line]').length
    if (liveCount === _lastAppliedBlockCount) return
  }

  const blocks = getDomBlocks(root)
  const result = align(hits, blocks)

  // 收集 matched DOM,差集中其余 [data-source-line] 元素清掉属性
  const matchedSet = new Set<Element>()
  for (const m of result.matched) {
    if (m.hit.sourceLine > 0) {
      matchedSet.add(m.block.el)
      setAttrIfChanged(m.block.el, 'data-source-line', String(m.hit.sourceLine))
      if (m.hit.tag === 'p' && m.hit.lineEnd > m.hit.sourceLine) {
        setAttrIfChanged(m.block.el, 'data-source-line-end', String(m.hit.lineEnd))
      } else {
        setAttrIfChanged(m.block.el, 'data-source-line-end', null)
      }
    }
  }
  // 清掉本次没匹配上的旧 attribute(避免上次 attach 残留)
  root.querySelectorAll('[data-source-line]').forEach((el) => {
    if (!matchedSet.has(el)) {
      setAttrIfChanged(el, 'data-source-line', null)
      setAttrIfChanged(el, 'data-source-line-end', null)
    }
  })

  // 记录用 hits(对应 hitsSource)对齐后的状态,下次短路用
  _lastAppliedSource = hitsSource
  _lastAppliedBlockCount = matchedSet.size

  // 保存到 window 供 dump 用
  ;(window as any).__lastAlignResult = { hits, blocks, result, source: hitsSource }
}

// ----------------------------------------------------------------------------
// 自动 dump 诊断数据给扩展端,扩展端写到磁盘文件供 Claude 直接读
// 注:本文件会被 parse-worker bundle 进 worker(为复用 parseHits),worker 无 window;
// 用 globalThis(worker 里 = self,主线程 = window)挂这些调试入口,worker 加载时不报错
// ----------------------------------------------------------------------------
;(globalThis as any).__debugSourceMapDump = function () {
  try {
    const r = (window as any).__lastAlignResult
    if (!r) return
    const { hits, blocks, result, source } = r
    const dump = {
      timestamp: new Date().toISOString(),
      sourceLineCount: source.split('\n').length,
      source,
      hits: hits.map((h: Hit, i: number) => ({
        i, tag: h.tag, line: h.sourceLine, lineEnd: h.lineEnd,
        isAnchor: h.isAnchor, hasContent: h.hasContent,
        sig: h.signature,
      })),
      blocks: blocks.map((b: DomBlock, i: number) => ({
        i, tag: b.tag, isAnchor: b.isAnchor,
        dataSourceLine: b.el.getAttribute('data-source-line') || '',
        sig: b.sig,
        // 同时 dump outerHTML 摘要,看 vditor 实际怎么渲染的(只截前 400 字)
        html: (b.el as HTMLElement).outerHTML.slice(0, 400),
      })),
      matched: result.matched.map((m: any) => ({
        blockTag: m.block.tag,
        hitTag: m.hit.tag,
        line: m.hit.sourceLine,
        how: m.how,
        sig: m.block.sig.slice(0, 30),
      })),
      unmatched: result.unmatched.map((b: DomBlock) => ({
        tag: b.tag, isAnchor: b.isAnchor, sig: b.sig,
      })),
      orphans: result.orphans.map((o: any) => ({
        i: o.i, tag: o.hit.tag, line: o.hit.sourceLine, sig: o.hit.signature,
      })),
      anchorResets: result.anchorResets,
    }
    if (typeof vscode !== 'undefined' && vscode.postMessage) {
      vscode.postMessage({ command: 'debug-dump', content: JSON.stringify(dump, null, 2) })
    }
  } catch (e) {
    console.warn('debug dump failed', e)
  }
}

// 手动入口:在 webview devtools console 调 __debugSourceMap()
;(globalThis as any).__debugSourceMap = function () {
  const r = (window as any).__lastAlignResult
  if (!r) { console.log('no align result yet'); return }
  const { hits, blocks, result } = r
  console.log('matched:', result.matched.length, 'unmatched:', result.unmatched.length, 'orphans:', result.orphans.length)
  console.log('anchor resets:', result.anchorResets)
  console.log('unmatched blocks:', result.unmatched.map((b: DomBlock) => `<${b.tag}> "${b.sig.slice(0,30)}"`))
  console.log('orphan hits:', result.orphans.map((o: any) => `${o.hit.tag} L${o.hit.sourceLine} "${o.hit.signature.slice(0,30)}"`))
}
