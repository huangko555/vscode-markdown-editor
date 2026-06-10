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

// 行号 = 元素的 ::before 伪元素(content=attr(data-line)),浏览器原生 inline 机制保证 baseline 严格对齐
// JS 只算每个元素的 --vmd-gutter-x(水平偏移),让所有 ::before 落到同一 X 列
function attachLineNumbers() {
  if (!(window as any).vditor) return
  const roots = document.querySelectorAll<HTMLElement>('.vditor-reset[contenteditable="true"]')
  let root: HTMLElement | null = null
  roots.forEach((r) => { if (r.offsetParent !== null) root = r })
  if (!root) return

  const md: string = (window as any).vditor.getValue()
  const lines = md.split('\n')

  // 清掉旧的 data-line 和各种 gutter overlay
  root.querySelectorAll('[data-line]').forEach(el => el.removeAttribute('data-line'))
  root.querySelectorAll('.vmd-code-gutter, .vmd-block-gutter, .vmd-line-gutter').forEach(el => el.remove())

  const children = Array.from(root.children) as HTMLElement[]
  let sourceIdx = 0
  let domIdx = 0

  while (sourceIdx < lines.length && domIdx < children.length) {
    while (sourceIdx < lines.length && lines[sourceIdx].trim() === '') sourceIdx++
    if (sourceIdx >= lines.length) break

    const child = children[domIdx]
    const startLine = sourceIdx + 1
    const firstLine = lines[sourceIdx]
    const consumed = blockConsumed(firstLine, lines, sourceIdx)
    const endLine = sourceIdx + consumed
    const labelText = startLine === endLine ? String(startLine) : `${startLine}-${endLine}`

    if (firstLine.startsWith('```') || firstLine.startsWith('~~~')) {
      // 代码块:只给 preview pre 建 gutter(编辑态不需要)
      const preview = child.querySelector('pre.vditor-ir__preview') as HTMLElement | null
      if (preview) {
        const code = preview.querySelector('code') as HTMLElement | null
        if (code) buildCodeGutter(preview, code, startLine + 1)
      }
    } else if (firstLine.startsWith('|')) {
      // 表格:per-tr data-line 放在第一个 td/th
      const table = child.tagName === 'TABLE' ? (child as HTMLTableElement) : child.querySelector('table')
      if (table) {
        markTableRows(table, lines, sourceIdx)
      } else {
        child.setAttribute('data-line', labelText)
      }
    } else if (/^[*\-+] /.test(firstLine) || /^\d+\. /.test(firstLine)) {
      // 列表:per-li 递归
      let listEl: HTMLElement | null = null
      if (child.tagName === 'UL' || child.tagName === 'OL') listEl = child
      else listEl = child.querySelector('ul, ol')
      if (listEl) markListItems(listEl, lines, sourceIdx)
      else child.setAttribute('data-line', labelText)
    } else {
      // 标题、HR — 单源行用 data-line + ::after,挂在真正的 h1-h6 元素上(font-size 继承正确)
      // 多源行段落/blockquote — 用 per-line gutter overlay
      if (endLine === startLine) {
        let target: Element = child
        if (firstLine.startsWith('#')) {
          target = child.querySelector('h1,h2,h3,h4,h5,h6') || child
        }
        target.setAttribute('data-line', String(startLine))
      } else {
        buildBlockGutter(child, startLine, endLine, lines)
      }
    }

    sourceIdx += consumed
    domIdx++
  }

  // 为所有 [data-line] 元素计算 --vmd-gutter-x,::after 都落到同一 X 列
  // 注意:::after position absolute 是相对 padding-box 的(border 之内),
  // 要减去元素的 border-left 宽度,否则 blockquote 等带 border-left 的元素会偏移
  const rootRect = root.getBoundingClientRect()
  root.querySelectorAll<HTMLElement>('[data-line]').forEach(el => {
    const elRect = el.getBoundingClientRect()
    const borderLeft = parseFloat(getComputedStyle(el).borderLeftWidth) || 0
    el.style.setProperty('--vmd-gutter-x', (-(elRect.left - rootRect.left) + 5 - borderLeft) + 'px')
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
  // 视觉 baseline 比代码 baseline 略高几像素,补一个经验 shift 让数字落下来
  const codeLh = parseFloat(getComputedStyle(code).lineHeight) || 14
  const codeFs = parseFloat(getComputedStyle(code).fontSize) || 14
  const yShift = Math.max(0, (codeLh - codeFs) / 2)

  let html = ''
  for (let i = 0; i < lineYs.length; i++) {
    const relY = lineYs[i] - previewRect.top + yShift
    html += `<div style="top:${relY}px">${contentStartLine + i}</div>`
  }
  gutter.innerHTML = html
  preview.appendChild(gutter)
}

// 多源行块:per-line gutter
// 用每个源行的文本签名在元素 textContent 里搜索它的位置,再映射回 DOM 找 Y
// — 不依赖 DOM 结构(<br>/嵌套 block),只要文字在就找得到
function buildBlockGutter(el: HTMLElement, startLine: number, endLine: number, allLines: string[]) {
  const numLines = endLine - startLine + 1
  const sourceLines = allLines.slice(startLine - 1, endLine)

  let lineYs = findSourceLineYsByText(el, sourceLines)

  // 如果文本搜索失败,fallback 用结构(<br> / 嵌套 block)
  if (lineYs.length < numLines) {
    const structureYs = findSourceLineYsByStructure(el)
    const merged = [...lineYs, ...structureYs]
    merged.sort((a, b) => a - b)
    const dedup: number[] = []
    for (const y of merged) {
      if (dedup.length === 0 || y > dedup[dedup.length - 1] + 2) dedup.push(y)
    }
    if (dedup.length > lineYs.length) lineYs = dedup
  }

  if (lineYs.length === 0) {
    el.setAttribute('data-line', `${startLine}-${endLine}`)
    return
  }

  const root = el.closest('.vditor-reset') as HTMLElement | null
  if (!root) return
  const rootRect = root.getBoundingClientRect()
  const elRect = el.getBoundingClientRect()

  el.style.position = 'relative'

  const gutter = document.createElement('div')
  gutter.className = 'vmd-block-gutter'
  gutter.setAttribute('contenteditable', 'false')
  gutter.style.setProperty('--vmd-gutter-x', (-(elRect.left - rootRect.left) + 5) + 'px')

  // baseline 微调:数字 line-height:1 时上浮几像素,补 yShift 让它对齐父行
  const elLh = parseFloat(getComputedStyle(el).lineHeight) || 14
  const elFs = parseFloat(getComputedStyle(el).fontSize) || 14
  const yShift = Math.max(0, (elLh - elFs) / 2)

  // 通用规则:每个源行对应 lineYs[i];lineYs 不够时停在最后一个
  let html = ''
  for (let i = 0; i < numLines; i++) {
    const yIdx = Math.min(i, lineYs.length - 1)
    const y = lineYs[yIdx] - elRect.top
    html += `<div style="top:${y + yShift}px">${startLine + i}</div>`
  }
  gutter.innerHTML = html
  el.appendChild(gutter)
}

// 用源行文字签名在元素 textContent 里搜索每行的 Y
// vditor IR 模式 textContent 保留 markdown 标记(只是 CSS 隐藏),所以用字面值优先
function findSourceLineYsByText(el: HTMLElement, sourceLines: string[]): number[] {
  const ys: number[] = []
  const fullText = el.textContent || ''
  let lastPos = 0

  const tryFind = (variant: string, from: number): number => {
    const sig = variant.substring(0, 25)
    if (sig.length < 2) return -1
    return fullText.indexOf(sig, from)
  }

  // 从 pos 往后扫,直到找到一个真正可视(非 hidden marker)的字符,返回它的 Y
  // vditor IR 把 ** > 等 markdown 标记藏在 width:0 height:0 的 span 里,
  // 命中这些字符时 Range bounding rect height 是 0,要跳过它们找到下一个真实文字
  const getYAt = (pos: number, sigLen: number): { y: number; endPos: number } | null => {
    for (let off = 0; off < 40; off++) {
      const node = findNodeAtTextPos(el, pos + off)
      if (!node) continue
      try {
        const range = document.createRange()
        range.setStart(node.node, node.offset)
        range.setEnd(node.node, Math.min(node.offset + 1, (node.node.textContent || '').length))
        const rect = range.getBoundingClientRect()
        if (rect.height > 0 && rect.width > 0) return { y: rect.top, endPos: pos + sigLen }
      } catch {}
    }
    return null
  }

  for (let i = 0; i < sourceLines.length; i++) {
    const raw = sourceLines[i].trim()
    // 多种签名变体逐个尝试
    const variants: string[] = [
      raw,                                                                          // 字面值(IR 模式 textContent 保留 markdown 标记)
      raw.replace(/^[>#\-*+]+\s*/, '').replace(/^\d+\.\s+/, ''),                    // 去前导标记
      raw.replace(/\*\*|\*|__|_|`|~/g, ''),                                         // 去内联标记
      raw.replace(/^[>#\-*+]+\s*/, '').replace(/^\d+\.\s+/, '').replace(/\*\*|\*|__|_|`|~/g, ''), // 全去
    ]

    let placed = false
    for (const v of variants) {
      const sig = v.substring(0, 25)
      if (sig.length < 2) continue
      const pos = fullText.indexOf(sig, lastPos)
      if (pos < 0) continue
      const res = getYAt(pos, sig.length)
      if (res) {
        ys.push(res.y)
        lastPos = res.endPos
        placed = true
        break
      }
    }

    if (!placed) {
      // 全部 fallback 失败 — 用上一行 Y
      ys.push(ys[i - 1] !== undefined ? ys[i - 1] : 0)
    }
  }
  return ys
}

// 找 textContent 拼接里第 targetPos 个字符所在的 (TextNode, offset)
function findNodeAtTextPos(el: HTMLElement, targetPos: number): { node: Text; offset: number } | null {
  let count = 0
  let result: { node: Text; offset: number } | null = null
  function walk(node: Node): boolean {
    if (result) return true
    if (node.nodeType === Node.TEXT_NODE) {
      const text = node.textContent || ''
      if (count + text.length > targetPos) {
        result = { node: node as Text, offset: targetPos - count }
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
  return result
}

// 结构化方式找源行 Y(<br>/嵌套块)— 作为 text-search 的 fallback
function findSourceLineYsByStructure(el: HTMLElement): number[] {
  const ys: number[] = []
  const fullRange = document.createRange()
  fullRange.selectNodeContents(el)
  const allRects = fullRange.getClientRects()
  for (let i = 0; i < allRects.length; i++) {
    const r = allRects[i]
    if (r.height > 0 && r.width > 0) { ys.push(r.top); break }
  }
  el.querySelectorAll('br').forEach(br => {
    const rect = firstVisibleRectAfter(br)
    if (rect) ys.push(rect.top)
  })
  const blockTags = ['P', 'DIV', 'BLOCKQUOTE', 'PRE']
  Array.from(el.children).filter(c => blockTags.includes(c.tagName)).forEach((blk, idx) => {
    if (idx === 0) return
    const range = document.createRange()
    range.selectNodeContents(blk)
    const rects = range.getClientRects()
    for (let i = 0; i < rects.length; i++) {
      const r = rects[i]
      if (r.height > 0 && r.width > 0) { ys.push(r.top); break }
    }
  })
  ys.sort((a, b) => a - b)
  const dedup: number[] = []
  for (const y of ys) {
    if (dedup.length === 0 || y > dedup[dedup.length - 1] + 2) dedup.push(y)
  }
  return dedup
}

// 找一个节点之后第一个有可视矩形的文字/元素
function firstVisibleRectAfter(node: Node): DOMRect | null {
  let current: Node | null = node
  while (current) {
    let next: Node | null = current.nextSibling
    while (next) {
      if (next.nodeType === Node.TEXT_NODE) {
        const t = (next.textContent || '')
        if (t.trim()) {
          try {
            const range = document.createRange()
            range.setStart(next, 0)
            range.setEnd(next, Math.min(1, t.length))
            const r = range.getBoundingClientRect()
            if (r.height > 0 && r.width > 0) return r as DOMRect
          } catch {}
        }
      } else if (next.nodeType === Node.ELEMENT_NODE) {
        try {
          const range = document.createRange()
          range.selectNodeContents(next)
          const rects = range.getClientRects()
          for (let i = 0; i < rects.length; i++) {
            const r = rects[i]
            if (r.height > 0 && r.width > 0) return r as DOMRect
          }
        } catch {}
      }
      next = next.nextSibling
    }
    current = current.parentNode
  }
  return null
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

function markTableRows(table: HTMLElement, lines: string[], startIdx: number) {
  const allTrs = Array.from(table.querySelectorAll('tr')) as HTMLElement[]
  let si = startIdx, ti = 0
  while (si < lines.length && ti < allTrs.length) {
    const sl = lines[si]
    if (!sl.startsWith('|')) break
    if (/^\|[\s|:\-]+\|?\s*$/.test(sl)) { si++; continue }
    const firstCell = allTrs[ti].querySelector('td, th') as HTMLElement | null
    if (firstCell) firstCell.setAttribute('data-line', String(si + 1))
    ti++; si++
  }
}

function markListItems(listEl: HTMLElement, lines: string[], startIdx: number): number {
  let si = startIdx
  const items = Array.from(listEl.children).filter(c => c.tagName === 'LI') as HTMLElement[]
  for (const li of items) {
    while (si < lines.length) {
      const t = lines[si].trimStart()
      if (/^[*\-+] /.test(t) || /^\d+\. /.test(t)) break
      si++
    }
    if (si >= lines.length) break
    li.setAttribute('data-line', String(si + 1))
    si++
    const nested = Array.from(li.children).find(c => c.tagName === 'UL' || c.tagName === 'OL') as HTMLElement | undefined
    if (nested) si = markListItems(nested, lines, si)
  }
  return si
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
      attachLineNumbers()
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
