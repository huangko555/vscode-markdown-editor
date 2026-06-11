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

// 行号映射:用 markdown-it 解析源 md 拿 token.map 源行号,注入到 vditor DOM 的 data-source-line
// 再算每个标了 data-source-line 的元素的 --vmd-gutter-x,让 ::after 行号都落到同一 X 列
function attachLineNumbers() {
  if (!(window as any).vditor) return
  if (!document.body.classList.contains('lineno-on')) return
  const root = getVisibleEditorRoot()
  if (!root) return

  // 清掉旧 gutter overlay(代码块/多行段落都是独立 div,需要每次重建)
  root.querySelectorAll('.vmd-code-gutter, .vmd-block-gutter').forEach(el => el.remove())

  const source: string = (window as any).vditor.getValue()
  injectSourceLines(root, source)

  // 代码块特殊:per-line gutter(每行单独 div,startLine+1 跳过 fence ``` 那行)
  root.querySelectorAll<HTMLElement>('pre.vditor-ir__preview').forEach(preview => {
    const node = preview.closest('[data-source-line]') as HTMLElement | null
    if (!node) return
    const startLine = parseInt(node.getAttribute('data-source-line') || '0')
    if (!startLine) return
    const code = preview.querySelector('code') as HTMLElement | null
    if (code) buildCodeGutter(preview, code, startLine + 1)
  })

  // 多行段落:markdown-it 把连续非空行合成一个 paragraph token,只给 1 个 startLine
  // 用 Range 实测每行可视 Y,overlay 每行单独显示行号(顶层段落 + blockquote 内段落都走这里)
  root.querySelectorAll<HTMLElement>('[data-source-line-end]').forEach(p => {
    const startLine = parseInt(p.getAttribute('data-source-line') || '0')
    const endLine = parseInt(p.getAttribute('data-source-line-end') || '0')
    if (endLine > startLine) buildParagraphGutter(p, startLine, endLine)
  })

  // 算每个 [data-source-line] 元素的 --vmd-gutter-x / --vmd-gutter-y
  // x:::after 是 position:absolute,基准是 padding-box;blockquote 有 border-left,要扣掉
  // y:对齐到第一行视觉中心(padTop + lineHeight/2),wrap 时不再用元素整体中点(会落到行间空白)
  const rootRect = root.getBoundingClientRect()
  root.querySelectorAll<HTMLElement>('[data-source-line]').forEach(el => {
    const elRect = el.getBoundingClientRect()
    const cs = getComputedStyle(el)
    const borderLeft = parseFloat(cs.borderLeftWidth) || 0
    el.style.setProperty('--vmd-gutter-x', (-(elRect.left - rootRect.left) + 5 - borderLeft) + 'px')
    const elLh = parseFloat(cs.lineHeight)
    if (elLh && elLh > 0) {
      const padTop = parseFloat(cs.paddingTop) || 0
      // 0.45 比正中(0.5)略上偏,矫正数字行槽视觉重心偏低的错觉
      el.style.setProperty('--vmd-gutter-y', (padTop + elLh * 0.45) + 'px')
    } else {
      el.style.removeProperty('--vmd-gutter-y')
    }
  })
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
  const textNodes: Text[] = []
  function collect(n: Node) {
    if (n.nodeType === Node.TEXT_NODE) textNodes.push(n as Text)
    else for (let i = 0; i < n.childNodes.length; i++) collect(n.childNodes[i])
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
    for (const tn of textNodes) {
      const text = tn.textContent || ''
      const len = text.length
      if (count + len <= fromIdx) { count += len; continue }
      const startOff = Math.max(0, fromIdx - count)
      // 跳过 marker span 内的 text node
      let p = tn.parentElement
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
          try { r.setStart(tn, off); r.setEnd(tn, off + 1) } catch { continue }
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
  const elLh = parseFloat(cs.lineHeight) || firstRect.height
  let html = ''
  for (let i = 0; i < numLines; i++) {
    const lr = lineRects[i] || firstRect
    const y = lr.top - elRect.top + Math.max(0, (elLh - codeFs) * 0.05)
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

// vditor 在 input/回车/删除后会异步 mutation 重渲染 DOM,我们的 overlay 会被擦掉、[data-source-line] 也变。
// 用 MutationObserver 监听 root 内变化,rAF 合并多次 mutation,自动重 attach。防自身触发:每次 attach 前 disconnect、attach 后 reconnect。
let lineMo: MutationObserver | null = null
let attachRafId: number | null = null
function scheduleAttach() {
  if (attachRafId != null) return
  attachRafId = requestAnimationFrame(() => {
    attachRafId = null
    lineMo?.disconnect()
    attachLineNumbers()
    bindLineMo()
  })
}
function bindLineMo() {
  if (!document.body.classList.contains('lineno-on')) return
  const root = getVisibleEditorRoot()
  if (!root) return
  if (!lineMo) lineMo = new MutationObserver(scheduleAttach)
  // 加 attributes:vditor 退出代码块编辑时只切 class/style(preview ↔ edit),
  // 不监听属性变化的话 overlay 不会被重 attach。
  // 只盯 class/style 收敛事件量,attach 期间已 disconnect 不会形成回路
  lineMo.observe(root, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
    attributeFilter: ['class', 'style'],
  })
}
function detachLineMo() {
  lineMo?.disconnect()
  if (attachRafId != null) { cancelAnimationFrame(attachRafId); attachRafId = null }
}
;(window as any).__attachLineNumbers = scheduleAttach
;(window as any).__detachLineNumbers = detachLineMo


function initVditor(msg) {
  console.log('msg', msg)
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
      attachLineNumbers()
      bindLineMo()
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
    },
    input() {
      scheduleAttach()
      inputTimer && clearTimeout(inputTimer)
      inputTimer = setTimeout(() => {
        vscode.postMessage({ command: 'edit', content: vditor.getValue() })
      }, 100)
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
