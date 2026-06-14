import { keyboard } from '@testing-library/user-event/dist/keyboard'
import $ from 'jquery'
require('jquery-confirm')(window, $)
import 'jquery-confirm/css/jquery-confirm.css'

import _ from 'lodash'
import Vditor from 'vditor'
window.vscode =
  (window as any).acquireVsCodeApi && (window as any).acquireVsCodeApi()
;(window as any).global = window

declare global {
  export const vditor: Vditor
  export const vscode: any
  interface Window {
    vditor: Vditor
    vscode: any
    global: Window
  }
}

export function confirm(msg, onOk) {
  $.confirm({
    title: '',
    animation: 'top',
    closeAnimation: 'top',
    animateFromElement: false,
    boxWidth: '300px',
    useBootstrap: false,
    content: msg,
    buttons: {
      cancel: {
        text: 'Cancel',
      },
      confirm: {
        text: 'Confirm',
        action: onOk,
      },
    },
  })
}
// 切换 content-theme 时自动修改 vditor theme
export function fixDarkTheme() {
  let $ct = document.querySelector('[data-type="content-theme"]')
  $ct.nextElementSibling.addEventListener('click', (e) => {
    if ((e.target as any).tagName !== 'BUTTON') return
    let type = (e.target as any).getAttribute('data-type')
    if (type === 'dark') {
      vditor.setTheme(type)
    } else {
      vditor.setTheme('classic')
    }
  })
}
// panel hover 加定时延迟
export function fixPanelHover() {
  $('.vditor-panel').each((i, e) => {
    let timer
    $(e)
      .on('mouseenter', (e) => {
        timer && clearTimeout(timer)
        e.currentTarget.classList.add('vditor-panel_hover')
      })
      .on('mouseleave', (e) => {
        let el = e.currentTarget
        timer = setTimeout(() => {
          el.classList.remove('vditor-panel_hover')
        }, 2000)
      })
  })
}
// 文件转base64用于传输
export const fileToBase64 = async (file) => {
  return new Promise((res, rej) => {
    const reader = new FileReader()
    reader.onload = function (evt) {
      res(evt.target.result.toString().split(',')[1])
    }
    reader.onerror = rej
    reader.readAsDataURL(file)
  })
}
// 保存 vditor 配置到 vscode 同步存储
export function saveVditorOptions() {
  let vditorOptions = {
    theme: vditor.vditor.options.theme,
    mode: vditor.vditor.currentMode,
    preview: vditor.vditor.options.preview,
  }
  vscode.postMessage({
    command: 'save-options',
    options: vditorOptions,
  })
}
// vditor 在 IR 模式下 DOM 里同时存在 .vditor-ir(可见) + .vditor-wysiwyg + 可能的 .vditor-sv,
// 它们都各自包含 .vditor-reset[contenteditable="true"]。必须挑可见的(offsetParent !== null),
// 否则会把 selection 设到隐藏元素里、scroller 也找不到。
export function getVisibleEditorRoot(): HTMLElement | null {
  const roots = document.querySelectorAll<HTMLElement>('.vditor-reset[contenteditable="true"]')
  let root: HTMLElement | null = null
  roots.forEach((r) => { if (r.offsetParent !== null) root = r })
  return root
}

function ensureSelectionInEditor() {
  const editorRoot = getVisibleEditorRoot()
  if (!editorRoot) return
  const sel = window.getSelection()
  if (!sel) return
  // 已有 selection 且在编辑区内 → 保留用户原位置,不动
  if (sel.rangeCount > 0) {
    const r = sel.getRangeAt(0)
    if (editorRoot.contains(r.commonAncestorContainer)) return
  }
  const rect = editorRoot.getBoundingClientRect()
  // 优先用 caretRangeFromPoint(直接 hit-test 文本 caret 位置,比 elementFromPoint 精准)
  // x 取靠左位置避开右侧 outline panel 覆盖,y 取视口中线
  const x = rect.left + Math.min(80, rect.width / 4)
  const y = rect.top + rect.height / 2
  let range: Range | null = null
  try {
    range = (document as any).caretRangeFromPoint?.(x, y) || null
  } catch {}
  if (!range || !editorRoot.contains(range.startContainer)) {
    // fallback:找视口内第一个可见的子元素,起点 set 到它
    const children = Array.from(editorRoot.children) as HTMLElement[]
    let el: HTMLElement | null = null
    for (const c of children) {
      const cr = c.getBoundingClientRect()
      if (cr.bottom > rect.top + 5 && cr.top < rect.bottom - 5) { el = c; break }
    }
    if (!el) el = editorRoot.firstElementChild as HTMLElement | null
    if (!el) return
    let target: Node = el
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
    const textNode = walker.nextNode()
    if (textNode) target = textNode
    range = document.createRange()
    range.selectNodeContents(target)
    range.collapse(true)
  }
  try {
    sel.removeAllRanges()
    sel.addRange(range)
  } catch {}
}

export function getMainScroller(): HTMLElement | null {
  // 同样要过滤可见,否则会拿到隐藏的 .vditor-wysiwyg(scrollHeight=0)误降级到 body
  const candidates = document.querySelectorAll<HTMLElement>('.vditor-ir, .vditor-wysiwyg, .vditor-sv')
  let scroller: HTMLElement | null = null
  candidates.forEach((c) => { if (c.offsetParent !== null && !scroller) scroller = c })
  while (scroller && scroller.scrollHeight <= scroller.clientHeight + 1) {
    scroller = scroller.parentElement
  }
  return scroller
}

// 修 outline 关闭后内容区被强制滚到顶部
// 根因:用户从 outline 跳转后焦点留在 outline 面板里、编辑区没 selection。关闭 outline 时 vditor
// 重 focus contenteditable → 浏览器把默认 caret 放文档开头 → scrollIntoView 滚顶。
// 主修复:点 outline 面板内任何东西后,主动把 selection 落到当前可见处 + focus 编辑区,
// 让焦点全程留在编辑器内,后续关 outline 时浏览器无事可做。
// 兜底:点 outline 工具栏按钮时挂 500ms scroll 监听,如果 scroll 仍被重置到 0 就拉回。
export function fixOutlineCloseScroll() {
  const restoreFocus = () => {
    const editorRoot = getVisibleEditorRoot()
    if (!editorRoot) return
    ensureSelectionInEditor()
    ;(editorRoot as any).focus({ preventScroll: true })
  }
  // capture 阶段,防 vditor 内部 stopPropagation
  document.addEventListener('click', (e) => {
    const target = e.target as Element | null
    if (!target || !target.closest) return
    if (!target.closest('.vditor-outline')) return
    // vditor scrollIntoView 是异步,多 tick 重 focus 保险
    requestAnimationFrame(restoreFocus)
    setTimeout(restoreFocus, 50)
    setTimeout(restoreFocus, 150)
    setTimeout(restoreFocus, 300)
  }, true)

  // 工具栏 outline 按钮在 .vditor-outline 之外(toolbar 里),click 那条覆盖不到。这里单独挂 scroll 救援
  document.addEventListener('mousedown', (e) => {
    const target = e.target as Element | null
    if (!target || !target.closest) return
    if (!target.closest('[data-type="outline"]')) return
    restoreFocus()
    const scroller = getMainScroller()
    if (!scroller) return
    const saved = scroller.scrollTop
    if (saved <= 0) return
    let restored = false
    const onScroll = () => {
      if (restored) return
      if (scroller.scrollTop === 0) { scroller.scrollTop = saved; restored = true }
    }
    scroller.addEventListener('scroll', onScroll, { passive: true })
    setTimeout(() => {
      scroller.removeEventListener('scroll', onScroll)
      // 最终兜底:500ms 后如果 scroll 仍是 0 且 saved > 0,直接拉回
      if (!restored && scroller.scrollTop === 0) scroller.scrollTop = saved
    }, 600)
  }, true)
}

// 目录增强:标题右侧注入"固定/浮动"切换按钮。每次 vditor 初始化都调(outline 元素会重建),按钮已存在则跳过。
export function setupOutlinePin() {
  const title = document.querySelector('.vditor-outline__title') as HTMLElement | null
  if (!title || title.querySelector('.vmd-outline-pin')) return
  const btn = document.createElement('button')
  btn.className = 'vmd-outline-pin'
  btn.type = 'button'
  // 单色图钉,靠形状区分状态(不靠颜色):固定=竖直图钉,浮动=斜置图钉。颜色始终一致。
  const PIN = 'M16 3v2h-1v6l2 2v2h-4v6l-1 1-1-1v-6H6v-2l2-2V5H7V3h9z'
  const ICON_PINNED = `<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="${PIN}"/></svg>`
  const ICON_UNPINNED = `<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><g transform="rotate(45 12 12)"><path d="${PIN}"/></g></svg>`
  const sync = () => {
    const pinned = document.body.classList.contains('outline-pinned')
    btn.innerHTML = pinned ? ICON_PINNED : ICON_UNPINNED
    btn.title = pinned ? '已固定(正文让位、点条目不收起)— 点击取消固定' : '浮动(浮在正文上、点条目自动收起)— 点击固定'
  }
  sync()
  btn.addEventListener('click', (e) => {
    e.preventDefault()
    e.stopPropagation()
    const pinned = document.body.classList.toggle('outline-pinned')
    try { localStorage.setItem('vditor-md.outlinePinned', pinned ? '1' : '0') } catch {}
    sync()
    // 浮动/停靠 切换改变了布局,触发 vditor 重算内容 padding/居中
    try { window.dispatchEvent(new Event('resize')) } catch {}
  }, true)
  title.appendChild(btn)
}

// 目录宽度调整:整条右缘做拖拽把手(替代原生右下角 resize)。拖动时屏蔽文本选中/滚动条拖动。宽度持久化。
export function setupOutlineResizer() {
  const outline = document.querySelector('.vditor-outline') as HTMLElement | null
  if (!outline || outline.querySelector('.vmd-outline-resizer')) return
  // 恢复上次宽度
  try {
    const w = localStorage.getItem('vditor-md.outlineWidth')
    if (w && +w >= 150 && +w <= 600) outline.style.width = w + 'px'
  } catch {}
  const resizer = document.createElement('div')
  resizer.className = 'vmd-outline-resizer'
  resizer.setAttribute('contenteditable', 'false')
  outline.appendChild(resizer)

  let dragging = false
  const onMove = (ev: MouseEvent) => {
    if (!dragging) return
    ev.preventDefault()  // 屏蔽拖动时的文本选中
    const rect = outline.getBoundingClientRect()
    const w = Math.max(150, Math.min(600, ev.clientX - rect.left))
    outline.style.width = w + 'px'
  }
  const onUp = () => {
    if (!dragging) return
    dragging = false
    document.body.style.userSelect = ''
    document.body.style.cursor = ''
    document.removeEventListener('mousemove', onMove, true)
    document.removeEventListener('mouseup', onUp, true)
    try { localStorage.setItem('vditor-md.outlineWidth', String(parseInt(outline.style.width, 10) || 250)) } catch {}
    try { window.dispatchEvent(new Event('resize')) } catch {}  // 停靠态:正文宽度跟着重算
  }
  resizer.addEventListener('mousedown', (e) => {
    e.preventDefault()       // 关键:阻止默认行为,不触发滚动条拖动/选中
    e.stopPropagation()
    dragging = true
    document.body.style.userSelect = 'none'
    document.body.style.cursor = 'ew-resize'
    document.addEventListener('mousemove', onMove, true)
    document.addEventListener('mouseup', onUp, true)
  }, true)
}

// 收起目录(优先调 vditor 自身 toggle 以同步工具栏按钮状态,失败再直接隐藏)
function hideOutline() {
  try {
    const v = (window as any).vditor
    if (v && v.vditor && v.vditor.outline && typeof v.vditor.outline.toggle === 'function') {
      v.vditor.outline.toggle(v.vditor, false)
      return
    }
  } catch {}
  const el = document.querySelector('.vditor-outline') as HTMLElement | null
  if (el) el.style.display = 'none'
}

// 浮动模式下的自动收起:① 点目录里的标题跳转项 → 跳转后收起;② 点目录以外任何地方 → 收起。
// 固定模式从不自动收起。document 级 capture 监听,绑一次即可(跨重建有效)。
let _outlineAutoHideBound = false
export function setupOutlineAutoHide() {
  if (_outlineAutoHideBound) return
  _outlineAutoHideBound = true
  document.addEventListener('click', (e) => {
    if (document.body.classList.contains('outline-pinned')) return  // 固定:从不自动收起
    const outline = document.querySelector('.vditor-outline') as HTMLElement | null
    if (!outline || getComputedStyle(outline).display === 'none') return  // 目录没显示,无需处理
    const t = e.target as Element | null
    if (!t || !t.closest) return
    // ① 点标题跳转项:vditor 自己的 click 会先跳转(它 stopPropagation,所以我们用 capture 抢在前面排定时器),
    //    setTimeout 0 让跳转这一轮事件跑完后立刻收起(体感即时)
    if (t.closest('.vditor-outline [data-target-id]')) { setTimeout(hideOutline, 0); return }
    // 点目录内部其它地方(折叠箭头 / 空白 / 拖拽 resize)→ 不收起
    if (t.closest('.vditor-outline')) return
    // 点工具栏目录按钮 → 交给 vditor 自己 toggle,别重复收起
    if (t.closest('[data-type="outline"]')) return
    // ② 点目录以外任何地方 → 收起
    hideOutline()
  }, true)
}

// toolbar 点击时保存配置
export function handleToolbarClick() {
  $(
    '.vditor-toolbar .vditor-panel--left button, .vditor-toolbar .vditor-panel--arrow button'
  ).on('click', (e) => {
    setTimeout(() => {
      saveVditorOptions()
    }, 500)
  })
}

export function fixLinkClick() {
  const openLink = (url: string) => {
    vscode.postMessage({ command: 'open-link', href: url })
  }
  document.addEventListener('click', e=> {
    let el = e.target as HTMLAnchorElement
    if (el.tagName === 'A') {
      openLink(el.href)
    }
  })
  window.open = (url: string, ...args: any[]) => {
    openLink(url)
    return window
  }
}


/** error:
 We don't execute document.execCommand() this time, because it is called recursively.
(anonymous) @ main.js:32449
(anonymous) @ main.js:842
(anonymous) @ host.js:27
see: https://github.com/nwjs/nw.js/issues/3403 */
export function fixCut() {
  let _exec = document.execCommand.bind(document)
  document.execCommand = (cmd, ...args) => {
    if (cmd === 'delete') {
      setTimeout(() => {
        return _exec(cmd, ...args)
      })
    } else {
      return _exec(cmd, ...args)
    }
  }
}
