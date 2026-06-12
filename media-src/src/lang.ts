const Langs = {
  en_US: {
    save: 'Save',
    copyMarkdown: 'Copy Markdown',
    copyHtml: 'Copy HTML',
    resetConfig: 'Reset config',
    toggleZebra: 'Toggle Table Zebra',
    toggleLineNumbers: 'Toggle Line Numbers',
    toggleSwatch: 'Toggle Color Swatch',
    resetConfirm: "Are you sure to reset the Vditor MD Editor's config?",
  },
  ja_JP: {
    save: '保存する',
  },
  ko_KR: {
    save: '저장',
  },
  zh_CN: {
    save: '保存',
    copyMarkdown: '复制 Markdown',
    copyHtml: '复制 HTML',
    resetConfig: '重置配置',
    toggleZebra: '表格条纹',
    toggleLineNumbers: '行号',
    toggleSwatch: '颜色色块',
    resetConfirm: '确定要重置 Vditor MD Editor 的配置么?',
  },
}

export const lang = (() => {
  let l: any = navigator.language.replace('-', '_')
  if (!Langs[l]) {
    l = 'en_US'
  }
  return l
})()

export function t(msg: string) {
  return (Langs[lang] && Langs[lang][msg]) || Langs.en_US[msg]
}
