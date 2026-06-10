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
      // 代码块:per-line gutter overlay
      const preview = child.querySelector('pre.vditor-ir__preview') as HTMLElement | null
      if (preview) {
        const code = preview.querySelector('code') as HTMLElement | null
        if (code) buildCodeGutter(preview, code, startLine + 1)
      }
      // 不在 child 上加 data-line(避免 ::before 重叠 gutter)
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
      // 标题、HR — 单源行用 data-line + ::before
      // 多源行段落/blockquote — 用 per-line gutter overlay(Range 实测每行 Y)
      if (endLine === startLine) {
        child.setAttribute('data-line', String(startLine))
      } else {
        buildBlockGutter(child, startLine, endLine)
      }
    }

    sourceIdx += consumed
    domIdx++
  }

  // 为所有 [data-line] 元素计算 --vmd-gutter-x,让 ::before 落到同一 X 列
  const rootRect = root.getBoundingClientRect()
  root.querySelectorAll<HTMLElement>('[data-line]').forEach(el => {
    const elLeft = el.getBoundingClientRect().left
    const offset = -(elLeft - rootRect.left) + 5
    el.style.setProperty('--vmd-gutter-x', offset + 'px')
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

  let html = ''
  for (let i = 0; i < lineYs.length; i++) {
    const relY = lineYs[i] - previewRect.top
    html += `<div style="top:${relY}px">${contentStartLine + i}</div>`
  }
  gutter.innerHTML = html
  preview.appendChild(gutter)
}

// 多源行段落:per-line gutter,数字 Y 用 Range.getClientRects() 实测
function buildBlockGutter(el: HTMLElement, startLine: number, endLine: number) {
  const numLines = endLine - startLine + 1

  const range = document.createRange()
  range.selectNodeContents(el)
  const rects: DOMRect[] = []
  const all = range.getClientRects()
  for (let i = 0; i < all.length; i++) {
    if (all[i].height > 0 && all[i].width > 0) rects.push(all[i] as DOMRect)
  }
  if (rects.length === 0) {
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
  const offset = -(elRect.left - rootRect.left) + 5
  gutter.style.setProperty('--vmd-gutter-x', offset + 'px')

  let html = ''
  if (rects.length === numLines) {
    // 1:1 (hard-wrap 段落,每源行 = 一个 <br> 分隔的可视行)
    for (let i = 0; i < numLines; i++) {
      html += `<div style="top:${rects[i].top - elRect.top}px">${startLine + i}</div>`
    }
  } else {
    // reflow 段落 — 在可视行 Y 范围内均匀分布
    const topY = rects[0].top - elRect.top
    const bottomY = rects[rects.length - 1].top - elRect.top
    const span = bottomY - topY
    for (let i = 0; i < numLines; i++) {
      const y = numLines === 1 ? topY : topY + (span / (numLines - 1)) * i
      html += `<div style="top:${y}px">${startLine + i}</div>`
    }
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
      inputTimer && clearTimeout(inputTimer)
      inputTimer = setTimeout(() => {
        vscode.postMessage({ command: 'edit', content: vditor.getValue() })
        attachLineNumbers()
      }, 30)
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
