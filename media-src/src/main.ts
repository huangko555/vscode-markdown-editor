import './preload'

import {
  fileToBase64,
  fixCut,
  fixDarkTheme,
  fixLinkClick,
  fixPanelHover,
  handleToolbarClick,
  saveVditorOptions,
} from './utils'

import { merge } from 'lodash'
import Vditor from 'vditor'
import { format } from 'date-fns'
import 'vditor/dist/index.css'
import { t, lang } from './lang'
import { toolbar } from './toolbar'
import { fixTableIr } from './fix-table-ir'
import './main.css'

// restore zebra toggle state (default OFF)
try {
  if (localStorage.getItem('vditor-md.zebra') === '1') {
    document.body.classList.add('zebra-on')
  }
} catch {}

// restore lineno toggle state (default ON)
try {
  if (localStorage.getItem('vditor-md.lineno') !== '0') {
    document.body.classList.add('lineno-on')
  }
} catch {
  document.body.classList.add('lineno-on')
}

// 全局 gutter:单一容器 .vmd-line-gutter 放所有行号子 div,X 列一致对齐
// 每个数字的 top = 对应 DOM 元素相对 root 的 Y 偏移
// — 代码块/表格/列表精确到行
// — 段落/blockquote 多行块在块内均匀分布(reflow 后逐行没法精确,但数字齐全)
function attachLineNumbers() {
  if (!(window as any).vditor) return
  const roots = document.querySelectorAll<HTMLElement>('.vditor-reset[contenteditable="true"]')
  let root: HTMLElement | null = null
  roots.forEach((r) => { if (r.offsetParent !== null) root = r })
  if (!root) return

  const md: string = (window as any).vditor.getValue()
  const lines = md.split('\n')

  root.style.position = 'relative'

  const old = root.querySelector(':scope > .vmd-line-gutter')
  if (old) old.remove()

  const gutter = document.createElement('div')
  gutter.className = 'vmd-line-gutter'
  gutter.setAttribute('contenteditable', 'false')
  root.appendChild(gutter)

  const rootRect = root.getBoundingClientRect()
  // 用 Range.selectNodeContents() + getClientRects() 拿元素的"每一行可视文字"的矩形
  // 浏览器原生测量,自动处理 marker/隐藏 span/嵌套段落等;返回第一个非空的行矩形 top
  const topOf = (el: HTMLElement) => {
    try {
      const range = document.createRange()
      range.selectNodeContents(el)
      const rects = range.getClientRects()
      for (let i = 0; i < rects.length; i++) {
        const r = rects[i]
        if (r.height > 0 && r.width > 0) return r.top - rootRect.top + root!.scrollTop
      }
    } catch {}
    return el.getBoundingClientRect().top - rootRect.top + root!.scrollTop
  }
  // 把数字的 line-height/font-size 跟目标元素同步,baseline 严格对齐
  const place = (n: number, top: number, refEl?: HTMLElement) => {
    const d = document.createElement('div')
    d.textContent = String(n)
    d.style.top = top + 'px'
    if (refEl) {
      const cs = getComputedStyle(refEl)
      d.style.lineHeight = cs.lineHeight
    }
    gutter.appendChild(d)
  }
  // 拿元素内每一行可视文字的 line rect(浏览器自己测,逐行精确)
  const lineRectsOf = (el: HTMLElement): DOMRect[] => {
    try {
      const range = document.createRange()
      range.selectNodeContents(el)
      const out: DOMRect[] = []
      const rects = range.getClientRects()
      for (let i = 0; i < rects.length; i++) {
        const r = rects[i]
        if (r.height > 0 && r.width > 0) out.push(r as DOMRect)
      }
      return out
    } catch { return [] }
  }

  const children = Array.from(root.children).filter(c => !c.classList.contains('vmd-line-gutter')) as HTMLElement[]
  let sourceIdx = 0
  let domIdx = 0

  while (sourceIdx < lines.length && domIdx < children.length) {
    while (sourceIdx < lines.length && lines[sourceIdx].trim() === '') sourceIdx++
    if (sourceIdx >= lines.length) break

    const child = children[domIdx]
    const startLine = sourceIdx + 1
    const line = lines[sourceIdx]
    const consumed = blockConsumed(line, lines, sourceIdx)
    const endLine = sourceIdx + consumed

    placeBlockNumbers(child, line, startLine, endLine, lines, sourceIdx, place, topOf, lineRectsOf, rootRect, root)

    sourceIdx += consumed
    domIdx++
  }
}

function blockConsumed(line: string, lines: string[], startIdx: number): number {
  let c = 1
  if (line.startsWith('```') || line.startsWith('~~~')) {
    const fence = line.substring(0, 3)
    while (startIdx + c < lines.length && !lines[startIdx + c].startsWith(fence)) c++
    c++
  } else if (line.startsWith('|')) {
    while (startIdx + c < lines.length && lines[startIdx + c].startsWith('|')) c++
  } else if (line.startsWith('>')) {
    while (startIdx + c < lines.length && lines[startIdx + c].startsWith('>')) c++
  } else if (/^[*\-+] /.test(line) || /^\d+\. /.test(line)) {
    while (startIdx + c < lines.length) {
      const n = lines[startIdx + c]
      if (n.trim() === '') break
      if (/^[*\-+] /.test(n) || /^\d+\. /.test(n) || n.startsWith('  ') || n.startsWith('\t')) c++
      else break
    }
  } else if (!line.startsWith('#') && !/^---+$/.test(line) && !/^___+$/.test(line) && !/^\*\*\*+$/.test(line)) {
    while (startIdx + c < lines.length && lines[startIdx + c].trim() !== '') c++
  }
  return c
}

function placeBlockNumbers(
  child: HTMLElement,
  firstLine: string,
  startLine: number,
  endLine: number,
  lines: string[],
  sourceIdx: number,
  place: (n: number, top: number, refEl?: HTMLElement) => void,
  topOf: (el: HTMLElement) => number,
  lineRectsOf: (el: HTMLElement) => DOMRect[],
  rootRect: DOMRect,
  root: HTMLElement,
) {
  const ry = (rect: DOMRect) => rect.top - rootRect.top + root.scrollTop

  // 代码块 — 用 Range.getClientRects() 直接拿 <code> 里每一行的精确矩形
  if (firstLine.startsWith('```') || firstLine.startsWith('~~~')) {
    const preview = child.querySelector('pre.vditor-ir__preview') as HTMLElement | null
    if (preview) {
      const code = preview.querySelector('code') as HTMLElement | null
      if (code) {
        const rects = lineRectsOf(code)
        if (rects.length > 0) {
          for (let i = 0; i < rects.length; i++) place(startLine + 1 + i, ry(rects[i]), code)
          return
        }
      }
    }
    stackBlock(child, startLine, endLine, place, topOf, lineRectsOf, ry)
    return
  }

  // 表格 — 每个 tr 用 Range 测它的第一行可视文字 Y
  if (firstLine.startsWith('|')) {
    const table = child.tagName === 'TABLE' ? (child as HTMLTableElement) : child.querySelector('table') as HTMLTableElement | null
    if (table) {
      const allTrs = Array.from(table.querySelectorAll('tr')) as HTMLElement[]
      let si = sourceIdx, ti = 0
      while (si < lines.length && ti < allTrs.length) {
        const sl = lines[si]
        if (!sl.startsWith('|')) break
        if (/^\|[\s|:\-]+\|?\s*$/.test(sl)) { si++; continue }
        const tr = allTrs[ti]
        const rects = lineRectsOf(tr)
        place(si + 1, rects.length > 0 ? ry(rects[0]) : topOf(tr), tr)
        ti++; si++
      }
      return
    }
    stackBlock(child, startLine, endLine, place, topOf, lineRectsOf, ry)
    return
  }

  // 列表 — 递归
  if (/^[*\-+] /.test(firstLine) || /^\d+\. /.test(firstLine)) {
    let listEl: HTMLElement | null = null
    if (child.tagName === 'UL' || child.tagName === 'OL') listEl = child
    else listEl = child.querySelector('ul, ol')
    if (listEl) { walkListItems(listEl, lines, sourceIdx, place, topOf, lineRectsOf, ry); return }
    stackBlock(child, startLine, endLine, place, topOf, lineRectsOf, ry)
    return
  }

  // 标题、HR — 单行,用 Range 拿第一行矩形 top
  if (firstLine.startsWith('#') || /^---+$/.test(firstLine) || /^___+$/.test(firstLine) || /^\*\*\*+$/.test(firstLine)) {
    const rects = lineRectsOf(child)
    place(startLine, rects.length > 0 ? ry(rects[0]) : topOf(child), child)
    return
  }

  // 段落、blockquote 等多行块 — 用 Range 拿每行矩形,按源行数匀分到这些矩形
  stackBlock(child, startLine, endLine, place, topOf, lineRectsOf, ry)
}

function stackBlock(
  child: HTMLElement,
  startLine: number,
  endLine: number,
  place: (n: number, top: number, refEl?: HTMLElement) => void,
  topOf: (el: HTMLElement) => number,
  lineRectsOf: (el: HTMLElement) => DOMRect[],
  ry: (r: DOMRect) => number,
) {
  const numLines = endLine - startLine + 1
  const rects = lineRectsOf(child)

  // 单行块直接对齐第一行可视矩形
  if (numLines === 1) {
    place(startLine, rects.length > 0 ? ry(rects[0]) : topOf(child), child)
    return
  }

  // 源行数 == 可视行数 → 1:1 对齐 (常见:hard-wrap 段落)
  if (rects.length === numLines) {
    for (let i = 0; i < numLines; i++) place(startLine + i, ry(rects[i]), child)
    return
  }

  // 源行数 != 可视行数 → 均匀分布在可视行的 Y 范围内 (常见:reflow 段落)
  if (rects.length > 0) {
    const topY = ry(rects[0])
    const bottomY = ry(rects[rects.length - 1])
    const span = bottomY - topY
    if (numLines === 1) { place(startLine, topY, child); return }
    const step = span / (numLines - 1)
    for (let i = 0; i < numLines; i++) place(startLine + i, topY + i * step, child)
    return
  }

  // 兜底:用块的 offsetHeight 平均分
  const blockTop = topOf(child)
  const blockHeight = child.offsetHeight
  const step = blockHeight / numLines
  for (let n = startLine; n <= endLine; n++) place(n, blockTop + (n - startLine) * step, child)
}

function walkListItems(
  listEl: HTMLElement,
  lines: string[],
  startIdx: number,
  place: (n: number, top: number, refEl?: HTMLElement) => void,
  topOf: (el: HTMLElement) => number,
  lineRectsOf: (el: HTMLElement) => DOMRect[],
  ry: (r: DOMRect) => number,
): number {
  let si = startIdx
  const items = Array.from(listEl.children).filter(c => c.tagName === 'LI') as HTMLElement[]
  for (const li of items) {
    while (si < lines.length) {
      const t = lines[si].trimStart()
      if (/^[*\-+] /.test(t) || /^\d+\. /.test(t)) break
      si++
    }
    if (si >= lines.length) break
    const rects = lineRectsOf(li)
    place(si + 1, rects.length > 0 ? ry(rects[0]) : topOf(li), li)
    si++
    const nested = Array.from(li.children).find(c => c.tagName === 'UL' || c.tagName === 'OL') as HTMLElement | undefined
    if (nested) si = walkListItems(nested, lines, si, place, topOf, lineRectsOf, ry)
  }
  return si
}

;(window as any).__attachLineNumbers = attachLineNumbers


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
      attachLineNumbers()
    },
    input() {
      inputTimer && clearTimeout(inputTimer)
      inputTimer = setTimeout(() => {
        vscode.postMessage({ command: 'edit', content: vditor.getValue() })
        attachLineNumbers()
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
