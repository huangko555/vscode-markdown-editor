// Ctrl/Cmd+F 编辑器内搜索。
// 高亮用 CSS Custom Highlight API(CSS.highlights + Range):完全不改 DOM,
// 所以在 contenteditable 里不污染源码、不动光标,也不和行号/色块等 overlay 打架。
// 跳过 vditor 隐藏的 markdown 标记(.vditor-ir__marker),只搜可见文字。

import { getVisibleEditorRoot, getMainScroller } from './utils'

const HL_ALL = 'vmd-search'
const HL_CUR = 'vmd-search-current'
const MAX_MATCHES = 5000

let _bar: HTMLElement | null = null
let _input: HTMLInputElement | null = null
let _count: HTMLElement | null = null
let _ranges: Range[] = []
let _cur = -1
let _open = false

function supported(): boolean {
  return typeof (window as any).CSS !== 'undefined'
    && !!(CSS as any).highlights
    && typeof (window as any).Highlight === 'function'
}

function buildBar() {
  if (_bar) return
  _bar = document.createElement('div')
  _bar.className = 'vmd-search-bar'
  _bar.setAttribute('contenteditable', 'false')
  _bar.innerHTML =
    '<input class="vmd-search-input" type="text" placeholder="搜索" spellcheck="false">' +
    '<span class="vmd-search-count">0/0</span>' +
    '<button class="vmd-search-prev" title="上一个 (Shift+Enter)">▲</button>' +
    '<button class="vmd-search-next" title="下一个 (Enter)">▼</button>' +
    '<button class="vmd-search-close" title="关闭 (Esc)">✕</button>'
  document.body.appendChild(_bar)
  _input = _bar.querySelector('.vmd-search-input')
  _count = _bar.querySelector('.vmd-search-count')

  _input!.addEventListener('input', () => find(_input!.value))
  _input!.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Enter') { e.preventDefault(); e.shiftKey ? goto(_cur - 1) : goto(_cur + 1) }
    else if (e.key === 'Escape') { e.preventDefault(); close() }
  })
  _bar.querySelector('.vmd-search-prev')!.addEventListener('click', () => { goto(_cur - 1); _input!.focus() })
  _bar.querySelector('.vmd-search-next')!.addEventListener('click', () => { goto(_cur + 1); _input!.focus() })
  _bar.querySelector('.vmd-search-close')!.addEventListener('click', () => close())
}

function clearHighlights() {
  try {
    ;(CSS as any).highlights.delete(HL_ALL)
    ;(CSS as any).highlights.delete(HL_CUR)
  } catch {}
}

// 扫描可见文字,收集所有匹配的 Range(忽略大小写)
function collectMatches(query: string): Range[] {
  const ranges: Range[] = []
  const root = getVisibleEditorRoot()
  if (!root || !query) return ranges
  const q = query.toLowerCase()
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node: Node) {
      const p = (node as Text).parentElement
      if (!p || !node.textContent) return NodeFilter.FILTER_REJECT
      if (p.closest('.vditor-ir__marker')) return NodeFilter.FILTER_REJECT  // 隐藏的 md 标记
      return NodeFilter.FILTER_ACCEPT
    },
  } as any)
  let n: Node | null
  while ((n = walker.nextNode())) {
    const text = (n.textContent || '').toLowerCase()
    let idx = 0
    while ((idx = text.indexOf(q, idx)) !== -1) {
      try {
        const r = document.createRange()
        r.setStart(n, idx)
        r.setEnd(n, idx + q.length)
        ranges.push(r)
      } catch {}
      idx += q.length
      if (ranges.length >= MAX_MATCHES) return ranges
    }
  }
  return ranges
}

function find(query: string) {
  _ranges = collectMatches(query)
  clearHighlights()
  if (_ranges.length === 0) {
    _cur = -1
    updateCount()
    return
  }
  try { (CSS as any).highlights.set(HL_ALL, new (window as any).Highlight(..._ranges)) } catch {}
  // 默认定位到视口内/第一个匹配
  goto(0, true)
}

function updateCount() {
  if (_count) _count.textContent = _ranges.length ? `${_cur + 1}/${_ranges.length}` : '0/0'
}

// 滚到匹配处居中。优先用元素的 scrollIntoView(浏览器自动找正确滚动容器,比手动算 scrollTop 可靠);
// 拿不到元素再退回手动算 getMainScroller 的 scrollTop。不动光标。
function scrollRangeIntoView(range: Range) {
  const sc = range.startContainer
  const el: Element | null = sc.nodeType === Node.ELEMENT_NODE
    ? (sc as Element)
    : sc.parentElement
  if (el && typeof (el as any).scrollIntoView === 'function') {
    try { el.scrollIntoView({ block: 'center', inline: 'nearest' }); return } catch {}
  }
  const scroller = getMainScroller()
  if (!scroller) return
  const rect = range.getBoundingClientRect()
  const srect = scroller.getBoundingClientRect()
  if (rect.height > 0) {
    scroller.scrollTop += rect.top - srect.top - scroller.clientHeight / 2 + rect.height / 2
  }
}

function goto(idx: number, fromFind = false) {
  if (_ranges.length === 0) { updateCount(); return }
  // 循环
  _cur = ((idx % _ranges.length) + _ranges.length) % _ranges.length
  const range = _ranges[_cur]
  try { (CSS as any).highlights.set(HL_CUR, new (window as any).Highlight(range)) } catch {}
  scrollRangeIntoView(range)
  updateCount()
}

function open() {
  if (!supported()) {
    // 不支持 Highlight API 的旧内核:给个提示,不强行降级(避免污染 DOM)
    console.warn('[vditor-md] CSS Custom Highlight API 不可用,搜索高亮无法工作')
  }
  buildBar()
  _open = true
  _bar!.classList.add('vmd-search-bar--open')
  // 预填:编辑器里有选中文字就带进来
  const sel = window.getSelection()
  const selText = sel && !sel.isCollapsed ? sel.toString() : ''
  if (selText && selText.length < 100) _input!.value = selText
  _input!.focus()
  _input!.select()
  if (_input!.value) find(_input!.value)
}

function close() {
  _open = false
  clearHighlights()
  _ranges = []
  _cur = -1
  if (_bar) _bar.classList.remove('vmd-search-bar--open')
  // 焦点交回编辑器
  const root = getVisibleEditorRoot()
  if (root) (root as any).focus({ preventScroll: true })
}

export function initSearch() {
  // 捕获阶段拦 Ctrl/Cmd+F,阻止 webview 默认(无效的)查找,弹我们的搜索框
  document.addEventListener('keydown', (e: KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && (e.key === 'f' || e.key === 'F')) {
      e.preventDefault()
      e.stopPropagation()
      open()
    } else if (e.key === 'Escape' && _open) {
      e.preventDefault()
      close()
    }
  }, true)
}
