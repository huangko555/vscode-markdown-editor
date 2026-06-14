import * as vscode from 'vscode'
import * as NodePath from 'path'
const KeyVditorOptions = 'vditor.options'
// 给 webview 资源 URL 加版本号,避免 VS Code webview 缓存旧 main.js/main.css。
// 模块加载时取一次:同一会话内稳定(可缓存),每次 Reload Window 扩展宿主重启 → 变化 → 强制取新构建。
const BUILD_ID = Date.now()

function debug(...args: any[]) {
  console.log(...args)
}

function showError(msg: string) {
  vscode.window.showErrorMessage(`[vditor-md] ${msg}`)
}

export function activate(context: vscode.ExtensionContext) {
  // Register original command (used by context menu/shortcuts)
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'vditor-md.openEditor',
      (uri?: vscode.Uri, ...args) => {
        debug('command', uri, args)
        EditorPanel.createOrShow(context, uri)
      }
    )
  )

  // Register CustomTextEditorProvider (for "Open With" and default editor)
  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(
      MarkdownEditorProvider.viewType,
      new MarkdownEditorProvider(context),
      {
        webviewOptions: {
          retainContextWhenHidden: true,
        },
        supportsMultipleEditorsPerDocument: false,
      }
    )
  )

  context.globalState.setKeysForSync([KeyVditorOptions])
}

/**
 * Manages cat coding webview panels
 */
class EditorPanel {
  /**
   * Track the currently panel. Only allow a single panel to exist at a time.
   */
  public static currentPanel: EditorPanel | undefined

  public static readonly viewType = 'vditor-md'

  private _disposables: vscode.Disposable[] = []

  public static async createOrShow(
    context: vscode.ExtensionContext,
    uri?: vscode.Uri
  ) {
    const { extensionUri } = context
    const column = vscode.window.activeTextEditor
      ? vscode.window.activeTextEditor.viewColumn
      : undefined
    if (EditorPanel.currentPanel && uri !== EditorPanel.currentPanel?._uri) {
      EditorPanel.currentPanel.dispose()
    }
    // If we already have a panel, show it.
    if (EditorPanel.currentPanel) {
      EditorPanel.currentPanel._panel.reveal(column)
      return
    }
    if (!vscode.window.activeTextEditor && !uri) {
      showError(`Did not open markdown file!`)
      return
    }
    let doc: undefined | vscode.TextDocument
    // From context menu: Find if there is a markdown editor for the current active TextEditor, if so bind the document
    if (uri) {
      // Open file from context menu: Open document first then enable auto-sync, otherwise cannot save file or sync to opened document
      doc = await vscode.workspace.openTextDocument(uri)
    } else {
      doc = vscode.window.activeTextEditor?.document
      // from command mode
      if (doc && doc.languageId !== 'markdown') {
        showError(
          `Current file language is not markdown, got ${doc.languageId}`
        )
        return
      }
    }

    if (!doc) {
      showError(`Cannot find markdown file!`)
      return
    }

    // Otherwise, create a new panel.
    const panel = vscode.window.createWebviewPanel(
      EditorPanel.viewType,
      'vditor-md',
      column || vscode.ViewColumn.One,
      EditorPanel.getWebviewOptions(uri)
    )

    EditorPanel.currentPanel = new EditorPanel(
      context,
      panel,
      extensionUri,
      doc,
      uri
    )
  }

  private static getFolders(): vscode.Uri[] {
    const data = []
    for (let i = 65; i <= 90; i++) {
      data.push(vscode.Uri.file(`${String.fromCharCode(i)}:/`))
    }
    return data
  }

  static getWebviewOptions(
    uri?: vscode.Uri
  ): vscode.WebviewOptions & vscode.WebviewPanelOptions {
    return {
      // Enable javascript in the webview
      enableScripts: true,

      localResourceRoots: [vscode.Uri.file("/"), ...this.getFolders()],
      retainContextWhenHidden: true,
      enableCommandUris: true,
    }
  }
  private get _fsPath() {
    return this._uri.fsPath
  }

  static get config() {
    return vscode.workspace.getConfiguration('vditor-md')
  }

  private constructor(
    private readonly _context: vscode.ExtensionContext,
    private readonly _panel: vscode.WebviewPanel,
    private readonly _extensionUri: vscode.Uri,
    public _document: vscode.TextDocument,
    public _uri = _document.uri // Opened from explorer, only uri exists, no _document
  ) {
    // Set the webview's initial html content

    this._init()

    // Listen for when the panel is disposed
    // This happens when the user closes the panel or when the panel is closed programmatically
    this._panel.onDidDispose(() => this.dispose(), null, this._disposables)
    let textEditTimer: NodeJS.Timeout | void
    // close EditorPanel when vsc editor is close
    vscode.workspace.onDidCloseTextDocument((e) => {
      if (e.fileName === this._fsPath) {
        this.dispose()
      }
    }, this._disposables)
    // re-init webview when VS Code theme changes
    vscode.window.onDidChangeActiveColorTheme((theme) => {
      this._update({
        type: 'init',
        options: {
          useVscodeThemeColor: EditorPanel.config.get<boolean>(
            'useVscodeThemeColor'
          ),
          ...this._context.globalState.get(KeyVditorOptions),
        },
        theme: theme.kind === vscode.ColorThemeKind.Dark ? 'dark' : 'light',
      })
    }, null, this._disposables)
    // update EditorPanel when vsc editor changes(含外部改文件后 VS Code 重载文档触发的变化)
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document.fileName !== this._document.fileName) {
        return
      }
      // 不再用 `if (panel.active) return` 守卫:那会导致用户盯着 vditor 看(面板聚焦)时外部改动全被丢弃。
      // 防回环改用内容比对——webview 自己回写后 _lastSyncedText 已等于文档内容,下面 timer 里比对相等即跳过。
      // (vditor.setValue 不触发 input 事件,不会再发 edit 回来,本就没有无限循环风险,active 守卫是多余的。)
      textEditTimer && clearTimeout(textEditTimer)
      textEditTimer = setTimeout(() => {
        const cur = this._document ? this._document.getText() : undefined
        if (cur === undefined || cur === this._lastSyncedText) return  // 自身回写 / 无变化 → 跳过
        this._update()
        this._updateEditTitle()
      }, 100)
    }, this._disposables)
    // 补课:面板重新可见时,若文档已比 webview 内容新(实时同步被 active 守卫丢掉、或外部改动期间面板不可见
    // 漏接),立即补推一次。webview 端走锚点还原,不丢滚动位置。内容一致则跳过,不做无谓刷新。
    this._panel.onDidChangeViewState(() => {
      if (this._panel.visible) {
        this._pollDisk()   // 立即查一次盘,补上隐藏期间的外部改动
        this._startPoll()
      } else {
        this._stopPoll()
      }
      if (!this._panel.visible) return
      const cur = this._document ? this._document.getText() : undefined
      if (cur === undefined || cur === this._lastSyncedText) return
      this._update()
      this._updateEditTitle()
    }, null, this._disposables)
    // 关键兜底:文件变更检测。onDidChangeTextDocument 只覆盖 VS Code 内编辑(原生编辑器);外部工具写盘
    // 走 FileSystemWatcher + 轮询。watcher 对普通写盘即时,对"临时文件+原子改名"可能漏(Windows),
    // 由轮询(_pollDisk,每秒 stat)兜底。三条都走去重 + dirty 安全锁,不会和 webview 自身编辑打架。
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(
        NodePath.dirname(this._fsPath),
        NodePath.basename(this._fsPath)
      )
    )
    watcher.onDidChange(() => this._syncFromDisk(), null, this._disposables)
    watcher.onDidCreate(() => this._syncFromDisk(), null, this._disposables)
    this._disposables.push(watcher)
    this._startPoll()  // 创建时面板可见,先把轮询开起来
    // Handle messages from the webview
    this._panel.webview.onDidReceiveMessage(
      async (message) => {
        debug('msg from webview review', message, this._panel.active)

        const syncToEditor = async () => {
          debug('sync to editor', this._document, this._uri)
          if (this._document) {
            const edit = new vscode.WorkspaceEdit()
            edit.replace(
              this._document.uri,
              new vscode.Range(0, 0, this._document.lineCount, 0),
              message.content
            )
            await vscode.workspace.applyEdit(edit)
          } else if (this._uri) {
            await vscode.workspace.fs.writeFile(this._uri, message.content)
          } else {
            showError(`Cannot find original file to save!`)
          }
        }
        switch (message.command) {
          case 'ready':
            this._update({
              type: 'init',
              options: {
                useVscodeThemeColor: EditorPanel.config.get<boolean>(
                  'useVscodeThemeColor'
                ),
                ...this._context.globalState.get(KeyVditorOptions),
              },
              theme:
                vscode.window.activeColorTheme.kind ===
                  vscode.ColorThemeKind.Dark
                  ? 'dark'
                  : 'light',
            })
            break
          case 'save-options':
            this._context.globalState.update(KeyVditorOptions, message.options)
            break
          case 'info':
            vscode.window.showInformationMessage(message.content)
            break
          case 'error':
            showError(message.content)
            break
          case 'edit': {
            // Only sync to VS Code editor when webview is in edit mode to avoid repeated refresh
            if (this._panel.active) {
              await syncToEditor()
              // webview 自己的编辑已写回文档,记下来,免得 viewstate 补课时误判成"漏掉的外部改动"再推回去
              this._lastSyncedText = this._document
                ? this._document.getText()
                : message.content
              this._updateEditTitle()
              // 同步完后立刻把 buffer 内容传给 webview 作为行号注入的源头(buffer 才是行号真相)
              this._panel.webview.postMessage({
                command: 'vscode-buffer',
                content: this._document ? this._document.getText() : '',
              })
            }
            break
          }
          case 'request-buffer': {
            // webview 主动要 buffer(初始 attach / Reload 时)
            this._panel.webview.postMessage({
              command: 'vscode-buffer',
              content: this._document ? this._document.getText() : '',
            })
            break
          }
          case 'reset-config': {
            await this._context.globalState.update(KeyVditorOptions, {})
            break
          }
          case 'debug-dump': {
            // webview 自动 dump 行号注入诊断到磁盘,Claude 直接读这个文件不用用户参与
            try {
              const debugPath = NodePath.join(this._context.globalStorageUri.fsPath, 'vditor-md-debug.json')
              await vscode.workspace.fs.createDirectory(this._context.globalStorageUri)
              await vscode.workspace.fs.writeFile(vscode.Uri.file(debugPath), Buffer.from(message.content || '', 'utf8'))
            } catch {}
            break
          }
          case 'save': {
            await syncToEditor()
            await this._document.save()
            // 记下已存盘内容,FileSystemWatcher 随后读到同样内容会跳过,不回推
            // (baseline 更新统一交给 onDidSaveTextDocument,覆盖 Ctrl+S / 自动保存等所有保存途径)
            this._lastSyncedText = this._document
              ? this._document.getText()
              : message.content
            this._updateEditTitle()
            break
          }
          case 'upload': {
            const assetsFolder = EditorPanel.getAssetsFolder(this._uri)
            try {
              await vscode.workspace.fs.createDirectory(
                vscode.Uri.file(assetsFolder)
              )
            } catch (error) {
              console.error(error)
              showError(`Invalid image folder: ${assetsFolder}`)
            }
            await Promise.all(
              message.files.map(async (f: any) => {
                const content = Buffer.from(f.base64, 'base64')
                return vscode.workspace.fs.writeFile(
                  vscode.Uri.file(NodePath.join(assetsFolder, f.name)),
                  content
                )
              })
            )
            const files = message.files.map((f: any) =>
              NodePath.relative(
                NodePath.dirname(this._fsPath),
                NodePath.join(assetsFolder, f.name)
              ).replace(/\\/g, '/')
            )
            this._panel.webview.postMessage({
              command: 'uploaded',
              files,
            })
            break
          }
          case 'open-link': {
            let url = message.href
            if (!/^http/.test(url)) {
              url = NodePath.resolve(this._fsPath, '..', url)
            }
            vscode.commands.executeCommand('vscode.open', vscode.Uri.parse(url))
            break
          }
        }
      },
      null,
      this._disposables
    )
  }

  static getAssetsFolder(uri: vscode.Uri) {
    const imageSaveFolder = (
      EditorPanel.config.get<string>('imageSaveFolder') || 'assets'
    )
      .replace(
        '${projectRoot}',
        vscode.workspace.getWorkspaceFolder(uri)?.uri.fsPath || ''
      )
      .replace('${file}', uri.fsPath)
      .replace(
        '${fileBasenameNoExtension}',
        NodePath.basename(uri.fsPath, NodePath.extname(uri.fsPath))
      )
      .replace('${dir}', NodePath.dirname(uri.fsPath))
    const assetsFolder = NodePath.resolve(
      NodePath.dirname(uri.fsPath),
      imageSaveFolder
    )
    return assetsFolder
  }

  public dispose() {
    EditorPanel.currentPanel = undefined

    this._stopPoll()
    // Clean up our resources
    this._panel.dispose()

    while (this._disposables.length) {
      const x = this._disposables.pop()
      if (x) {
        x.dispose()
      }
    }
  }

  private _init() {
    const webview = this._panel.webview

    this._panel.webview.html = this._getHtmlForWebview(webview)
    this._panel.title = NodePath.basename(this._fsPath)
  }
  private _isEdit = false
  // 最近一次与 webview 同步过的文档全文。用于面板重新可见时判断是否漏掉了外部改动(漏了才补推,
  // 避免无谓 setValue 重置 webview)。始终存"文档实际文本",规避 webview 回传内容与文档存储的细微差异。
  private _lastSyncedText: string | undefined
  private _updateEditTitle() {
    const isEdit = this._document.isDirty
    if (isEdit !== this._isEdit) {
      this._isEdit = isEdit
      this._panel.title = `${isEdit ? `[edit]` : ''}${NodePath.basename(
        this._fsPath
      )}`
    }
  }

  // private fileToWebviewUri = (f: string) => {
  //   return this._panel.webview.asWebviewUri(vscode.Uri.file(f)).toString()
  // }

  // 从磁盘读最新内容推给 webview(FileSystemWatcher / 轮询触发)。与 _lastSyncedText 比对去重,
  // 避免把我们自己刚保存的内容当外部改动回推。安全锁:文档有未保存改动(dirty)时不覆盖,免得冲掉没存的编辑。
  // 编辑中(dirty)检测到外部改盘时,只通知一次,不刷屏。变干净(保存)后重置,下次冲突可再通知。
  private _conflictNotified = false
  private async _syncFromDisk() {
    if (this._lastSyncedText === undefined) return  // 初始 init 还没跑,跳过
    let diskText: string
    try {
      const bytes = await vscode.workspace.fs.readFile(this._uri)
      diskText = Buffer.from(bytes).toString('utf8')
    } catch {
      return
    }
    if (diskText === this._lastSyncedText) return  // 无实际变化(含我们自己刚存盘的)
    // dirty 时不自动覆盖(免得冲掉未保存编辑),改为主动弹一次通知,让用户尽早知道有外部更新。
    // 真正的冲突解决仍在保存时交给 VS Code 原生冲突框(Compare/Overwrite)。
    if (this._document && this._document.isDirty) {
      if (!this._conflictNotified) {
        this._conflictNotified = true
        vscode.window.showWarningMessage('文件冲突！文件已在别的地方被修改，请注意处理。')
      }
      return
    }
    // 干净状态:正常采纳外部内容,并清掉通知标记
    this._conflictNotified = false
    this._lastSyncedText = diskText
    // 不带 type → webview 走 applyExternalUpdate(锚点还原滚动 + 同步注入行号)
    this._panel.webview.postMessage({ command: 'update', content: diskText })
    this._updateEditTitle()
  }

  // 主动轮询磁盘 mtime/size 兜底:外部"临时文件+原子改名"落盘会甩掉文件监听,轮询不依赖文件事件。
  // stat 极廉价,mtime/size 没变直接返回,变了才读盘比对。只在面板可见时跑。
  private _pollTimer: NodeJS.Timeout | undefined
  private _lastStatMtime = -1
  private _lastStatSize = -1
  private async _pollDisk() {
    let st: vscode.FileStat
    try {
      st = await vscode.workspace.fs.stat(this._uri)
    } catch {
      return
    }
    if (st.mtime === this._lastStatMtime && st.size === this._lastStatSize) return
    this._lastStatMtime = st.mtime
    this._lastStatSize = st.size
    this._syncFromDisk()
  }
  private _startPoll() {
    if (!this._pollTimer) this._pollTimer = setInterval(() => this._pollDisk(), 1000)
  }
  private _stopPoll() {
    if (this._pollTimer) {
      clearInterval(this._pollTimer)
      this._pollTimer = undefined
    }
  }

  private async _update(
    props: {
      type?: 'init' | 'update'
      options?: any
      theme?: 'dark' | 'light'
    } = { options: void 0 }
  ) {
    const md = this._document
      ? this._document.getText()
      : (await vscode.workspace.fs.readFile(this._uri)).toString()
    // const dir = NodePath.dirname(this._document.fileName)
    this._lastSyncedText = md
    this._panel.webview.postMessage({
      command: 'update',
      content: md,
      ...props,
    })
  }

  private _getHtmlForWebview(webview: vscode.Webview) {
    const toUri = (f: string) =>
      webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, f))
    const baseHref =
      NodePath.dirname(
        webview.asWebviewUri(vscode.Uri.file(this._fsPath)).toString()
      ) + '/'
    const toMediaPath = (f: string) => `media/dist/${f}`
    const JsFiles = ['main.js'].map(toMediaPath).map(toUri)
    const CssFiles = ['main.css'].map(toMediaPath).map(toUri)
    // 改过的 Lute(AST Node 加了 Line 字段):提前用 id="vditorLuteScript" 注入,
    // vditor addScript 看到 id 已存在会跳过它的远程 CDN 加载,用我们这份
    const luteUri = toUri(toMediaPath('lute.min.js'))

    return (
      `<!DOCTYPE html>
			<html lang="en">
			<head>
				<meta charset="UTF-8">

				<meta name="viewport" content="width=device-width, initial-scale=1.0">
				<base href="${baseHref}" />


				${CssFiles.map((f) => `<link href="${f}?v=${BUILD_ID}" rel="stylesheet">`).join('\n')}

				<title>markdown editor</title>
        <style>` +
      EditorPanel.config.get<string>('customCss') +
      `</style>
			</head>
			<body>
				<div id="app"></div>


				<script id="vditorLuteScript" src="${luteUri}?v=${BUILD_ID}"></script>
				${JsFiles.map((f) => `<script src="${f}?v=${BUILD_ID}"></script>`).join('\n')}
			</body>
			</html>`
    )
  }
}

/**
 * MarkdownEditorProvider implements CustomTextEditorProvider interface
 * Supports opening markdown files via "Open With"
 */
class MarkdownEditorProvider implements vscode.CustomTextEditorProvider {
  public static readonly viewType = 'vditor-md.customEditor'

  constructor(private readonly context: vscode.ExtensionContext) { }

  /**
   * Called when user selects Markdown Editor via "Open With"
   */
  public async resolveCustomTextEditor(
    document: vscode.TextDocument,
    webviewPanel: vscode.WebviewPanel,
    _token: vscode.CancellationToken
  ): Promise<void> {
    // Set webview options
    webviewPanel.webview.options = this.getWebviewOptions()

    // Init webview content
    const uri = document.uri
    webviewPanel.webview.html = this.getHtmlForWebview(webviewPanel.webview, uri)
    webviewPanel.title = NodePath.basename(uri.fsPath)

    const disposables: vscode.Disposable[] = []
    let isEditing = false
    // 最近一次与 webview 同步过的文档全文,用于面板重新可见时判断是否漏掉外部改动(见下方 onDidChangeViewState)
    let lastSyncedText: string | undefined = document.getText()

    // Update title to show edit status
    const updateEditTitle = () => {
      const isDirty = document.isDirty
      if (isDirty !== isEditing) {
        isEditing = isDirty
        webviewPanel.title = `${isDirty ? '[edit]' : ''}${NodePath.basename(uri.fsPath)}`
      }
    }

    // Send update to webview
    const updateWebview = (props: { type?: 'init' | 'update'; options?: any; theme?: 'dark' | 'light' } = {}) => {
      const md = document.getText()
      lastSyncedText = md
      webviewPanel.webview.postMessage({
        command: 'update',
        content: md,
        ...props,
      })
    }

    // Listen for document close
    vscode.workspace.onDidCloseTextDocument((e) => {
      if (e.fileName === uri.fsPath) {
        webviewPanel.dispose()
      }
    }, null, disposables)

    // Listen for document changes(含外部改文件后 VS Code 重载文档触发的变化)
    let docChangeTimer: NodeJS.Timeout | undefined
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document.fileName !== document.fileName) {
        return
      }
      // 不再用 `if (active) return` 守卫:那会导致用户盯着 vditor 看(面板聚焦)时外部改动被丢弃。
      // 防回环改用内容比对——webview 自己回写后 lastSyncedText 已等于文档内容,下面比对相等即跳过。
      // (vditor.setValue 不触发 input,不会再发 edit 回来,本无无限循环风险。)
      docChangeTimer && clearTimeout(docChangeTimer)
      docChangeTimer = setTimeout(() => {
        if (document.getText() === lastSyncedText) return  // 自身回写 / 无变化 → 跳过
        updateWebview()
        updateEditTitle()
      }, 100)
    }, null, disposables)

    // 从磁盘读最新内容推给 webview。与 lastSyncedText 比对去重(避免把自己刚保存的内容当外部改动回推)。
    // dirty 时不自动覆盖(保护未保存编辑),改为主动弹一次通知;真冲突解决在保存时交给 VS Code 原生框。
    let conflictNotified = false
    const syncFromDisk = async () => {
      let diskText: string
      try {
        diskText = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8')
      } catch {
        return
      }
      if (diskText === lastSyncedText) return  // 无实际变化(含自己刚存盘的)
      if (document.isDirty) {  // 编辑中 + 外部又改盘 → 通知一次,不覆盖
        if (!conflictNotified) {
          conflictNotified = true
          vscode.window.showWarningMessage('文件冲突！文件已在别的地方被修改，请注意处理。')
        }
        return
      }
      conflictNotified = false
      lastSyncedText = diskText
      // 不带 type → webview 走 applyExternalUpdate(锚点还原滚动 + 同步注入行号)
      webviewPanel.webview.postMessage({ command: 'update', content: diskText })
      updateEditTitle()
    }

    // 关键兜底:主动轮询磁盘 mtime/size。外部改动若用"临时文件+原子改名"落盘(zh-fix hook / 很多工具),
    // Windows 上会甩掉 FileSystemWatcher 和 VS Code 的文档重载;轮询不依赖文件事件,原子改名也会更新 mtime。
    // stat 极廉价,只在面板可见时跑;mtime/size 没变直接返回,变了才读盘比对。
    let lastStatMtime = -1
    let lastStatSize = -1
    let pollTimer: NodeJS.Timeout | undefined
    const pollDisk = async () => {
      let st: vscode.FileStat
      try {
        st = await vscode.workspace.fs.stat(uri)
      } catch {
        return
      }
      if (st.mtime === lastStatMtime && st.size === lastStatSize) return
      lastStatMtime = st.mtime
      lastStatSize = st.size
      syncFromDisk()
    }
    const startPoll = () => {
      if (!pollTimer) pollTimer = setInterval(pollDisk, 1000)
    }
    const stopPoll = () => {
      if (pollTimer) {
        clearInterval(pollTimer)
        pollTimer = undefined
      }
    }

    // FileSystemWatcher:对普通写盘是即时的(比轮询快),对原子改名可能漏 → 轮询兜底。两者都走 syncFromDisk 去重。
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(NodePath.dirname(uri.fsPath), NodePath.basename(uri.fsPath))
    )
    watcher.onDidChange(syncFromDisk, null, disposables)
    watcher.onDidCreate(syncFromDisk, null, disposables)
    disposables.push(watcher)

    // 面板可见时跑轮询并立即查一次盘(补上隐藏期间的外部改动);不可见时停轮询省资源。
    // 另外文档模型比 webview 新也补推一次(原生编辑器编辑路径)。
    webviewPanel.onDidChangeViewState(() => {
      if (webviewPanel.visible) {
        pollDisk()
        startPoll()
      } else {
        stopPoll()
      }
      if (!webviewPanel.visible) return
      if (document.getText() === lastSyncedText) return
      updateWebview()
      updateEditTitle()
    }, null, disposables)
    startPoll()  // 创建时面板可见,先把轮询开起来

    // Handle messages from webview
    webviewPanel.webview.onDidReceiveMessage(async (message) => {
      debug('msg from webview', message, webviewPanel.active)

      const syncToEditor = async () => {
        const edit = new vscode.WorkspaceEdit()
        edit.replace(
          document.uri,
          new vscode.Range(0, 0, document.lineCount, 0),
          message.content
        )
        await vscode.workspace.applyEdit(edit)
      }

      switch (message.command) {
        case 'ready':
          updateWebview({
            type: 'init',
            options: {
              useVscodeThemeColor: EditorPanel.config.get<boolean>('useVscodeThemeColor'),
              ...this.context.globalState.get(KeyVditorOptions),
            },
            theme: vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.Dark ? 'dark' : 'light',
          })
          break
        case 'save-options':
          this.context.globalState.update(KeyVditorOptions, message.options)
          break
        case 'info':
          vscode.window.showInformationMessage(message.content)
          break
        case 'error':
          showError(message.content)
          break
        case 'edit':
          if (webviewPanel.active) {
            await syncToEditor()
            // webview 自己的编辑已写回文档,记下来,免得 viewstate 补课时误判成漏掉的外部改动
            lastSyncedText = document.getText()
            updateEditTitle()
            webviewPanel.webview.postMessage({
              command: 'vscode-buffer',
              content: document.getText(),
            })
          }
          break
        case 'request-buffer':
          webviewPanel.webview.postMessage({
            command: 'vscode-buffer',
            content: document.getText(),
          })
          break
        case 'reset-config':
          await this.context.globalState.update(KeyVditorOptions, {})
          break
        case 'debug-dump': {
          try {
            const debugPath = NodePath.join(this.context.globalStorageUri.fsPath, 'vditor-md-debug.json')
            await vscode.workspace.fs.createDirectory(this.context.globalStorageUri)
            await vscode.workspace.fs.writeFile(vscode.Uri.file(debugPath), Buffer.from(message.content || '', 'utf8'))
          } catch {}
          break
        }
        case 'save':
          await syncToEditor()
          await document.save()
          // 记下已存盘内容,FileSystemWatcher 随后读到同样内容会跳过,不回推
          lastSyncedText = document.getText()
          updateEditTitle()
          break
        case 'upload': {
          const assetsFolder = EditorPanel.getAssetsFolder(uri)
          try {
            await vscode.workspace.fs.createDirectory(vscode.Uri.file(assetsFolder))
          } catch (error) {
            console.error(error)
            showError(`Invalid image folder: ${assetsFolder}`)
          }
          await Promise.all(
            message.files.map(async (f: any) => {
              const content = Buffer.from(f.base64, 'base64')
              return vscode.workspace.fs.writeFile(
                vscode.Uri.file(NodePath.join(assetsFolder, f.name)),
                content
              )
            })
          )
          const files = message.files.map((f: any) =>
            NodePath.relative(NodePath.dirname(uri.fsPath), NodePath.join(assetsFolder, f.name)).replace(/\\/g, '/')
          )
          webviewPanel.webview.postMessage({
            command: 'uploaded',
            files,
          })
          break
        }
        case 'open-link': {
          let url = message.href
          if (!/^http/.test(url)) {
            url = NodePath.resolve(uri.fsPath, '..', url)
          }
          vscode.commands.executeCommand('vscode.open', vscode.Uri.parse(url))
          break
        }
      }
    }, null, disposables)

    // Clean up resources
    webviewPanel.onDidDispose(() => {
      stopPoll()
      disposables.forEach((d) => d.dispose())
    })
  }

  private static getFolders(): vscode.Uri[] {
    const data = []
    for (let i = 65; i <= 90; i++) {
      data.push(vscode.Uri.file(`${String.fromCharCode(i)}:/`))
    }
    return data
  }

  private getWebviewOptions(): vscode.WebviewOptions {
    return {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.file('/'), ...MarkdownEditorProvider.getFolders()],
    }
  }

  private getHtmlForWebview(webview: vscode.Webview, uri: vscode.Uri): string {
    const toUri = (f: string) => webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, f))
    const baseHref = NodePath.dirname(webview.asWebviewUri(vscode.Uri.file(uri.fsPath)).toString()) + '/'
    const toMediaPath = (f: string) => `media/dist/${f}`
    const JsFiles = ['main.js'].map(toMediaPath).map(toUri)
    const CssFiles = ['main.css'].map(toMediaPath).map(toUri)
    // 改过的 Lute(AST Node 加了 Line 字段):提前用 id="vditorLuteScript" 注入,
    // vditor addScript 看到 id 已存在会跳过它的远程 CDN 加载,用我们这份
    const luteUri = toUri(toMediaPath('lute.min.js'))

    return (
      `<!DOCTYPE html>
			<html lang="en">
			<head>
				<meta charset="UTF-8">

				<meta name="viewport" content="width=device-width, initial-scale=1.0">
				<base href="${baseHref}" />


				${CssFiles.map((f) => `<link href="${f}?v=${BUILD_ID}" rel="stylesheet">`).join('\n')}

				<title>markdown editor</title>
        <style>` +
      EditorPanel.config.get<string>('customCss') +
      `</style>
			</head>
			<body>
				<div id="app"></div>


				<script id="vditorLuteScript" src="${luteUri}?v=${BUILD_ID}"></script>
				${JsFiles.map((f) => `<script src="${f}?v=${BUILD_ID}"></script>`).join('\n')}
			</body>
			</html>`
    )
  }
}
