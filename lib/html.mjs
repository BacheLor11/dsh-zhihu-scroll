/**
 * lib/html.mjs —— 把知乎返回的富文本 HTML 变成给模型读的纯文本
 * ============================================================================
 * 只做「读得懂」这一件事：段落/换行/列表保留，图片留个 [图] 占位，
 * 链接保留文字，脚本样式注释全扔掉。不做 DOM 解析（宿主里没有 DOM，
 * 也不想为了这个引一个依赖）。
 * ============================================================================
 */

const NAMED = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  hellip: '…', mdash: '—', ndash: '–', middot: '·', bull: '•',
  ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’', laquo: '«', raquo: '»',
  copy: '©', reg: '®', trade: '™', times: '×', divide: '÷', plusmn: '±',
  deg: '°', sect: '§', para: '¶', dagger: '†', permil: '‰',
  euro: '€', pound: '£', yen: '¥', cent: '¢', curren: '¤',
  sup2: '²', sup3: '³', frac12: '½', frac14: '¼', frac34: '¾',
  inexact: '≈', asymp: '≈', ne: '≠', le: '≤', ge: '≥', equiv: '≡',
  infin: '∞', sum: '∑', prod: '∏', radic: '√', int: '∫', part: '∂',
  nabla: '∇', isin: '∈', notin: '∉', cap: '∩', cup: '∪', and: '∧', or: '∨',
  there4: '∴', sim: '∼', cong: '≅', tilde: '˜', prime: '′', Prime: '″',
  larr: '←', rarr: '→', uarr: '↑', darr: '↓', harr: '↔',
  ensp: ' ', emsp: ' ', thinsp: ' ', zwnj: '', zwj: '', lrm: '', rlm: '',
  shy: '', iexcl: '¡', iquest: '¿', micro: 'µ', middot: '·', times: '×',
}

/** 解 HTML 实体（命名 + 十进制 + 十六进制），坏实体原样留着 */
export function decodeEntities(text) {
  return String(text || '').replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]{1,31});/g, (all, body) => {
    if (body[0] === '#') {
      const hex = body[1] === 'x' || body[1] === 'X'
      const code = parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10)
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return all
      try { return String.fromCodePoint(code) } catch { return all }
    }
    return Object.prototype.hasOwnProperty.call(NAMED, body) ? NAMED[body] : all
  })
}

/**
 * HTML → 纯文本。
 * @param {string} html
 * @param {{maxChars?:number}} [opts]
 * @returns {string}
 */
export function htmlToText(html, opts = {}) {
  let s = String(html || '')

  // 脚本 / 样式 / 注释 / 内嵌数据 —— 整段扔掉
  s = s
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')

  // 图片 / 视频 / 公式：留占位，别让正文出现一串空行
  s = s
    .replace(/<img\b[^>]*>/gi, '[图]')
    .replace(/<video\b[^>]*>[\s\S]*?<\/video>/gi, '[视频]')
    .replace(/<math\b[^>]*>[\s\S]*?<\/math>/gi, '[公式]')

  // 块级元素 → 换行；列表项 → 圆点
  s = s
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|section|article|blockquote|pre|h[1-6]|tr|table|ul|ol|dl|figure|figcaption)\s*>/gi, '\n')
    .replace(/<(p|div|section|article|blockquote|pre|h[1-6]|tr|table|ul|ol|dl|figure|figcaption)\b[^>]*>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '\n· ')
    .replace(/<hr\s*\/?>/gi, '\n——\n')

  // 剩下所有标签剥掉；<a> 的文字保留
  s = s.replace(/<[^>]+>/g, '')
  s = decodeEntities(s)

  // 空白收拾：行内空格压成一个，空行最多留两行
  s = s
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t\f\v\u00a0]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()

  const max = Number(opts.maxChars)
  if (Number.isFinite(max) && max > 0 && s.length > max) {
    s = s.slice(0, max).trimEnd() + '\n…（后面还有，已截断）'
  }
  return s
}

/** 从正文里裁一段当摘要（给列表用，不抢正文的戏） */
export function plainExcerpt(html, max = 160) {
  const s = htmlToText(html, { maxChars: 0 }).replace(/\s+/g, ' ').trim()
  return s.length > max ? s.slice(0, max) + '…' : s
}
