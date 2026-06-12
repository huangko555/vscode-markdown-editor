import { t } from "./lang"
import { confirm } from "./utils"

export const toolbar = [
	'outline',
	{
		name: 'toggle-lineno',
		tipPosition: 's',
		tip: t('toggleLineNumbers'),
		className: 'vmd-lineno-btn',
		icon:
			'<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" width="32" height="32" fill="currentColor"><text x="1" y="8" font-size="7" font-family="ui-monospace,Menlo,monospace" font-weight="700">1</text><text x="1" y="15" font-size="7" font-family="ui-monospace,Menlo,monospace" font-weight="700">2</text><text x="1" y="22" font-size="7" font-family="ui-monospace,Menlo,monospace" font-weight="700">3</text><rect x="9" y="5" width="14" height="2"/><rect x="9" y="12" width="14" height="2"/><rect x="9" y="19" width="11" height="2"/></svg>',
		click() {
			document.body.classList.toggle('lineno-on')
			try { localStorage.setItem('vditor-md.lineno', document.body.classList.contains('lineno-on') ? '1' : '0') } catch {}
			// 两种模式(全开 / cursor)都靠同一套 data-source-line 注入,统一调 schedule 重建一遍 gutter overlay 或清空 overlay
			;(window as any).__attachLineNumbers && (window as any).__attachLineNumbers()
			// 顺便刷新 cursor 标记(关行号到 cursor 模式时,要立刻把光标所在行的行号显出来)
			;(window as any).__updateCursorMarker && (window as any).__updateCursorMarker()
		},
	},
	'|',
	'headings',
	'bold',
	'italic',
	'strike',
	'link',
	'|',
	'list',
	'ordered-list',
	'check',
	'outdent',
	'indent',
	'|',
	'quote',
	'line',
	'code',
	'inline-code',
	'insert-before',
	'insert-after',
	'|',
	'upload',
	'table',
	{
		name: 'more',
		tipPosition: 'e',
		toolbar: [
			'edit-mode',
			{
				name: 'toggle-zebra',
				icon: t('toggleZebra'),
				click() {
					const on = document.body.classList.toggle('zebra-on')
					try { localStorage.setItem('vditor-md.zebra', on ? '1' : '0') } catch {}
				},
			},
			{
				name: 'toggle-swatch',
				icon: t('toggleSwatch'),
				click() {
					const on = document.body.classList.toggle('swatch-on')
					try { localStorage.setItem('vditor-md.swatch', on ? '1' : '0') } catch {}
					if ((window as any).__refreshSwatches) (window as any).__refreshSwatches()
				},
			},
			'both',
			'code-theme',
			'content-theme',
			'preview',
			{
				name: 'copy-markdown',
				icon: t('copyMarkdown'),
				async click() {
					try {
						await navigator.clipboard.writeText(vditor.getValue())
						vscode.postMessage({
							command: 'info',
							content: 'Copy Markdown successfully!',
						})
					} catch (error) {
						vscode.postMessage({
							command: 'error',
							content: `Copy Markdown failed! ${error.message}`,
						})
					}
				},
			},
			{
				name: 'copy-html',
				icon: t('copyHtml'),
				async click() {
					try {
						await navigator.clipboard.writeText(vditor.getHTML())
						vscode.postMessage({
							command: 'info',
							content: 'Copy HTML successfully!',
						})
					} catch (error) {
						vscode.postMessage({
							command: 'error',
							content: `Copy HTML failed! ${error.message}`,
						})
					}
				},
			},
			{
				name: 'reset-config',
				icon: t('resetConfig'),
				async click() {
					confirm(t('resetConfirm'), async () => {
						try {
							await vscode.postMessage({
								command: 'reset-config',
							})
							await vscode.postMessage({
								command: 'ready',
							})
							vscode.postMessage({
								command: 'info',
								content: 'Reset config successfully!',
							})
						} catch (error) {
							vscode.postMessage({
								command: 'error',
								content: 'Reset config failed!',
							})
						}
					})
				},
			},
			'devtools',
			'info',
			'help',
		],
	},
].map((it: any) => {
	if (typeof it === 'string') {
		it = { name: it }
	}
	it.tipPosition = it.tipPosition || 's'
	return it
})
