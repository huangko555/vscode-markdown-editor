import MarkdownIt from 'markdown-it'

// 用 markdown-it 解析源 md 拿每个块的 token.map([startLine,endLine]),递归对齐 vditor 渲染的 DOM 子树,
// 把 1-based 源行号写到 data-source-line 属性上;CSS 用 ::after 渲染数字
const md = new MarkdownIt({ html: true, breaks: false })

type BlockNode = { tag: string; lineStart: number; lineEnd: number; children: BlockNode[] }

// 扁平 token 序列 → 嵌套块树(保留父子关系,方便递归对齐 DOM)
// 特别地:thead/tbody 不入树(但要保持 nesting 平衡),让 tr 直接挂到 table 下,
// 这样跟 DOM 侧 innerCandidates 穿透 thead/tbody 的拍平对应得上
function buildBlockTree(tokens: any[]): BlockNode[] {
  const root: BlockNode = { tag: '__root__', lineStart: 0, lineEnd: 0, children: [] }
  const stack: BlockNode[] = [root]
  for (const tok of tokens) {
    const top = stack[stack.length - 1]
    if (tok.nesting === 1 && tok.tag) {
      if (tok.tag === 'thead' || tok.tag === 'tbody') {
        // 占位:不入 tree,但 push 让 -1 时 pop 能消掉
        stack.push(top)
        continue
      }
      const node: BlockNode = {
        tag: tok.tag,
        lineStart: tok.map ? tok.map[0] : top.lineStart,
        lineEnd: tok.map ? tok.map[1] : top.lineEnd,
        children: [],
      }
      top.children.push(node)
      stack.push(node)
    } else if (tok.nesting === -1) {
      if (stack.length > 1) stack.pop()
    } else if (tok.nesting === 0 && tok.map) {
      if (tok.type === 'fence' || tok.type === 'code_block') {
        top.children.push({ tag: 'code', lineStart: tok.map[0], lineEnd: tok.map[1], children: [] })
      } else if (tok.type === 'hr') {
        top.children.push({ tag: 'hr', lineStart: tok.map[0], lineEnd: tok.map[1], children: [] })
      }
    }
  }
  return root.children
}

// markdown-it 的 token.tag 与 DOM tagName 的宽松匹配
function matches(domTag: string, tokTag: string): boolean {
  if (domTag === tokTag) return true
  // 代码块:vditor IR 渲染成 <div class="vditor-ir__node" data-type="code-block">
  if (tokTag === 'code' && (domTag === 'div' || domTag === 'pre')) return true
  return false
}

// 只在这些 tag 上 set data-source-line 才会显示行号
// 排除 th/td(它们的 map 与 tr 重合,标了会跟 tr 行号视觉重叠)
function isShowable(el: Element): boolean {
  const tag = el.tagName.toLowerCase()
  if (
    [
      'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
      'blockquote', 'ul', 'ol', 'li',
      'table', 'tr', 'hr',
    ].indexOf(tag) >= 0
  ) return true
  // 代码块容器
  if (tag === 'div' && (el.className || '').toString().indexOf('vditor-ir__node') >= 0) return true
  return false
}

// vditor IR 模式把 markdown 标记(# > ** ` 等)装进 width:0 height:0 隐藏的 span 里
// 它不算"真子块",对齐时跳过
function isMarkerEl(el: Element): boolean {
  return el.classList && el.classList.contains('vditor-ir__marker')
}

// 一个块元素的"下一层候选":table 拍平 thead/tbody 直接拿 tr,其他元素就是 .children
function innerCandidates(el: Element): Element[] {
  const tag = el.tagName.toLowerCase()
  if (tag === 'table') {
    const out: Element[] = []
    for (let i = 0; i < el.children.length; i++) {
      const c = el.children[i] as Element
      const ct = c.tagName.toLowerCase()
      if (ct === 'thead' || ct === 'tbody') {
        for (let j = 0; j < c.children.length; j++) out.push(c.children[j] as Element)
      } else {
        out.push(c)
      }
    }
    return out
  }
  return Array.from(el.children) as Element[]
}

// 递归对齐:在 domEls 序列里按 source order 消费 blocks,返回消费了多少个 block
// 三类情况:
//   1) DOM 与当前 blk tag 匹配 → set + 递归子结构 + di++ bi++
//   2) DOM 是 vditor 加的 wrapper div(代码块外壳等)→ 进 div 子节点继续找当前 blocks
//   3) 其他不匹配的 DOM 元素(空 wbr、vditor 自己加的占位等)→ 跳过 dom
function align(domEls: Element[], blocks: BlockNode[]): number {
  let di = 0
  let bi = 0
  while (di < domEls.length && bi < blocks.length) {
    const dom = domEls[di]
    if (isMarkerEl(dom)) { di++; continue }
    const tag = dom.tagName.toLowerCase()
    // vditor IR 给源里的纯空行也渲染了空 <p> 占位,而 markdown-it 不为纯空行生成 token,
    // DOM 数量多于 token 数量 → 贪婪匹配会把后面段落的行号标到前面的空 p 上,真文字 p 反而漏标
    if (tag === 'p' && !(dom.textContent || '').trim()) { di++; continue }
    const blk = blocks[bi]
    if (matches(tag, blk.tag)) {
      if (isShowable(dom)) {
        dom.setAttribute('data-source-line', String(blk.lineStart + 1))
        // 段落跨多个源行(连续非空行,markdown-it 合成一个 paragraph token):
        // 标 end,让 main.ts 用 overlay 给每行单独显示行号
        if (tag === 'p' && blk.lineEnd - blk.lineStart > 1) {
          dom.setAttribute('data-source-line-end', String(blk.lineEnd))
        }
      }
      if (blk.children.length > 0) {
        align(innerCandidates(dom), blk.children)
      }
      di++
      bi++
    } else if (blk.tag === 'p' && tag !== 'p') {
      // tight list 里 markdown-it 仍生成 paragraph_open token,但 vditor IR 不渲染 <p>
      // (li 直接包文字)。跳过这个 p blk,让后面的 ul/ol 等能跟当前 dom 对齐
      bi++
    } else if (tag === 'div' && dom.children.length > 0) {
      // div wrapper(常见于代码块外壳、html block);进去递归找剩下的 blocks
      const consumed = align(Array.from(dom.children) as Element[], blocks.slice(bi))
      bi += consumed
      di++
    } else {
      di++
    }
  }
  return bi
}

export function injectSourceLines(root: HTMLElement, source: string) {
  root.querySelectorAll('[data-source-line]').forEach((el) => el.removeAttribute('data-source-line'))
  if (!source) return
  const tokens = md.parse(source, {})
  const tree = buildBlockTree(tokens)
  align(Array.from(root.children) as Element[], tree)
}
