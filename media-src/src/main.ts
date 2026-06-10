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

// 给每个顶层渲染块标 data-line=源 md 起始行号(行号显示靠 CSS ::after)
// 算法:把源 md 一行一行扫,识别 block 类型,顺着 DOM 顶层子节点对齐
function attachLineNumbers() {
  if (!(window as any).vditor) return
  const roots = document.querySelectorAll<HTMLElement>('.vditor-reset[contenteditable="true"]')
  let root: HTMLElement | null = null
  roots.forEach((r) => { if (r.offsetParent !== null) root = r })  // 选当前可见模式的 root
  if (!root) return

  const md: string = (window as any).vditor.getValue()
  const lines = md.split('\n')
  const children = Array.from(root.children) as HTMLElement[]

  let sourceIdx = 0
  let domIdx = 0

  while (sourceIdx < lines.length && domIdx < children.length) {
    while (sourceIdx < lines.length && lines[sourceIdx].trim() === '') sourceIdx++
    if (sourceIdx >= lines.length) break

    const child = children[domIdx]
    const startLine = sourceIdx + 1

    const line = lines[sourceIdx]
    let consumed = 1

    if (line.startsWith('```') || line.startsWith('~~~')) {
      const fence = line.substring(0, 3)
      while (sourceIdx + consumed < lines.length && !lines[sourceIdx + consumed].startsWith(fence)) consumed++
      consumed++
    } else if (line.startsWith('|')) {
      while (sourceIdx + consumed < lines.length && lines[sourceIdx + consumed].startsWith('|')) consumed++
    } else if (line.startsWith('>')) {
      while (sourceIdx + consumed < lines.length && lines[sourceIdx + consumed].startsWith('>')) consumed++
    } else if (/^[*\-+] /.test(line) || /^\d+\. /.test(line)) {
      while (sourceIdx + consumed < lines.length) {
        const next = lines[sourceIdx + consumed]
        if (next.trim() === '') break
        if (/^[*\-+] /.test(next) || /^\d+\. /.test(next) || next.startsWith('  ') || next.startsWith('\t')) consumed++
        else break
      }
    } else if (!line.startsWith('#') && !/^---+$/.test(line) && !/^___+$/.test(line) && !/^\*\*\*+$/.test(line)) {
      while (sourceIdx + consumed < lines.length && lines[sourceIdx + consumed].trim() !== '') consumed++
    }

    const endLine = sourceIdx + consumed
    child.setAttribute('data-line', startLine === endLine ? String(startLine) : `${startLine}-${endLine}`)

    sourceIdx += consumed
    domIdx++
  }

  for (let i = domIdx; i < children.length; i++) children[i].removeAttribute('data-line')
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
