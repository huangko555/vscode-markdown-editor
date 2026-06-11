import MarkdownIt from 'markdown-it'

// 用 markdown-it 解析源 md,提取每个块级 token 的源行号,扁平成"锚点列表",
// 再走 vditor 渲染的 DOM 拍平成"DOM 锚点列表",两个列表用双指针顺序匹配 + 文本校验对齐,
// 命中后把 1-based 源行号写到 data-source-line 属性上,CSS 用 ::after 渲染数字。
//
// 旧版按"DOM 树 vs token 树严格同位对齐"做递归,vditor 在某些编辑态下 DOM 局部结构会跟
// markdown-it 期望的结构有出入(比如插 wrapper、删空 p、tight list 不渲染 <p> 等等),
// 一旦递归对齐在某点错位,后续所有元素都拿不到 data-source-line。
// 现在的扁平顺序匹配只在错位的那一个元素上"跳过",下游能继续对齐。
const md = new MarkdownIt({ html: true, breaks: false })

// 锚点:一个可标行号的源块,带源行号、tag、首段净文本(用于校验匹配)
type Anchor = {
  lineStart: number
  lineEnd: number
  tag: string
  text: string
}

// 这些 tag 在 token / DOM 里都会被采集为锚点
const SHOWABLE_TAGS = new Set([
  'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'blockquote', 'ul', 'ol', 'li',
  'table', 'tr', 'hr', 'code',
])
// 容器型 tag 没有"自己的"文字(都是内部子锚点的文字),匹配时只校 tag 不校文本
const SKIP_TEXT_CHECK = new Set(['ul', 'ol', 'blockquote', 'table', 'hr', 'code'])

// 文本归一化:去空白 / 零宽字符,截前 20 字。不剥任何标记字符 —
// 之前试过开头剥 markdown 标记(-, *, 数字., > 等)误剥到合法内容(如 "0.1 → 0.2" 的开头),
// 导致大批锚点变空/超短后互相错配。改用 textsMatch 的"任意位置子串包含"做容错
function normalizeText(s: string): string {
  return (s || '').replace(/[\s​-‍﻿]+/g, '').slice(0, 30)
}

// 从 markdown-it inline token 的 children 里只取真正的可见字符,
// 跳过 **/_/`/[]()/链接 URL 等只是结构性 markdown 标记的部分
function extractInlinePureText(inline: any): string {
  if (!inline.children) return inline.content || ''
  let out = ''
  for (const child of inline.children) {
    if (out.length >= 30) break
    if (child.type === 'text' || child.type === 'code_inline') {
      out += child.content || ''
    } else if (child.type === 'softbreak' || child.type === 'hardbreak') {
      out += ' '
    }
    // emphasis_open/close, strong_open/close, link_open/close 等没 content,直接跳过
  }
  return out
}

// 把 markdown-it tokens 扁平成 Anchor 列表:遇到 open 块开锚点 + 占位等待文本,
// 后续出现的同层 inline token 的文字会回填到栈里所有还没填文本的开口锚点上
// (这样 li -> p -> inline 时,li 和 p 都拿到 inline 文本)
function getTokenAnchors(tokens: any[]): Anchor[] {
  const anchors: Anchor[] = []
  const openStack: Anchor[] = []
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]
    if (t.nesting === 1 && t.tag && SHOWABLE_TAGS.has(t.tag)) {
      const a: Anchor = {
        lineStart: t.map ? t.map[0] : 0,
        lineEnd: t.map ? t.map[1] : 0,
        tag: t.tag,
        text: '',
      }
      anchors.push(a)
      openStack.push(a)
    } else if (t.nesting === -1 && t.tag) {
      // 从栈里弹出最近一个同 tag 的开口锚点
      for (let k = openStack.length - 1; k >= 0; k--) {
        if (openStack[k].tag === t.tag) {
          openStack.splice(k, 1)
          break
        }
      }
    } else if (t.nesting === 0) {
      if ((t.type === 'fence' || t.type === 'code_block') && t.map) {
        anchors.push({
          lineStart: t.map[0],
          lineEnd: t.map[1],
          tag: 'code',
          text: normalizeText(t.content || ''),
        })
      } else if (t.type === 'hr' && t.map) {
        anchors.push({ lineStart: t.map[0], lineEnd: t.map[1], tag: 'hr', text: '' })
      } else if (t.type === 'inline' && openStack.length > 0) {
        const text = normalizeText(extractInlinePureText(t))
        // 回填栈里所有还没文本的开口锚点(li 和它内的 p 都得到同一段文字)
        for (const a of openStack) {
          if (!a.text) a.text = text
        }
      }
    }
  }
  return anchors
}

function isMarkerEl(el: Element): boolean {
  return el.classList && el.classList.contains('vditor-ir__marker')
}

// 走 DOM 取元素的首段净文本:跳过 vditor-ir__marker(里面是隐藏的 # > ** 等 markdown 标记字符)
function getDomFirstText(el: Element): string {
  let buf = ''
  function walk(n: Node): boolean {
    if (buf.length >= 30) return true
    if (n.nodeType === Node.TEXT_NODE) {
      buf += n.textContent || ''
      return false
    }
    if (n.nodeType === Node.ELEMENT_NODE) {
      const e = n as Element
      if (isMarkerEl(e)) return false
      for (let i = 0; i < e.childNodes.length; i++) {
        if (walk(e.childNodes[i])) return true
      }
    }
    return false
  }
  walk(el)
  return normalizeText(buf)
}

function isShowableDom(el: Element): boolean {
  const tag = el.tagName.toLowerCase()
  if (SHOWABLE_TAGS.has(tag) && tag !== 'code') return true
  if (tag === 'hr') return true
  // 代码块容器:vditor IR 渲染成 <div class="vditor-ir__node" data-type="code-block">
  if (tag === 'div' && (el.className || '').toString().indexOf('vditor-ir__node') >= 0) {
    if (el.getAttribute('data-type') === 'code-block') return true
  }
  return false
}

// DFS 走 root,按文档顺序拍平所有 isShowable 元素。
// 代码块/<pre> 内部不再下钻(里面是代码字符,不是块级锚点)
function getDomAnchors(root: HTMLElement): Element[] {
  const out: Element[] = []
  function walk(el: Element) {
    if (isShowableDom(el)) {
      out.push(el)
      const tag = el.tagName.toLowerCase()
      // 代码块作为锚点本身,内部不再要锚点
      if (tag === 'div') return
    }
    if (el.tagName.toLowerCase() === 'pre') return
    for (let i = 0; i < el.children.length; i++) {
      walk(el.children[i] as Element)
    }
  }
  for (let i = 0; i < root.children.length; i++) {
    walk(root.children[i] as Element)
  }
  return out
}

function matchesTag(domTag: string, tokTag: string): boolean {
  if (domTag === tokTag) return true
  // 代码块:token 的 'code' 对应 DOM 的 'div'(vditor IR)或 'pre'
  if (tokTag === 'code' && (domTag === 'div' || domTag === 'pre')) return true
  return false
}

// 文本是否相符
//   - 完全相等 / 一方是另一方前缀 → 相符
//   - 两边都空 → 相符(空 LI、空段落)
//   - 一边空一边非空 → 不相符(防止把空 token 错对到有文字的元素上)
function textsMatch(a: string, b: string): boolean {
  if (a === b) return true
  if (!a && !b) return true
  if (!a || !b) return false
  if (a.startsWith(b) || b.startsWith(a)) return true
  return false
}

function canMatch(dom: Element, tok: Anchor): boolean {
  const domTag = dom.tagName.toLowerCase()
  if (!matchesTag(domTag, tok.tag)) return false
  if (SKIP_TEXT_CHECK.has(tok.tag)) return true
  return textsMatch(getDomFirstText(dom), tok.text)
}

// 双指针顺序对齐:能匹配就同时进位;不能就前瞻 LOOKAHEAD 个看哪边能跳过,选距离小的一边跳。
// 两边都找不到 → 都进一步,放弃这一对(罕见,只在 DOM 跟源完全脱节时出现)
function alignAnchors(domAnchors: Element[], tokAnchors: Anchor[]): void {
  const LOOKAHEAD = 30
  let di = 0
  let ti = 0
  while (di < domAnchors.length && ti < tokAnchors.length) {
    const dom = domAnchors[di]
    const tok = tokAnchors[ti]

    if (canMatch(dom, tok)) {
      dom.setAttribute('data-source-line', String(tok.lineStart + 1))
      // 多行段落:overlay 渲染每源行的行号,attach 时需要 data-source-line-end
      if (tok.tag === 'p' && tok.lineEnd - tok.lineStart > 1) {
        dom.setAttribute('data-source-line-end', String(tok.lineEnd))
      }
      di++
      ti++
      continue
    }

    // 不能匹配:前瞻找哪边能跳过
    let domSkipTo = -1
    for (let k = di + 1; k < Math.min(di + 1 + LOOKAHEAD, domAnchors.length); k++) {
      if (canMatch(domAnchors[k], tok)) { domSkipTo = k; break }
    }
    let tokSkipTo = -1
    for (let k = ti + 1; k < Math.min(ti + 1 + LOOKAHEAD, tokAnchors.length); k++) {
      if (canMatch(dom, tokAnchors[k])) { tokSkipTo = k; break }
    }

    if (domSkipTo >= 0 && tokSkipTo >= 0) {
      // 两边都能跳:选步幅小的一边
      if (tokSkipTo - ti <= domSkipTo - di) ti = tokSkipTo
      else di = domSkipTo
    } else if (domSkipTo >= 0) {
      di = domSkipTo
    } else if (tokSkipTo >= 0) {
      ti = tokSkipTo
    } else {
      // 都找不到匹配,放弃这一对
      di++
      ti++
    }
  }
}

export function injectSourceLines(root: HTMLElement, source: string) {
  root.querySelectorAll('[data-source-line]').forEach((el) => el.removeAttribute('data-source-line'))
  root.querySelectorAll('[data-source-line-end]').forEach((el) => el.removeAttribute('data-source-line-end'))
  if (!source) return
  const tokens = md.parse(source, {})
  const tokAnchors = getTokenAnchors(tokens)
  const domAnchors = getDomAnchors(root)
  alignAnchors(domAnchors, tokAnchors)
}
