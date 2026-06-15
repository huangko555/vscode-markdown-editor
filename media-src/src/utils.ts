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

// "折叠到前两层":嵌套深度≥2 的 li 的子 ul 折叠,只保留文档最高的两层标题。
// 用 vditor 原生的折叠机制(chevron 加 close class + 子 ul display:none),状态一致,后续手动展开仍正常。
function collapseOutlineToTopTwo() {
  const root = document.querySelector('.vditor-outline__content') as HTMLElement | null
  if (!root) return
  root.querySelectorAll('li').forEach((li) => {
    let depth = 0
    let p: Element | null = li.parentElement
    while (p && p !== root) {
      if (p.tagName === 'UL') depth++
      p = p.parentElement
    }
    // depth=1 顶层(最高级别), depth=2 次层。depth=2 的 li 的子 ul 折叠 → 仅保留前两层可见。
    const action = li.querySelector(':scope > span > .vditor-outline__action') as HTMLElement | null
    const sub = li.querySelector(':scope > ul') as HTMLElement | null
    if (!sub) return
    if (depth >= 2) {
      action && action.classList.add('vditor-outline__action--close')
      sub.setAttribute('style', 'display:none')
    } else {
      action && action.classList.remove('vditor-outline__action--close')
      sub.setAttribute('style', 'display:block')
    }
  })
}

// 全部展开:清掉所有 close 类、所有子 ul 设 display:block。
function expandAllOutline() {
  const root = document.querySelector('.vditor-outline__content') as HTMLElement | null
  if (!root) return
  root.querySelectorAll('.vditor-outline__action--close').forEach((a) => a.classList.remove('vditor-outline__action--close'))
  root.querySelectorAll('li > ul').forEach((ul) => (ul as HTMLElement).setAttribute('style', 'display:block'))
}

// 目录增强:标题右侧注入"折叠到两层 / 全部展开 / 固定切换"三个按钮(顺序固定)。
// 每次 vditor 初始化都调(outline 元素会重建),按钮已存在则跳过。
export function setupOutlinePin() {
  const title = document.querySelector('.vditor-outline__title') as HTMLElement | null
  if (!title || title.querySelector('.vmd-outline-actions')) return

  const actions = document.createElement('span')
  actions.className = 'vmd-outline-actions'

  // 折叠到前两层 — 双 chevron 朝中心(线条风格,跟图钉一致)
  const collapseBtn = document.createElement('button')
  collapseBtn.className = 'vmd-outline-action'
  collapseBtn.type = 'button'
  collapseBtn.title = '折叠到前两层'
  // Codicon collapse-all(VS Code 资源管理器同款,MIT 许可)
  collapseBtn.innerHTML = '<svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor"><path d="M14 4.27051C14.5999 4.62053 15 5.26009 15 6V11C15 13.21 13.21 15 11 15H6C5.26009 15 4.62053 14.5999 4.27051 14H11C12.65 14 14 12.65 14 11V4.27051Z"/><path d="M9.5 7C9.776 7 10 7.224 10 7.5C10 7.776 9.776 8 9.5 8H5.5C5.224 8 5 7.776 5 7.5C5 7.224 5.224 7 5.5 7H9.5Z"/><path fill-rule="evenodd" clip-rule="evenodd" d="M11 2C12.103 2 13 2.897 13 4V11C13 12.103 12.103 13 11 13H4C2.897 13 2 12.103 2 11V4C2 2.897 2.897 2 4 2H11ZM4 3C3.449 3 3 3.449 3 4V11C3 11.552 3.449 12 4 12H11C11.551 12 12 11.552 12 11V4C12 3.449 11.551 3 11 3H4Z"/></svg>'
  collapseBtn.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); collapseOutlineToTopTwo() }, true)

  // 全部展开 — 双 chevron 朝外
  const expandBtn = document.createElement('button')
  expandBtn.className = 'vmd-outline-action'
  expandBtn.type = 'button'
  expandBtn.title = '全部展开'
  // Codicon expand-all(同套图标,中间 + 表示展开)
  expandBtn.innerHTML = '<svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor"><path d="M15 6V11C15 13.21 13.21 15 11 15H6C5.26 15 4.62 14.6 4.27 14H11C12.65 14 14 12.65 14 11V4.27C14.6 4.62 15 5.26 15 6ZM11 13H4C2.897 13 2 12.103 2 11V4C2 2.897 2.897 2 4 2H11C12.103 2 13 2.897 13 4V11C13 12.103 12.103 13 11 13ZM4 12H11C11.551 12 12 11.552 12 11V4C12 3.449 11.551 3 11 3H4C3.449 3 3 3.449 3 4V11C3 11.552 3.449 12 4 12ZM9.5 7H8V5.5C8 5.224 7.776 5 7.5 5C7.224 5 7 5.224 7 5.5V7H5.5C5.224 7 5 7.224 5 7.5C5 7.776 5.224 8 5.5 8H7V9.5C7 9.776 7.224 10 7.5 10C7.776 10 8 9.776 8 9.5V8H9.5C9.776 8 10 7.776 10 7.5C10 7.224 9.776 7 9.5 7Z"/></svg>'
  expandBtn.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); expandAllOutline() }, true)

  // 固定/浮动图钉(原逻辑) — 靠形状区分状态:固定=竖直,浮动=斜置
  const pinBtn = document.createElement('button')
  pinBtn.className = 'vmd-outline-pin'
  pinBtn.type = 'button'
  const PIN = 'M16 3v2h-1v6l2 2v2h-4v6l-1 1-1-1v-6H6v-2l2-2V5H7V3h9z'
  const ICON_PINNED = `<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="${PIN}"/></svg>`
  const ICON_UNPINNED = `<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><g transform="rotate(45 12 12)"><path d="${PIN}"/></g></svg>`
  const syncPin = () => {
    const pinned = document.body.classList.contains('outline-pinned')
    pinBtn.innerHTML = pinned ? ICON_PINNED : ICON_UNPINNED
    pinBtn.title = pinned ? '已固定(正文让位、点条目不收起)— 点击取消固定' : '浮动(浮在正文上、点条目自动收起)— 点击固定'
  }
  syncPin()
  pinBtn.addEventListener('click', (e) => {
    e.preventDefault(); e.stopPropagation()
    const pinned = document.body.classList.toggle('outline-pinned')
    try { localStorage.setItem('vditor-md.outlinePinned', pinned ? '1' : '0') } catch {}
    syncPin()
    try { window.dispatchEvent(new Event('resize')) } catch {}  // 浮动/停靠切换:让 vditor 重算正文 padding
  }, true)

  actions.appendChild(collapseBtn)
  actions.appendChild(expandBtn)
  actions.appendChild(pinBtn)
  title.appendChild(actions)
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
  // ⚠️ 关键:必须插在 .vditor-outline__content 之前,确保 content 保持 lastElementChild。
  // vditor 的 outline.render 会把新 HTML 写到 this.element.lastElementChild,如果把 resizer
  // appendChild 到末尾,render 会写进 resizer 这条隐形 6px 条,目录列表永远不更新。
  const content = outline.querySelector('.vditor-outline__content')
  if (content) outline.insertBefore(resizer, content)
  else outline.appendChild(resizer)

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
    // ① 点 chevron 折叠/展开图标:vditor 自己处理折叠;我们既不收起也不跳转
    //    (chevron svg 在带 data-target-id 的外层 span 内部,必须先判断,否则会被下面 data-target-id 命中而误收起)
    if (t.closest('.vditor-outline__action')) return
    // ② 点标题跳转项:vditor 自己的 click 会先跳转(它 stopPropagation,所以我们用 capture 抢在前面排定时器),
    //    setTimeout 0 让跳转这一轮事件跑完后立刻收起(体感即时)
    if (t.closest('.vditor-outline [data-target-id]')) { setTimeout(hideOutline, 0); return }
    // 点目录内部其它地方(空白 / 拖拽 resize)→ 不收起
    if (t.closest('.vditor-outline')) return
    // 点工具栏目录按钮 → 交给 vditor 自己 toggle,别重复收起
    if (t.closest('[data-type="outline"]')) return
    // ③ 点目录以外任何地方 → 收起
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
