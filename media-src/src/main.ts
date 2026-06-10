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
  // 用 Range 拿元素第一个非空文字节点的首字符 Y,对齐"实际可见文字"的位置
  // 比直接用 element border-top 准确(后者算的是 box 上沿,会偏到 margin/padding 之上的空白里)
  const topOf = (el: HTMLElement) => {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
    let node = walker.nextNode()
    while (node && !(node.textContent && node.textContent.trim())) node = walker.nextNode()
    if (node && node.textContent) {
      try {
        const range = document.createRange()
        range.setStart(node, 0)
        range.setEnd(node, 1)
        const r = range.getBoundingClientRect()
        if (r.height > 0) return r.top - rootRect.top + root!.scrollTop
      } catch {}
    }
    return el.getBoundingClientRect().top - rootRect.top + root!.scrollTop
  }
  const place = (n: number, top: number) => {
    const d = document.createElement('div')
    d.textContent = String(n)
    d.style.top = top + 'px'
    gutter.appendChild(d)
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

    placeBlockNumbers(child, line, startLine, endLine, lines, sourceIdx, place, topOf)

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
  place: (n: number, top: number) => void,
  topOf: (el: HTMLElement) => number,
) {
  // 代码块 — 每行精确
  if (firstLine.startsWith('```') || firstLine.startsWith('~~~')) {
    const preview = child.querySelector('pre.vditor-ir__preview') as HTMLElement | null
    if (preview) {
      const code = preview.querySelector('code') as HTMLElement | null
      if (code) {
        let codeLines = (code.textContent || '').split('\n')
        if (codeLines.length > 0 && codeLines[codeLines.length - 1] === '') codeLines.pop()
        const previewTop = topOf(preview)
        const lh = parseFloat(getComputedStyle(code).lineHeight) || 20
        for (let i = 0; i < codeLines.length; i++) place(startLine + 1 + i, previewTop + i * lh)
        return
      }
    }
    stackBlock(child, startLine, endLine, place, topOf)
    return
  }

  // 表格 — 每个 tr 精确;分隔行 |---| 在 DOM 里无对应 tr,跳过
  if (firstLine.startsWith('|')) {
    const table = child.tagName === 'TABLE' ? (child as HTMLTableElement) : child.querySelector('table') as HTMLTableElement | null
    if (table) {
      const allTrs = Array.from(table.querySelectorAll('tr')) as HTMLElement[]
      let si = sourceIdx, ti = 0
      while (si < lines.length && ti < allTrs.length) {
        const sl = lines[si]
        if (!sl.startsWith('|')) break
        if (/^\|[\s|:\-]+\|?\s*$/.test(sl)) { si++; continue }
        place(si + 1, topOf(allTrs[ti]))
        ti++; si++
      }
      return
    }
    stackBlock(child, startLine, endLine, place, topOf)
    return
  }

  // 列表 — 递归
  if (/^[*\-+] /.test(firstLine) || /^\d+\. /.test(firstLine)) {
    let listEl: HTMLElement | null = null
    if (child.tagName === 'UL' || child.tagName === 'OL') listEl = child
    else listEl = child.querySelector('ul, ol')
    if (listEl) { walkListItems(listEl, lines, sourceIdx, place, topOf); return }
    stackBlock(child, startLine, endLine, place, topOf)
    return
  }

  // 标题、HR — 单行
  if (firstLine.startsWith('#') || /^---+$/.test(firstLine) || /^___+$/.test(firstLine) || /^\*\*\*+$/.test(firstLine)) {
    place(startLine, topOf(child))
    return
  }

  // 段落、blockquote、其他 — 在块内均匀分布
  stackBlock(child, startLine, endLine, place, topOf)
}

function stackBlock(
  child: HTMLElement,
  startLine: number,
  endLine: number,
  place: (n: number, top: number) => void,
  topOf: (el: HTMLElement) => number,
) {
  const blockTop = topOf(child)
  const blockHeight = child.offsetHeight
  const numLines = endLine - startLine + 1
  if (numLines === 1) { place(startLine, blockTop); return }
  const lh = blockHeight / numLines
  for (let n = startLine; n <= endLine; n++) place(n, blockTop + (n - startLine) * lh)
}

function walkListItems(
  listEl: HTMLElement,
  lines: string[],
  startIdx: number,
  place: (n: number, top: number) => void,
  topOf: (el: HTMLElement) => number,
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
    place(si + 1, topOf(li))
    si++
    const nested = Array.from(li.children).find(c => c.tagName === 'UL' || c.tagName === 'OL') as HTMLElement | undefined
    if (nested) si = walkListItems(nested, lines, si, place, topOf)
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
