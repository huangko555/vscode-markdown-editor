import './preload'

import {
  fileToBase64,
  fixCut,
  fixDarkTheme,
  fixLinkClick,
  fixPanelHover,
  handleToolbarClick,
  fixOutlineCloseScroll,
  getVisibleEditorRoot,
  saveVditorOptions,
} from './utils'

import { merge } from 'lodash'
import Vditor from 'vditor'
import { format } from 'date-fns'
import 'vditor/dist/index.css'
import { t, lang } from './lang'
import { toolbar } from './toolbar'
import { fixTableIr } from './fix-table-ir'
import { injectSourceLines } from './source-map'
import './main.css'

// restore zebra toggle state (default ON;only explicit '0' keeps off)
try {
  if (localStorage.getItem('vditor-md.zebra') !== '0') {
    document.body.classList.add('zebra-on')
  }
} catch {
  document.body.classList.add('zebra-on')
}

// restore lineno toggle state (default OFF)
try {
  if (localStorage.getItem('vditor-md.lineno') === '1') {
    document.body.classList.add('lineno-on')
  }
} catch {}

// restore color swatch toggle state (default ON;only explicit '0' keeps off)
try {
  if (localStorage.getItem('vditor-md.swatch') !== '0') {
    document.body.classList.add('swatch-on')
  }
} catch {
  document.body.classList.add('swatch-on')
}


// 行号映射:用 vditor 内置 Lute parser 解析源 md(跟 IR DOM 同 parser,AST 1:1 对应 DOM),
// 把源行号注入到 data-source-line。再算每个元素的 --vmd-gutter-x,让 ::after 行号都落到同一 X 列。
// 注入逻辑全在 source-map.ts 里
function attachLineNumbers() {
  if (!(window as any).vditor) return
  // 注:cursor 模式(lineno-off)也需要 data-source-line 注入才能显示光标所在行号,所以这里不再 early return on lineno-off。
  // gutter overlay(per-line)只在 lineno-on 全开模式下才建,见下方 linenoOn 判断。
  const root = getVisibleEditorRoot()
  if (!root) return
  const linenoOn = document.body.classList.contains('lineno-on')

  // 清掉旧 gutter overlay(代码块/多行段落都是独立 div,需要每次重建;cursor 模式下不应残留)
  root.querySelectorAll('.vmd-code-gutter, .vmd-block-gutter').forEach(el => el.remove())

  // injectSourceLines 内部用 __vscodeBuffer 作权威源,第二参被忽略——绝不要传 vditor.getValue()
  // (大文档上它会序列化整个 DOM,每次 attach 调一次是几十~上百 ms 的纯浪费)
  injectSourceLines(root, '')

  // 视口剪裁参数(frustum culling):大文档每个元素都算 gutter 位置是大头开销,
  // 只处理当前视口(上下扩展 buffer)内的元素;视口外行号本来就看不见,滚动时 scroll 触发补算
  const vpBuffer = 1200
  const vpTop = -vpBuffer
  const vpBottom = (window.innerHeight || document.documentElement.clientHeight) + vpBuffer
  const inViewport = (el: Element) => {
    const r = el.getBoundingClientRect()
    return r.bottom >= vpTop && r.top <= vpBottom
  }

  if (linenoOn) {
    // 代码块 per-line gutter:Range 实测每源行 Y,贵。只对视口内代码块建
    root.querySelectorAll<HTMLElement>('pre.vditor-ir__preview').forEach(preview => {
      const node = preview.closest('[data-source-line]') as HTMLElement | null
      if (!node) return
      if (!inViewport(node)) return  // 视口外跳过
      const startLine = parseInt(node.getAttribute('data-source-line') || '0')
      if (!startLine) return
      const code = preview.querySelector('code') as HTMLElement | null
      if (code) buildCodeGutter(preview, code, startLine + 1)
    })

    // 多行段落 per-line gutter:Range 实测每行 wrap Y,更贵。只对视口内段落建
    root.querySelectorAll<HTMLElement>('[data-source-line-end]').forEach(p => {
      if (!inViewport(p)) return  // 视口外跳过
      const startLine = parseInt(p.getAttribute('data-source-line') || '0')
      const endLine = parseInt(p.getAttribute('data-source-line-end') || '0')
      if (endLine > startLine) buildParagraphGutter(p, startLine, endLine)
    })
  }

  // 算每个 [data-source-line] 元素的 --vmd-gutter-x / --vmd-gutter-y
  // x:::after 是 position:absolute,基准是 padding-box;blockquote 有 border-left,要扣掉
  // y:对齐到第一行视觉中心(padTop + lineHeight/2),wrap 时不再用元素整体中点(会落到行间空白)
  const rootRect = root.getBoundingClientRect()
  // 按元素引用缓存 visualTop:本帧内同元素多次问询直接命中,避免 Range.getBoundingClientRect 重复测算
  const visualTopCache = new WeakMap<HTMLElement, number | null>()
  // 找元素内第一个非空白字符的 Y 坐标(相对 el padding-box 顶部),让 ::after 准确落到真正可见内容上。
  // vditor 在某些 paragraph 开头会塞 \n 等空白制造视觉间距,直接用 lineHeight*0.45 会把行号定位到那个空行。
  function firstVisibleCharTop(el: HTMLElement): number | null {
    if (visualTopCache.has(el)) return visualTopCache.get(el) as number | null
    let result: number | null = null
    const elTop = el.getBoundingClientRect().top
    function walk(node: Node): boolean {
      if (result !== null) return true
      if (node.nodeType === Node.TEXT_NODE) {
        const text = node.textContent || ''
        for (let i = 0; i < text.length; i++) {
          const ch = text[i]
          if (ch === '\n' || ch === ' ' || ch === '\t' || ch === '\r') continue
          try {
            const r = document.createRange()
            r.setStart(node, i); r.setEnd(node, i + 1)
            const rect = r.getBoundingClientRect()
            if (rect.height > 0) { result = rect.top - elTop; return true }
          } catch {}
        }
      } else if (node.nodeType === Node.ELEMENT_NODE) {
        const e = node as Element
        // 跳过 marker(vditor-ir__marker)
        if (e.classList && e.classList.contains('vditor-ir__marker')) return false
        for (let i = 0; i < e.childNodes.length; i++) {
          if (walk(e.childNodes[i])) return true
        }
      }
      return false
    }
    walk(el)
    visualTopCache.set(el, result)
    return result
  }
  root.querySelectorAll<HTMLElement>('[data-source-line]').forEach(el => {
    const elRect = el.getBoundingClientRect()
    // 视口外(含 buffer)完全跳过:行号看不见,gutter-x/y 都不算,省掉 getComputedStyle + Range 的大头开销
    if (elRect.bottom < vpTop || elRect.top > vpBottom) return
    const cs = getComputedStyle(el)
    const borderLeft = parseFloat(cs.borderLeftWidth) || 0
    el.style.setProperty('--vmd-gutter-x', (-(elRect.left - rootRect.left) + 5 - borderLeft) + 'px')
    const elLh = parseFloat(cs.lineHeight)
    // 优先用首个可见字符的实测 Y(避开 leading \n 等空白);拿不到再退回 padTop+lineHeight*0.45
    const visualTop = firstVisibleCharTop(el)
    if (visualTop !== null && elLh && elLh > 0) {
      el.style.setProperty('--vmd-gutter-y', (visualTop + elLh * 0.45) + 'px')
    } else if (elLh && elLh > 0) {
      const padTop = parseFloat(cs.paddingTop) || 0
      el.style.setProperty('--vmd-gutter-y', (padTop + elLh * 0.45) + 'px')
    } else {
      el.style.removeProperty('--vmd-gutter-y')
    }
  })

  // #hex 颜色值前插色块预览(像 VS Code 原生)
  attachColorSwatches(root)

  // 顺便刷新 cursor 标记(初次加载、edit 后 DOM 变化时 cursor 所在元素可能改了)
  try {
    const fn = (window as any).__updateCursorMarker
    if (typeof fn === 'function') fn()
  } catch {}

  // 自动 dump 诊断数据给扩展端的功能默认关掉:大文档下 JSON.stringify(几百 KB) + postMessage 显著拖慢 attach
  // 需要诊断时在 webview console 手动调 window.__debugSourceMapDump()
}

function swatchInViewport(el: Element): boolean {
  const vpBuf = 1200
  const r = el.getBoundingClientRect()
  return r.bottom >= -vpBuf && r.top <= (window.innerHeight || document.documentElement.clientHeight) + vpBuf
}

// #hex 颜色值前插色块预览(像 VS Code 原生)。全量扫描:覆盖代码块 / inline code / 正文。
// 色块是 contenteditable=false 的空 span(无文本),理论上不进 vditor.getValue() → 不污染源码。
// 跳过:隐藏 marker、代码块可编辑源(只处理 preview)、光标所在块(编辑中,避免干扰光标)、视口外块。
const SWATCH_COLOR_RE = /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3})\b/g
function attachColorSwatches(root: HTMLElement) {
  // 清除所有旧色块(无论开关状态都先清干净)
  root.querySelectorAll('.vmd-color-swatch').forEach(s => s.remove())
  // 开关关闭(more 菜单"颜色色块")→ 只清不建
  if (!document.body.classList.contains('swatch-on')) return
  // 光标所在顶层块(编辑中 → 跳过)
  const sel = window.getSelection()
  const anchor = sel && sel.rangeCount > 0 ? sel.getRangeAt(0).startContainer : null
  let cursorBlock: Element | null = null
  if (anchor) {
    let e: Element | null = (anchor.nodeType === Node.ELEMENT_NODE ? anchor : anchor.parentNode) as Element | null
    while (e && e !== root) {
      const he = e as HTMLElement
      if (he.hasAttribute && (he.hasAttribute('data-source-line') || e.classList.contains('vditor-ir__node'))) { cursorBlock = e; break }
      e = e.parentElement
    }
  }
  // 收集文本节点并拼成连续文本 + 记录每段在拼接文本里的起点。
  // 关键:hljs 会把无引号的 #1a1020 拆成 "#" 和 "1a1020" 两个 token(不同文本节点),
  // 按单节点匹配会漏。改成拼接全部文本节点再匹配,颜色跨节点也能找到;色块插在 "#" 所在节点。
  const vpCache = new Map<Element, boolean>()
  const blockInVp = (b: Element) => {
    if (vpCache.has(b)) return vpCache.get(b) as boolean
    const v = swatchInViewport(b); vpCache.set(b, v); return v
  }
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  const nodes: { node: Text; start: number; len: number }[] = []
  let full = ''
  let n: Node | null
  while ((n = walker.nextNode())) {
    const t = n as Text
    const txt = t.textContent || ''
    if (!txt) continue
    const parent = t.parentElement
    if (!parent) continue
    if (parent.closest('.vditor-ir__marker')) continue          // 隐藏标记
    if (parent.closest('.vditor-ir__marker--pre')) continue     // 代码块可编辑源(只处理 preview)
    if (cursorBlock && cursorBlock.contains(t)) continue        // 光标所在块,编辑中跳过
    const block = parent.closest('[data-source-line], pre.vditor-ir__preview') as Element | null
    if (block && !blockInVp(block)) continue                    // 视口外
    nodes.push({ node: t, start: full.length, len: txt.length })
    full += txt
  }
  if (full.indexOf('#') < 0) return
  const matches = Array.from(full.matchAll(SWATCH_COLOR_RE))
  // 从后往前插入,避免 splitText 影响前面 match 的偏移定位
  for (let i = matches.length - 1; i >= 0; i--) {
    const gIdx = matches[i].index || 0
    const color = matches[i][0]
    // 二分定位 gIdx(颜色起始 "#")落在哪个文本节点
    let lo = 0, hi = nodes.length - 1, ni = -1
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      const s = nodes[mid].start
      if (gIdx < s) hi = mid - 1
      else if (gIdx >= s + nodes[mid].len) lo = mid + 1
      else { ni = mid; break }
    }
    if (ni < 0) continue
    const tn = nodes[ni].node
    const local = gIdx - nodes[ni].start
    const after = local === 0 ? tn : tn.splitText(local)
    const sw = document.createElement('span')
    sw.className = 'vmd-color-swatch'
    sw.setAttribute('contenteditable', 'false')
    sw.style.background = color
    after.parentNode && after.parentNode.insertBefore(sw, after)
  }
}

function buildCodeGutter(preview: HTMLElement, code: HTMLElement, contentStartLine: number) {
  const text = code.textContent || ''
  let sourceLines = text.split('\n')
  if (sourceLines.length > 0 && sourceLines[sourceLines.length - 1] === '') sourceLines.pop()
  if (sourceLines.length === 0) return

  preview.style.position = 'relative'

  // 用 Range 实测每源行第一个字符的 Y(自动处理 wrap)
  const lineYs: number[] = []
  let charPos = 0
  for (let i = 0; i < sourceLines.length; i++) {
    const rect = getCharRect(code, charPos)
    if (rect) lineYs.push(rect.top)
    charPos += sourceLines[i].length + 1 // +1 for \n
  }
  if (lineYs.length === 0) return

  const previewRect = preview.getBoundingClientRect()
  const root = preview.closest('.vditor-reset') as HTMLElement | null
  if (!root) return
  const rootRect = root.getBoundingClientRect()

  const gutter = document.createElement('div')
  gutter.className = 'vmd-code-gutter'
  gutter.setAttribute('contenteditable', 'false')
  const offset = -(previewRect.left - rootRect.left) + 5
  gutter.style.setProperty('--vmd-gutter-x', offset + 'px')

  // baseline 微调:Range.getBoundingClientRect 返回 glyph top,数字 line-height:1 时
  // 视觉 baseline 比代码 baseline 略高几像素,补一个经验 shift 让数字落下来;0.3 比正中(0.5)略上偏
  const codeLh = parseFloat(getComputedStyle(code).lineHeight) || 14
  const codeFs = parseFloat(getComputedStyle(code).fontSize) || 14
  const yShift = Math.max(0, (codeLh - codeFs) * 0.1)

  let html = ''
  for (let i = 0; i < lineYs.length; i++) {
    const relY = lineYs[i] - previewRect.top + yShift
    html += `<div style="top:${relY}px">${contentStartLine + i}</div>`
  }
  gutter.innerHTML = html
  preview.appendChild(gutter)
}

// 多行段落 per-line gutter:用 textContent 里的 \n 字符定位每个源行起点,Range 单字符测 glyph rect
// 关键:wrap 不影响 — 源行 N 的起点字符是 textContent 中第 N-1 个 \n 之后,该字符所在 visual line
// 就是源行 N 的起始 visual line;wrap 产生的额外 visual line 不会被错占
// 同时跳过 vditor-ir__marker(隐藏的 markdown 标记 # > ** 等)和空白,找到第一个有可视 rect 的字符
function buildParagraphGutter(el: HTMLElement, startLine: number, endLine: number) {
  const numLines = endLine - startLine + 1

  // 扁平收集所有 text node(包括 marker 内的,因为 \n 计数要算它们的字符)
  // 关键:vditor IR 用 <br> 表示 hard break,textContent 里没有 \n。
  // 遇到 <br> 在 textNodes 流里塞一个虚拟 "\n" 文本节点占位,line 计数才能对
  const textNodes: (Text | { isSyntheticBr: true; textContent: '\n' })[] = []
  function collect(n: Node) {
    if (n.nodeType === Node.TEXT_NODE) {
      textNodes.push(n as Text)
    } else if (n.nodeType === Node.ELEMENT_NODE) {
      const e = n as Element
      if (e.tagName === 'BR') {
        textNodes.push({ isSyntheticBr: true, textContent: '\n' } as any)
      } else {
        for (let i = 0; i < e.childNodes.length; i++) collect(e.childNodes[i])
      }
    }
  }
  collect(el)

  // 计算每个 source line 起点的全局字符索引(textContent 里)
  const fullText = textNodes.map(t => t.textContent || '').join('')
  const lineStartIdx: number[] = [0]
  for (let i = 0; i < fullText.length; i++) {
    if (fullText[i] === '\n') lineStartIdx.push(i + 1)
  }

  // 从某个全局字符索引 fromIdx 起,找到第一个可视字符(非 marker、非空白、有 height)的 rect
  function findRectFrom(fromIdx: number): { top: number; height: number } | null {
    let count = 0
    for (const tn of textNodes as any[]) {
      const text = tn.textContent || ''
      const len = text.length
      if (count + len <= fromIdx) { count += len; continue }
      // 虚拟 BR 占位:不能 setRange,跳过它,从下一个真实 text node 继续
      if (tn.isSyntheticBr) {
        count += len
        if (fromIdx < count) fromIdx = count
        continue
      }
      const startOff = Math.max(0, fromIdx - count)
      // 跳过 marker span 内的 text node
      let p = (tn as Text).parentElement
      let inMarker = false
      while (p && p !== el) {
        if (p.classList && p.classList.contains('vditor-ir__marker')) { inMarker = true; break }
        p = p.parentElement
      }
      if (!inMarker) {
        for (let off = startOff; off < len; off++) {
          const ch = text[off]
          if (ch === '\n' || ch === ' ' || ch === '\t') continue
          const r = document.createRange()
          try { r.setStart(tn as Text, off); r.setEnd(tn as Text, off + 1) } catch { continue }
          const rect = r.getBoundingClientRect()
          if (rect.height > 0 && rect.width > 0) return { top: rect.top, height: rect.height }
        }
      }
      count += len
      fromIdx = count // 这个 tn 找不到,从下一个 tn 起整体扫
    }
    return null
  }

  const lineRects: ({ top: number; height: number } | null)[] = []
  for (let i = 0; i < numLines; i++) {
    const charIdx = i < lineStartIdx.length ? lineStartIdx[i] : lineStartIdx[lineStartIdx.length - 1]
    lineRects.push(findRectFrom(charIdx))
  }

  const firstRect = lineRects.find(r => r !== null)
  if (!firstRect) return

  const rootEl = el.closest('.vditor-reset') as HTMLElement | null
  if (!rootEl) return
  const rootRect = rootEl.getBoundingClientRect()
  const elRect = el.getBoundingClientRect()

  el.style.position = 'relative'
  const gutter = document.createElement('div')
  gutter.className = 'vmd-block-gutter'
  gutter.setAttribute('contenteditable', 'false')
  const cs = getComputedStyle(el)
  const borderLeft = parseFloat(cs.borderLeftWidth) || 0
  gutter.style.setProperty('--vmd-gutter-x', (-(elRect.left - rootRect.left) + 5 - borderLeft) + 'px')

  // 行号字号统一用 CSS 里的代码字号(.vmd-block-gutter 上设的 var(--vscode-editor-font-size))
  // 不再用 lr.height 当 font-size — 那样行号大小会跟父段落行高走、跟其它行号不一致
  // gutter 还没 appendChild,getComputedStyle 拿不到 class 样式,直接读 root 上的 CSS 变量
  const codeFs = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--vscode-editor-font-size')) || 14
  // 用父元素 line-height 做垂直居中(glyph rect 偏小、补出来的偏移不够);拿不到就退回到 glyph 高度
  let html = ''
  for (let i = 0; i < numLines; i++) {
    const lr = lineRects[i] || firstRect
    // 定位到该行几何中心(glyph top + 半 glyph 高),配合 CSS translateY(-50%) 居中,与 cursor 模式一致
    const y = lr.top - elRect.top + lr.height / 2
    html += `<div style="top:${y}px">${startLine + i}</div>`
  }
  gutter.innerHTML = html
  el.appendChild(gutter)
}

// 在 element 内,找第 charIndex 个字符(忽略 element 类型只看文本流)的 Range bounding rect
function getCharRect(el: HTMLElement, charIndex: number): DOMRect | null {
  let count = 0
  let found: { node: Text; offset: number } | null = null
  function walk(node: Node): boolean {
    if (found) return true
    if (node.nodeType === Node.TEXT_NODE) {
      const text = node.textContent || ''
      if (count + text.length > charIndex) {
        found = { node: node as Text, offset: charIndex - count }
        return true
      }
      count += text.length
    } else {
      for (let i = 0; i < node.childNodes.length; i++) {
        if (walk(node.childNodes[i])) return true
      }
    }
    return false
  }
  walk(el)
  if (!found) return null
  try {
    const range = document.createRange()
    const { node: txt, offset: off } = found as { node: Text; offset: number }
    range.setStart(txt, off)
    range.setEnd(txt, Math.min(off + 1, (txt.textContent || '').length))
    const r = range.getBoundingClientRect()
    if (r.height > 0) return r as DOMRect
  } catch {}
  return null
}

// 不再用 MutationObserver:vditor 在光标移动时也频繁改 DOM(IR 模式光标进出节点会展开/收起 markdown 标记),
// 监听 childList 会让"光标移动"也触发全量 attach,大文档下卡顿明显(实测光标延迟、回车后持续卡的元凶)。
// 改为纯事件驱动:input(内容变化)+ scroll(视口移动)+ 初次 after() 触发,vditor 自身的光标 DOM 操作不再打扰我们。
let attachTimer: any = null
// _typing:输入进行中标志。为真时冻结一切 attach / cursor 更新,主线程完全让给 vditor 渲染,
// 手感等同裸 vditor。输入停止 500ms 后(见 input())才解冻并补一次行号。
// 输入会引发 ResizeObserver(编辑区变高)/ scroll / worker 回传等多路 attach 触发,全靠这个标志一并挡掉。
let _typing = false
// 文档规模自适应:小文档 attach 只要几 ms,用即时响应(无感延迟);大文档(>1200 行)attach 重,
// 才用保守 debounce + 输入冻结防卡。initVditor 时按内容行数判定。
let _isLargeDoc = false
const LARGE_DOC_LINES = 1200
// scheduleAttach:小文档 30ms 后直接跑(行号几乎即时跟随);大文档 400ms trailing + idle(防卡)。
function scheduleAttach() {
  if (_typing) return
  if (attachTimer) clearTimeout(attachTimer)
  attachTimer = setTimeout(() => {
    attachTimer = null
    if (_isLargeDoc && typeof (window as any).requestIdleCallback === 'function') {
      ;(window as any).requestIdleCallback(() => attachLineNumbers(), { timeout: 600 })
    } else {
      attachLineNumbers()   // 小文档直接跑,几 ms,无需 idle 拖延
    }
  }, _isLargeDoc ? 400 : 30)
}
// 保留空壳,避免改其他调用点(observer 已移除)
function bindLineMo() {}
function detachLineMo() { if (attachTimer) { clearTimeout(attachTimer); attachTimer = null } }
;(window as any).__attachLineNumbers = scheduleAttach
;(window as any).__detachLineNumbers = detachLineMo
// 色块开关切换时即时重建/清除(不走 attach 的 debounce)
;(window as any).__refreshSwatches = () => {
  const root = getVisibleEditorRoot()
  if (root) attachColorSwatches(root)
}

// 光标模式:lineno-off 时只显示光标所在最近 [data-source-line] 祖先的行号。
// 监听 selectionchange,rAF 节流,给该元素加 .vmd-cursor-on(CSS 让它 ::after 显示)
let cursorRafId: number | null = null
let _curCursorEl: Element | null = null  // 缓存当前标记元素,避免每次 selectionchange 全文档 querySelectorAll
function updateCursorMarker() {
  cursorRafId = null
  // 光标移动后重建色块:让之前处于编辑态(光标在内)的块恢复渲染态时显示色块。两种模式都需要
  const ccRoot = getVisibleEditorRoot()
  if (ccRoot) attachColorSwatches(ccRoot)
  // 只移除上次标记的那一个元素,不全文档 querySelectorAll('.vmd-cursor-on')
  // (大文档输入时光标频繁变,每次全扫 5000 元素累积成可感卡顿)
  if (_curCursorEl) {
    _curCursorEl.classList.remove('vmd-cursor-on')
    _curCursorEl.removeAttribute('data-cursor-line')
    ;(_curCursorEl as HTMLElement).style.removeProperty('--vmd-cursor-y')
    _curCursorEl = null
  }
  if (document.body.classList.contains('lineno-on')) return // 全开模式不需要 cursor 标记
  const sel = window.getSelection()
  if (!sel || sel.rangeCount === 0) return
  const range = sel.getRangeAt(0)
  const start = range.startContainer
  let el: Element | null = start.nodeType === Node.ELEMENT_NODE
    ? (start as Element)
    : start.parentElement
  while (el && !(el as HTMLElement).hasAttribute?.('data-source-line')) {
    el = el.parentElement
  }
  if (!el) return
  el.classList.add('vmd-cursor-on')
  _curCursorEl = el
  // 多行(硬换行)段落:整段一个 [data-source-line],默认只显示起始行号。算光标在段落内第几行,
  // 显示光标行的源行号(data-cursor-line)并把行号定位到光标行的 Y(--vmd-cursor-y)
  const startLine = parseInt(el.getAttribute('data-source-line') || '0')
  const endLine = parseInt(el.getAttribute('data-source-line-end') || '0')
  if (endLine > startLine) {
    try {
      const pre = document.createRange()
      pre.setStart(el, 0)
      pre.setEnd(range.startContainer, range.startOffset)
      const lineOffset = (pre.toString().match(/\n/g) || []).length
      const cursorLine = Math.min(startLine + lineOffset, endLine)
      el.setAttribute('data-cursor-line', String(cursorLine))
      // 定位到光标行的几何中心(caret top + 半行高),配合 CSS translateY(-50%) 居中。
      // 与 lineno-on 的 buildParagraphGutter(glyph 中心)数学上重合 → 开/关行号位置一致。
      const caretRect = range.getBoundingClientRect()
      const elRect = el.getBoundingClientRect()
      const cy = caretRect.top - elRect.top + caretRect.height / 2
      ;(el as HTMLElement).style.setProperty('--vmd-cursor-y', cy + 'px')
    } catch {}
  }
}
document.addEventListener('selectionchange', () => {
  if (_typing) return  // 输入中不更新 cursor 标记(光标在动无意义),省掉每按键的 updateCursorMarker
  if (cursorRafId != null) return
  cursorRafId = requestAnimationFrame(updateCursorMarker)
})
;(window as any).__updateCursorMarker = updateCursorMarker

// 修复 vditor IR 点击代码块进入编辑态时光标被强制重置到开头:
// mousedown 时记下点击位置在代码块文本里的字符偏移,等 vditor expand 成编辑态后,把光标恢复到该偏移。
// container→offset 用 Range.toString().length 算;恢复用 TreeWalker 按偏移定位文本节点。
function caretOffsetOf(root: Node, container: Node, off: number): number {
  try {
    const r = document.createRange()
    r.selectNodeContents(root)
    r.setEnd(container, off)
    return r.toString().length
  } catch { return -1 }
}
function setCaretAtOffset(el: HTMLElement, offset: number): boolean {
  let count = 0
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
  let n: Node | null
  while ((n = walker.nextNode())) {
    const len = (n.textContent || '').length
    if (count + len >= offset) {
      const sel = window.getSelection()
      if (!sel) return false
      const range = document.createRange()
      range.setStart(n, Math.max(0, Math.min(len, offset - count)))
      range.collapse(true)
      sel.removeAllRanges()
      sel.addRange(range)
      return true
    }
    count += len
  }
  return false
}
document.addEventListener('mousedown', (e: MouseEvent) => {
  const target = e.target as Element | null
  const preview = target && target.closest ? target.closest('pre.vditor-ir__preview') as HTMLElement | null : null
  if (!preview) return
  const cr = (document as any).caretRangeFromPoint ? (document as any).caretRangeFromPoint(e.clientX, e.clientY) : null
  if (!cr) return
  const offset = caretOffsetOf(preview, cr.startContainer, cr.startOffset)
  if (offset < 0) return
  const codeBlock = preview.closest('[data-type="code-block"]') as HTMLElement | null
  if (!codeBlock) return
  // vditor 在 click/mouseup 后才 expand 并把光标设到开头(实测发生在我们第一帧之后),
  // 所以持续几帧都把光标设回点击位置 —— vditor 设开头后被后续帧覆盖,最后一帧我们赢。
  let tries = 0
  const restore = () => {
    const editCode = (codeBlock.querySelector('.vditor-ir__marker--pre code')
      || codeBlock.querySelector('pre code')) as HTMLElement | null
    if (editCode && editCode.offsetParent !== null) {
      setCaretAtOffset(editCode, offset)
    }
    if (tries++ < 8) requestAnimationFrame(restore)
  }
  requestAnimationFrame(restore)
}, true)

// webview tab 切出去再切回来时:vditor 的 layout 状态可能瞬时不一致(工具栏挤换行、内容区空白闪烁)。
// 切回(visibilitychange,!hidden)时主动触发 forced reflow + 重 attach 行号,让浏览器重画。
document.addEventListener('visibilitychange', () => {
  if (document.hidden) return
  requestAnimationFrame(() => {
    // 触发一次 layout 计算让浏览器 reflow vditor 内的元素
    void document.body.offsetHeight
    scheduleAttach()
    updateCursorMarker()
  })
})


function initVditor(msg) {
  console.log('msg', msg)
  // 按内容行数判定文档规模,决定行号刷新策略(小文档即时 / 大文档保守防卡)
  _isLargeDoc = (msg.content || '').split('\n').length > LARGE_DOC_LINES
  let inputTimer
  let defaultOptions: any = {}
  defaultOptions = merge(defaultOptions, msg.options, {
    preview: {
      math: {
        inlineDigit: true,
      }
    }
  })
  // Apply theme from VS Code AFTER merge so it takes precedence over stored options
  if (msg.theme === 'dark') {
    defaultOptions.theme = 'dark'
    defaultOptions.preview = defaultOptions.preview || {}
    defaultOptions.preview.theme = { current: 'dark' }
    // hljs 只负责 token 高亮配色(关键字/字符串/数字色),代码块底色由 main.css 用 VS Code 变量覆盖
    // monokai 选这一个就因为它的 token 色在任意深色 VS Code 主题下都还能看,不抢眼
    defaultOptions.preview.hljs = { style: 'monokai' }
  } else if (msg.theme === 'light') {
    defaultOptions.theme = 'classic'
    defaultOptions.preview = defaultOptions.preview || {}
    defaultOptions.preview.theme = { current: 'light' }
    defaultOptions.preview.hljs = { style: 'github' }
  }
  if (window.vditor) {
    vditor.destroy()
    window.vditor = null
  }
  window.vditor = new Vditor('app', {
    width: '100%',
    height: '100%',
    minHeight: '100%',
    lang,
    value: msg.content,
    mode: 'ir',
    cache: { enable: false },
    toolbar,
    toolbarConfig: { pin: true },
    ...defaultOptions,
    after() {
      fixDarkTheme()
      handleToolbarClick()
      fixTableIr()
      fixPanelHover()
      fixOutlineCloseScroll()
      // 首次 attach 延迟到 idle callback:大文档(数千行)attach 要全量 Lute 解析 + DOM 遍历,
      // 同步跑会卡住首屏可见时间。延迟后用户先看到内容,行号慢一拍出来,体感快很多。
      const firstAttach = () => { attachLineNumbers(); bindLineMo() }
      if (typeof (window as any).requestIdleCallback === 'function') {
        ;(window as any).requestIdleCallback(firstAttach, { timeout: 500 })
      } else {
        setTimeout(firstAttach, 0)
      }
      // 窗口/容器尺寸变化时重算行号(wrap 行数/位置会变,绝对定位的 overlay 必须跟着重排)
      // debounce 50ms 避免拖拽 resize 时高频重算;走 scheduleAttach 让 MutationObserver disconnect/reconnect 配套
      let resizeTimer: any = null
      const scheduleReattach = () => {
        if (resizeTimer) clearTimeout(resizeTimer)
        resizeTimer = setTimeout(scheduleAttach, 50)
      }
      const editor = document.getElementById('app')
      if (editor && typeof ResizeObserver !== 'undefined') {
        const ro = new ResizeObserver(scheduleReattach)
        ro.observe(editor)
      } else {
        window.addEventListener('resize', scheduleReattach)
      }
      // scroll 触发也要 reattach:视口剪裁让"视口外"元素没 gutter-y,滚动后这些元素进入视口要补算
      // 直接挂在 root 的可能的滚动祖先上;window scroll 作 fallback
      window.addEventListener('scroll', scheduleReattach, { passive: true, capture: true })
    },
    input() {
      if (_isLargeDoc) {
        // 大文档:输入进行中冻结 attach / cursor(防卡),主线程让给 vditor。停 500ms 后解冻补行号。
        _typing = true
        inputTimer && clearTimeout(inputTimer)
        inputTimer = setTimeout(() => {
          _typing = false
          scheduleAttach()
          if ((window as any).__updateCursorMarker) (window as any).__updateCursorMarker()
          const send = () => vscode.postMessage({ command: 'edit', content: vditor.getValue() })
          if (typeof (window as any).requestIdleCallback === 'function') {
            ;(window as any).requestIdleCallback(send, { timeout: 2000 })
          } else {
            send()
          }
        }, 500)
      } else {
        // 小文档:不冻结,立即调度 attach(30ms 后),行号即时跟随;getValue 短 debounce 同步
        scheduleAttach()
        inputTimer && clearTimeout(inputTimer)
        inputTimer = setTimeout(() => {
          vscode.postMessage({ command: 'edit', content: vditor.getValue() })
        }, 150)
      }
    },
    upload: {
      url: '/fuzzy', // 没有 url 参数粘贴图片无法上传 see: https://github.com/Vanessa219/vditor/blob/d7628a0a7cfe5d28b055469bf06fb0ba5cfaa1b2/src/ts/util/fixBrowserBehavior.ts#L1409
      async handler(files) {
        // console.log('files', files)
        let fileInfos = await Promise.all(
          files.map(async (f) => {
            const d = new Date()
            return {
              base64: await fileToBase64(f),
              name: `${format(new Date(), 'yyyyMMdd_HHmmss')}_${f.name}`.replace(
                /[^\w-_.]+/,
                '_'
              ),
            }
          })
        )
        vscode.postMessage({
          command: 'upload',
          files: fileInfos,
        })
      },
    },
  })
}

window.addEventListener('message', (e) => {
  const msg = e.data
  // console.log('msg from vscode', msg)
  switch (msg.command) {
    case 'vscode-buffer': {
      const next = msg.content || ''
      const prev = (window as any).__vscodeBuffer
      // buffer 真没变就不触发 attach,大幅减少编辑期间的重算开销
      if (prev === next) break
      ;(window as any).__vscodeBuffer = next
      ;(window as any).__attachLineNumbers && (window as any).__attachLineNumbers()
      break
    }
    case 'update': {
      if (msg.type === 'init') {
        if (msg.options && msg.options.useVscodeThemeColor) {
          document.body.setAttribute('data-use-vscode-theme-color', '1')
        } else {
          document.body.setAttribute('data-use-vscode-theme-color', '0')
        }
        try {
          initVditor(msg)
        } catch (error) {
          // reset options when error
          console.error(error)
          initVditor({ content: msg.content })
          saveVditorOptions()
        }
        console.log('initVditor')
      } else {
        vditor.setValue(msg.content)
        console.log('setValue')
      }
      break
    }
    case 'uploaded': {
      msg.files.forEach((f) => {
        if (f.endsWith('.wav')) {
          vditor.insertValue(
            `\n\n<audio controls="controls" src="${f}"></audio>\n\n`
          )
        } else {
          const i = new Image()
          i.src = f
          i.onload = () => {
            vditor.insertValue(`\n\n![](${f})\n\n`)
          }
          i.onerror = () => {
            vditor.insertValue(`\n\n[${f.split('/').slice(-1)[0]}](${f})\n\n`)
          }
        }
      })
      break
    }
    default:
      break
  }
})

fixLinkClick()
fixCut()

vscode.postMessage({ command: 'ready' })
// 让扩展端把 VS Code 文件 buffer 推一次过来,行号注入要用 buffer 作为权威源
vscode.postMessage({ command: 'request-buffer' })
