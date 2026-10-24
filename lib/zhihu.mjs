/**
 * lib/zhihu.mjs —— 知乎这一侧的「手」：Cookie、请求、热榜/推荐/关注、正文、评论
 * ============================================================================
 * 为什么用 Cookie：
 *   知乎没有面向个人的开放 API，网页端又上了风控（匿名请求会拿到验证页，
 *   热榜接口直接回 401「身份未经过验证」）。所以这里走的是**你自己的浏览器会话**：
 *   从浏览器 DevTools 里复制一条请求的 cURL（或 Cookie 头）粘进来，
 *   插件只在本机存这一串 Cookie，请求也只发往 www.zhihu.com。
 *
 * 设计口径：
 *   · 请求串行 + 350ms 间隔，不并发轰炸；
 *   · 401 = Cookie 失效/没登录；403+HTML = 被风控拦了；两者给不同的提示；
 *   · 所有条目先归一化成一个形状，正文转纯文本，模型只读纯文本；
 *   · 抓到的条目写进 items.json 缓存 —— v4 正文接口被拦时还能拿缓存兜底。
 * ============================================================================
 */
import { setTimeout as sleep } from 'node:timers/promises'
import { join } from 'node:path'
import { htmlToText, plainExcerpt } from './html.mjs'
import { keywordHit, matchDomains, parseUserRef } from './domains.mjs'
import { homeDir, log, maskCookie, readAuth, readJson, writeAuth, writeJson } from './state.mjs'

export const DEFAULT_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

const CONTENT_MAX = 16000
const CACHE_MAX = 80

export class ZhihuError extends Error {
  /**
   * @param {'no_auth'|'not_logged_in'|'challenge'|'forbidden'|'not_found'|'rate_limited'|'network'|'bad_response'} code
   * @param {string} message
   * @param {string} [hint]
   */
  constructor(code, message, hint) {
    super(message)
    this.name = 'ZhihuError'
    this.code = code
    this.hint = hint || ''
  }
}

const HINTS = {
  no_auth: '还没配知乎 Cookie：进 DSH 设置 →「刷知乎」→ 账号，点「从剪贴板导入」把浏览器里的 cURL 粘进来。',
  not_logged_in: 'Cookie 里没有有效的登录态（z_c0）。在浏览器里重新登录知乎，再复制一次 cURL。',
  challenge: '知乎的风控拦了这次请求（返回的是验证页）。先在浏览器里打开 zhihu.com 正常浏览一会儿、通过验证，再回来点「测一下」；短时间别连续重试。',
  forbidden: '知乎返回 403。可能是 Cookie 不完整、请求太频繁，或当前网络出口被限制。',
  not_found: '这条内容不存在，或已被删除/折叠。',
  rate_limited: '请求太频繁，被知乎限流了。等几分钟再试。',
  network: '请求没发出去（网络/代理/DNS）。检查一下本机能不能正常打开知乎。',
  bad_response: '知乎返回的不是预期的 JSON（可能又是风控页）。',
}

/** 统一的错误消息（带 hint） */
export function describeError(e) {
  if (e instanceof ZhihuError) return `${e.message}${e.hint ? `\n${e.hint}` : ''}`
  return String(e?.message ?? e)
}

/* ─────────────── Cookie 解析 ─────────────── */

function unquote(s) {
  return String(s || '').trim().replace(/^['"]|['"]$/g, '').trim()
}

/**
 * 解析用户粘进来的东西：cURL 命令 / `Cookie:` 头 / 裸 Cookie 串。
 * 只取 cookie 和 user-agent，其余（包括 Authorization）一概不碰、不存。
 *
 * @param {string} text
 * @returns {{cookie:string, userAgent:string, hasAuth:boolean, xsrf:string, source:'curl'|'header'|'raw'}}
 */
export function parseCookieInput(text) {
  const raw = String(text || '').trim()
  if (!raw) throw new ZhihuError('no_auth', '粘进来的内容是空的。', HINTS.no_auth)
  if (raw.length > 20000) throw new ZhihuError('no_auth', '粘进来的内容太长了（超过 20 KB），只复制 Cookie 那一行就行。')

  let cookie = ''
  let userAgent = ''
  let source = 'raw'

  // ① cURL：抓 -H/--header 里的 cookie / user-agent，也认 -b/--cookie
  if (/(^|\s)curl\s/i.test(raw) || /(^|\s)(-H|--header)\s/i.test(raw)) {
    source = 'curl'
    const flat = raw.replace(/\\\r?\n/g, ' ').replace(/\r?\n/g, ' ')
    const headerRe = /(?:-H|--header)\s+(['"])([\s\S]*?)\1/g
    let m
    while ((m = headerRe.exec(flat))) {
      const line = m[2]
      const i = line.indexOf(':')
      if (i <= 0) continue
      const name = line.slice(0, i).trim().toLowerCase()
      const value = line.slice(i + 1).trim()
      if (name === 'cookie') cookie = value
      if (name === 'user-agent') userAgent = value
    }
    if (!cookie) {
      const b = flat.match(/(?:-b|--cookie)\s+(['"])([\s\S]*?)\1/)
      if (b) cookie = b[2]
    }
  }

  // ② 带 `Cookie:` 的行 / 一整段请求头
  if (!cookie) {
    const lines = raw.split(/\r?\n/)
    for (const line of lines) {
      const m = line.match(/^\s*cookie\s*:\s*(.+)$/i)
      if (m) { cookie = m[1]; source = 'header'; break }
    }
    if (!cookie && lines.length > 1) {
      // 可能粘的是 DevTools 的「Copy as cURL (bash)」被截断后的纯头：逐行找 name: value
      for (const line of lines) {
        if (/^\s*user-agent\s*:/i.test(line)) userAgent = line.slice(line.indexOf(':') + 1).trim()
      }
    }
  }

  // ③ 裸 Cookie 串
  if (!cookie) {
    cookie = raw.replace(/^\s*cookie\s*:\s*/i, '')
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(cookie)) {
      throw new ZhihuError('no_auth', '这看起来是一个网址，不是 Cookie。', '在知乎页面按 F12 → Network → 右键任意请求 → Copy → Copy as cURL，再粘进来。')
    }
    source = 'raw'
  }

  cookie = unquote(cookie).replace(/\\u003b/gi, ';').replace(/[\r\n]+/g, ' ').trim()
  cookie = cookie.replace(/^cookie\s*:\s*/i, '')
  if (cookie.length > 8192) throw new ZhihuError('no_auth', 'Cookie 太长了（超过 8 KB），不像是正常的一条。')
  if (!cookie.includes('=')) {
    throw new ZhihuError('no_auth', '这段内容里没有 `name=value` 形式的 Cookie。', '复制时选「Copy as cURL」，不要只复制网页正文。')
  }

  const hasAuth = /(?:^|;\s*)z_c0=/.test(cookie)
  const xsrf = (cookie.match(/(?:^|;\s*)_xsrf=([^;]+)/) || [])[1] || ''
  return { cookie, userAgent: unquote(userAgent), hasAuth, xsrf, source }
}

/* ─────────────── 小工具 ─────────────── */

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const num = (v) => {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}
const str = (v) => (typeof v === 'string' ? v : '')

function looksLikeHtml(text, contentType = '') {
  const head = String(text || '').slice(0, 2000)
  return /text\/html/i.test(contentType)
    || /^\s*<!doctype html/i.test(head)
    || /<html[\s>]/i.test(head)
}

function looksLikeChallenge(text, contentType = '') {
  const s = String(text || '').slice(0, 20000)
  return /zh-zse-ck|acw_sc__v2|__jsl_clearance|var\s+arg1\s*=|安全验证|请开启\s*JavaScript|unhuman/i.test(s)
}

/** 从各种 URL / 裸 id 里认出「这是答案还是问题还是文章」 */
export function parseRef(ref) {
  const s = String(ref ?? '').trim()
  if (!s) throw new ZhihuError('not_found', '没给条目（id 或链接都是空的）。')
  let m = s.match(/zhihu\.com\/question\/(\d+)\/answer\/(\d+)/i)
  if (m) return { kind: 'answer', id: m[2], questionId: m[1] }
  m = s.match(/zhihu\.com\/answer\/(\d+)/i) || s.match(/^answer[\/:](\d+)$/i)
  if (m) return { kind: 'answer', id: m[1] }
  m = s.match(/zhihu\.com\/question\/(\d+)/i) || s.match(/^question[\/:](\d+)$/i)
  if (m) return { kind: 'question', id: m[1] }
  m = s.match(/zhuanlan\.zhihu\.com\/p\/(\d+)/i) || s.match(/zhihu\.com\/p\/(\d+)/i) || s.match(/^p[\/:](\d+)$/i)
  if (m) return { kind: 'article', id: m[1] }
  if (/^\d+$/.test(s)) return { kind: 'unknown', id: s }
  throw new ZhihuError('not_found', `认不出这个条目：${s.slice(0, 80)}`, '传知乎的回答/问题/文章链接，或纯数字 id。')
}

export function webUrlOf(kind, id, questionId) {
  if (kind === 'answer') return questionId
    ? `https://www.zhihu.com/question/${questionId}/answer/${id}`
    : `https://www.zhihu.com/answer/${id}`
  if (kind === 'question') return `https://www.zhihu.com/question/${id}`
  if (kind === 'article') return `https://zhuanlan.zhihu.com/p/${id}`
  return `https://www.zhihu.com/`
}

/** 按权重把 total 个名额分给若干来源（最大余数法） */
export function allocateQuotas(entries, total) {
  const n = Math.max(0, Math.floor(Number(total) || 0))
  const list = (Array.isArray(entries) ? entries : [])
    .map(([k, w]) => [String(k), Math.max(0, Number(w) || 0)])
    .filter(([, w]) => w > 0)
  if (n === 0 || list.length === 0) return []
  const sum = list.reduce((s, [, w]) => s + w, 0)
  const raw = list.map(([k, w]) => [k, (n * w) / sum])
  const out = raw.map(([k, v]) => [k, Math.floor(v)])
  let used = out.reduce((s, [, v]) => s + v, 0)
  const order = raw
    .map(([k, v], i) => ({ i, frac: v - Math.floor(v), w: list[i][1] }))
    .sort((a, b) => (b.frac - a.frac) || (b.w - a.w))
  let idx = 0
  while (used < n && order.length > 0) {
    out[order[idx % order.length].i][1] += 1
    used += 1
    idx += 1
  }
  return out.filter(([, v]) => v > 0)
}

/* ─────────────── 客户端 ─────────────── */

export class ZhihuClient {
  /**
   * @param {{home?:string, base?:string, gapMs?:number, timeoutMs?:number, logger?:(m:string)=>void}} [opts]
   */
  constructor(opts = {}) {
    this.home = opts.home || homeDir()
    this.base = (opts.base || process.env.ZHIHU_DUTY_API_BASE || 'https://www.zhihu.com').replace(/\/+$/, '')
    this.gapMs = opts.gapMs ?? 350
    this.timeoutMs = opts.timeoutMs ?? 20000
    this.logger = opts.logger || ((m) => log(this.home, m))
    this.lastAt = 0
    this.relatedCache = new Map()
  }

  auth() {
    return readAuth(this.home)
  }

  configured() {
    return Boolean(this.auth()?.cookie)
  }

  /** 保存用户粘进来的 Cookie；返回可展示的摘要（绝不回显 Cookie 本体） */
  setAuthFromText(text) {
    const parsed = parseCookieInput(text)
    const prev = this.auth()
    const auth = {
      cookie: parsed.cookie,
      userAgent: parsed.userAgent || prev?.userAgent || DEFAULT_UA,
      hasAuth: parsed.hasAuth,
      xsrf: parsed.xsrf,
      savedAt: new Date().toISOString(),
    }
    const ok = writeAuth(this.home, auth)
    if (!ok) throw new ZhihuError('network', 'Cookie 写不进插件家目录（检查一下磁盘/权限）。')
    this.logger(`已更新知乎 Cookie（${maskCookie(parsed.cookie)}，来源=${parsed.source}）`)
    return { ok: true, configured: true, hasAuth: parsed.hasAuth, fields: maskCookie(parsed.cookie), source: parsed.source }
  }

  headers(extra = {}) {
    const auth = this.auth()
    if (!auth?.cookie) throw new ZhihuError('no_auth', '还没配知乎 Cookie。', HINTS.no_auth)
    return {
      'user-agent': auth.userAgent || DEFAULT_UA,
      accept: 'application/json, text/plain, */*',
      'accept-language': 'zh-CN,zh;q=0.9,en;q=0.6',
      referer: 'https://www.zhihu.com/',
      origin: 'https://www.zhihu.com',
      'x-requested-with': 'XMLHttpRequest',
      'x-api-version': '3.0.91',
      cookie: auth.cookie,
      ...extra,
    }
  }

  /** 串行 + 最小间隔，避免把号刷进风控 */
  async pace() {
    const wait = this.gapMs - (Date.now() - this.lastAt)
    if (wait > 0) await sleep(wait)
    this.lastAt = Date.now()
  }

  /**
   * 发一个请求并解析 JSON。
   * @param {string} path 以 / 开头的知乎路径，或完整 URL
   * @param {{method?:string, body?:any, headers?:Record<string,string>}} [opts]
   */
  async request(path, opts = {}) {
    const url = /^https?:\/\//i.test(path) ? path : this.base + path
    await this.pace()
    const method = (opts.method || 'GET').toUpperCase()
    const headers = this.headers(opts.headers)
    let body
    if (opts.body !== undefined) {
      body = typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body)
      headers['content-type'] = 'application/json;charset=UTF-8'
    }

    let res
    try {
      res = await fetch(url, {
        method,
        headers,
        body,
        redirect: 'follow',
        signal: AbortSignal.timeout(this.timeoutMs),
      })
    } catch (e) {
      throw new ZhihuError('network', `请求知乎失败：${e?.message ?? e}`, HINTS.network)
    }

    const text = await res.text()
    const ct = res.headers.get('content-type') || ''

    if (res.status === 401) {
      throw new ZhihuError('not_logged_in', '知乎说：身份未经过验证（401）。', HINTS.not_logged_in)
    }
    if (res.status === 403) {
      if (looksLikeChallenge(text, ct)) throw new ZhihuError('challenge', '知乎返回了风控验证页（403）。', HINTS.challenge)
      throw new ZhihuError('forbidden', '知乎返回 403。', HINTS.forbidden)
    }
    if (res.status === 404) {
      throw new ZhihuError('not_found', '知乎返回 404：内容不存在或已删除。', HINTS.not_found)
    }
    if (res.status === 429) {
      throw new ZhihuError('rate_limited', '知乎返回 429（限流）。', HINTS.rate_limited)
    }
    if (!res.ok) {
      throw new ZhihuError('bad_response', `知乎返回 HTTP ${res.status}。`, '过一会儿再试；一直这样就把「诊断」里的日志发出来。')
    }
    if (!/json/i.test(ct) && (looksLikeChallenge(text, ct) || looksLikeHtml(text, ct))) {
      throw new ZhihuError('challenge', '知乎返回的是网页/验证页，不是 JSON。', HINTS.challenge)
    }
    if (text.trim() === '') return {}
    try {
      return JSON.parse(text)
    } catch {
      throw new ZhihuError('bad_response', '知乎返回的内容不是合法 JSON。', HINTS.bad_response)
    }
  }

  /* ───────── 列表 ───────── */

  async hot(limit = 12) {
    const n = Math.max(1, Math.min(50, Number(limit) || 12))
    const j = await this.request(`/api/v3/feed/topstory/hot-lists/total?limit=${n}&desktop=true`)
    const out = (Array.isArray(j?.data) ? j.data : []).map(normalizeHotItem).filter(Boolean)
    if (out.length) return out.slice(0, n)
    return normalizeFeed(j, { source: 'hot' }).slice(0, n)
  }

  async recommend(limit = 12) {
    const n = Math.max(1, Math.min(30, Number(limit) || 12))
    const j = await this.request(`/api/v3/feed/topstory/recommend?action=down&ad_interval=-10&desktop=true&page_number=1&limit=${n}`)
    return normalizeFeed(j, { source: 'recommend' }).slice(0, n)
  }

  async following(limit = 12) {
    const n = Math.max(1, Math.min(30, Number(limit) || 12))
    const j = await this.request(`/api/v3/feed/topstory?action=down&limit=${n}&desktop=true`)
    return normalizeFeed(j, { source: 'following' }).slice(0, n)
  }

  /**
   * 按设置里的「来源权重」捞一轮候选：
   *   推荐流 / 热榜 / 关注动态 / 关注的人，按权重比例分配名额，
   *   再按「领域权重 + 额外关键词 + 来源权重 + 互动量」排序。
   * @param {{limit?:number, cfg?:any}} [opts]
   */
  async collect({ limit = 12, cfg = {} } = {}) {
    const n = Math.max(1, Math.min(30, Number(limit) || 12))
    const weights = cfg?.sources && typeof cfg.sources === 'object' ? cfg.sources : { recommend: 3, hot: 2, following: 4, followingUsers: 3 }
    let active = Object.entries(weights)
      .filter(([k]) => ['recommend', 'hot', 'following', 'followingUsers'].includes(k))
      .map(([k, w]) => [k, Math.max(0, Number(w) || 0)])
      .filter(([, w]) => w > 0)
    if (active.length === 0) active = [['recommend', 1]]

    const quotas = allocateQuotas(active, n)
    const errors = []
    const items = []
    for (const [source, q] of quotas) {
      if (q <= 0) continue
      try {
        if (source === 'hot') {
          // 热榜是全网榜；一次取 30 条，按用户领域/关键词挑 q 条，
          // 避免热榜前两条总是体育/娱乐，AI/科技热榜沉在下面看不到。
          const pool = await this.hot(30)
          const picked = pool.map((it) => {
            const text = `${it.title}\n${it.excerpt}`
            const { score } = matchDomains(text, cfg?.domains || {})
            const kw = (cfg?.keywords || []).filter((k) => keywordHit(text.toLowerCase(), k)).length
            return { it, fit: score + kw * 2 }
          }).sort((a, b) => (b.fit - a.fit) || ((Number(b.it.heat) || 0) - (Number(a.it.heat) || 0)))
          items.push(...picked.slice(0, q).map((x) => x.it))
        }
        else if (source === 'following') items.push(...await this.following(q))
        else if (source === 'followingUsers') items.push(...await this.followingUsers(q, cfg?.followingUsers || []))
        else items.push(...await this.recommend(q))
      } catch (e) {
        errors.push({ source, code: e?.code || 'error', error: describeError(e) })
      }
    }
    if (items.length === 0 && errors.length) {
      throw new ZhihuError(errors[0].code === 'error' ? 'network' : errors[0].code, errors[0].error,
        '所有来源都没拿到东西。先点「测一下」看看是哪条链路被拦了。')
    }

    const ranked = dedupe(items).map((it) => {
      const text = `${it.title}\n${it.excerpt}\n${it.content || ''}`
      const { ids, score } = matchDomains(text, cfg?.domains || {})
      const kw = (cfg?.keywords || []).filter((k) => keywordHit(text.toLowerCase(), k)).length
      const src = Number(weights[it.source]) || 0
      const heat = Number(it.heat) || 0
      const eng = Math.min(6,
        Math.log10((it.votes || 0) + 1)
        + Math.log10((it.comments || 0) + 1) * 0.5
        + (heat > 0 ? Math.min(2.5, Math.log10(heat + 1) * 0.4) : 0))
      return { ...it, domains: ids, score: score * 2 + kw * 2 + src + eng }
    }).sort((a, b) => (b.score - a.score) || (b.votes - a.votes))

    for (const it of ranked) this.remember(it)
    return { items: ranked.slice(0, n), errors, quotas }
  }

  /**
   * 按单个来源捞（给 zhihu_feed 的显式 source 用；不传 source 就走 collect 的权重）。
   */
  async feed({ source = 'mixed', limit = 12, followingUsers: users = [] } = {}) {
    const n = Math.max(1, Math.min(30, Number(limit) || 12))
    const half = Math.max(1, Math.ceil(n / 2))
    let items = []
    if (source === 'hot') items = await this.hot(n)
    else if (source === 'recommend') items = await this.recommend(n)
    else if (source === 'following') items = await this.following(n)
    else if (source === 'followingUsers') items = await this.followingUsers(n, users)
    else {
      const errors = []
      try { items.push(...await this.recommend(half)) } catch (e) { errors.push(e) }
      try { items.push(...await this.hot(n - half)) } catch (e) { errors.push(e) }
      if (items.length === 0 && errors.length) throw errors[0]
    }
    items = dedupe(items).slice(0, n)
    for (const it of items) this.remember(it)
    return items
  }

  /* ───────── 关注的人 ───────── */

  /** 我的关注列表（url_token），按天缓存；拿不到就返回空 */
  async followees(limit = 12) {
    const n = Math.max(1, Math.min(50, Number(limit) || 12))
    const file = join(this.home, 'followees.json')
    const today = new Date().toISOString().slice(0, 10)
    let token = String(this.auth()?.urlToken || '')
    if (!token) token = String((await this.me()).urlToken || '')
    if (!token) return []
    const cached = readJson(file, null)
    if (cached && cached.day === today && cached.token === token && Array.isArray(cached.users)) {
      return cached.users.slice(0, n)
    }
    const j = await this.request(`/api/v4/members/${encodeURIComponent(token)}/followees?limit=${n}&offset=0`)
    const users = (Array.isArray(j?.data) ? j.data : [])
      .map((x) => parseUserRef(x?.url_token || x?.id || ''))
      .filter(Boolean)
    writeJson(file, { day: today, token, users })
    return users
  }

  /** 主动翻一个人最近的回答 + 文章（各最多 2 条） */
  async memberContent(token, limit = 4) {
    const n = Math.max(1, Math.min(10, Number(limit) || 4))
    const who = parseUserRef(token)
    if (!who) return []
    const out = []
    let firstError = null
    try {
      const j = await this.request(`/api/v4/members/${encodeURIComponent(who)}/answers?include=data[*].content,excerpt,voteup_count,comment_count,author.name,question.title,question.id,created_time&limit=${n}&offset=0&sort_by=created`)
      for (const a of (Array.isArray(j?.data) ? j.data : [])) {
        const it = normalizeItem({ ...a, type: 'answer' })
        if (!it.id) continue
        it.source = 'followingUsers'
        out.push(it)
      }
    } catch (e) { firstError = e }
    try {
      const j = await this.request(`/api/v4/members/${encodeURIComponent(who)}/articles?include=data[*].content,excerpt,voteup_count,comment_count,author.name,title,created&limit=${n}&offset=0&sort_by=created`)
      for (const a of (Array.isArray(j?.data) ? j.data : [])) {
        const it = normalizeItem({ ...a, type: 'article' })
        if (!it.id) continue
        it.source = 'followingUsers'
        out.push(it)
      }
    } catch (e) { if (!firstError) firstError = e }
    for (const it of out) this.remember(it)
    if (out.length === 0 && firstError) throw firstError
    return out
  }

  /** 关注的人：显式名单优先，否则用关注列表；每人最多 2 条，最多翻 6 个人 */
  async followingUsers(limit = 6, explicit = []) {
    const n = Math.max(1, Math.min(20, Number(limit) || 6))
    let users = (Array.isArray(explicit) ? explicit : []).map(parseUserRef).filter(Boolean)
    if (users.length === 0) {
      try {
        users = await this.followees(12)
      } catch (e) {
        this.logger(`关注列表读不到（${e?.code ?? e}），用关注动态兜底`)
        return this.following(n)
      }
    }
    if (users.length === 0) {
      this.logger('关注列表是空的，用关注动态兜底')
      return this.following(n)
    }
    const per = Math.max(1, Math.min(2, Math.ceil(n / Math.min(users.length, 6))))
    const out = []
    let firstError = null
    for (const token of users.slice(0, 6)) {
      if (out.length >= n) break
      try {
        const items = await this.memberContent(token, Math.min(per, n - out.length))
        out.push(...items)
      } catch (e) { if (!firstError) firstError = e }
    }
    if (out.length === 0 && firstError) throw firstError
    return out.slice(0, n)
  }

  /* ───────── 正文 ───────── */

  /**
   * 读一条的详情。答案/文章给全文；问题给前几条回答。
   * @param {string|{kind:string,id:string,questionId?:string}} ref
   */
  async item(ref, opts = {}) {
    const parsed = typeof ref === 'object' && ref ? ref : parseRef(ref)
    let kind = parsed.kind
    if (kind === 'unknown') {
      // 光给数字时，先当回答试（最常见），失败再当问题试
      for (const k of ['answer', 'question', 'article']) {
        try { return await this.item({ kind: k, id: parsed.id }, opts) } catch (e) {
          if (!(e instanceof ZhihuError) || !['not_found', 'challenge', 'forbidden'].includes(e.code)) throw e
          if (e.code !== 'not_found') break
        }
      }
      throw new ZhihuError('not_found', `找不到 id=${parsed.id} 的内容。`)
    }

    try {
      if (kind === 'question') return await this.question(parsed.id)
      if (kind === 'article') return await this.article(parsed.id)
      return await this.answer(parsed.id, opts)
    } catch (e) {
      // v4 被风控/没权限时，拿缓存兜底；缓存也没有再把原错误抛出去
      const cached = this.fromCache(kind, parsed.id)
      if (cached && (cached.content || cached.excerpt)) {
        this.logger(`正文接口失败（${e?.code ?? e}），用缓存兜底：${kind}/${parsed.id}`)
        return { ...cached, fromCache: true, warning: describeError(e) }
      }
      throw e
    }
  }

  /**
   * 同问题下其他高赞回答（默认带 3 条，5 分钟内缓存；不占主条目的额度）。
   * @param {string} qid
   * @param {{excludeId?:string, limit?:number, title?:string}} [opts]
   */
  async questionAnswers(qid, { excludeId = '', limit = 3, title = '' } = {}) {
    const n = Math.max(1, Math.min(5, Number(limit) || 3))
    const key = String(qid)
    const now = Date.now()
    let cached = this.relatedCache.get(key)
    if (!cached || now - cached.at > 5 * 60_000) {
      const j = await this.request(`/api/v4/questions/${encodeURIComponent(qid)}/answers?include=data[*].content,excerpt,voteup_count,comment_count,author.name,created_time&limit=${n + 2}&offset=0&sort_by=default`)
      const items = (Array.isArray(j?.data) ? j.data : []).map((a) => {
        const it = normalizeItem({ ...a, type: 'answer' })
        const id = String(it.id || a.id || '')
        return {
          id,
          title: title || it.title || '',
          url: id ? webUrlOf('answer', id, qid) : '',
          author: it.author,
          votes: it.votes,
          comments: it.comments,
          excerpt: it.excerpt,
          content: htmlToText(a.content || a.excerpt || '', { maxChars: 1500 }),
        }
      }).filter((x) => x.id)
      cached = { at: now, items }
      this.relatedCache.set(key, cached)
    }
    return cached.items.filter((x) => String(x.id) !== String(excludeId)).slice(0, n)
  }

  async answer(id, opts = {}) {
    const j = await this.request(`/api/v4/answers/${encodeURIComponent(id)}?include=content,excerpt,voteup_count,comment_count,author.name,question.title,question.id,created_time,updated_time`)
    const it = normalizeItem(j)
    if (!it.id) it.id = String(id)
    if (it.kind !== 'answer') it.kind = 'answer'
    it.content = htmlToText(j.content || j.excerpt || '', { maxChars: CONTENT_MAX })
    it.contentHtml = undefined
    if (!it.excerpt) it.excerpt = plainExcerpt(j.content || j.excerpt || '')
    const qid = String(j.question?.id || it.questionId || '')
    if (opts.related !== false && qid) {
      try {
        it.relatedAnswers = await this.questionAnswers(qid, {
          excludeId: it.id,
          limit: 3,
          title: it.title,
        })
      } catch (e) {
        it.relatedWarning = describeError(e)
      }
    }
    return this.remember(it)
  }

  async article(id) {
    const j = await this.request(`/api/v4/articles/${encodeURIComponent(id)}?include=content,excerpt,voteup_count,comment_count,author.name,title,created,updated`)
    const it = normalizeItem({ ...j, type: 'article' })
    it.kind = 'article'
    if (!it.id) it.id = String(id)
    it.content = htmlToText(j.content || j.excerpt || '', { maxChars: CONTENT_MAX })
    if (!it.excerpt) it.excerpt = plainExcerpt(j.content || j.excerpt || '')
    return this.remember(it)
  }

  async question(id) {
    let meta = {}
    try {
      meta = await this.request(`/api/v4/questions/${encodeURIComponent(id)}?include=detail,excerpt,answer_count,follower_count,visit_count,created,updated`)
    } catch (e) {
      if (!(e instanceof ZhihuError) || !['challenge', 'forbidden', 'not_found'].includes(e.code)) throw e
    }
    let answersRaw = []
    try {
      const j = await this.request(`/api/v4/questions/${encodeURIComponent(id)}/answers?include=data[*].content,excerpt,voteup_count,comment_count,author.name,created_time&limit=3&offset=0&sort_by=default`)
      answersRaw = Array.isArray(j?.data) ? j.data : []
    } catch (e) {
      if (!(e instanceof ZhihuError) || !['challenge', 'forbidden'].includes(e.code)) throw e
    }
    if (!meta?.title && answersRaw.length === 0) {
      throw new ZhihuError('not_found', `问题 ${id} 拿不到内容。`, '可能是问题不存在，或这条 Cookie 没权限。')
    }
    const answers = answersRaw.map((a) => {
      const n = normalizeItem({ ...a, type: 'answer' })
      return {
        id: n.id,
        author: n.author,
        votes: n.votes,
        comments: n.comments,
        url: n.url,
        content: htmlToText(a.content || a.excerpt || '', { maxChars: 6000 }),
      }
    })
    const base = normalizeItem({ ...meta, type: 'question', id, question: { id, title: meta.title } })
    const it = {
      ...base,
      kind: 'question',
      id: String(id),
      title: meta.title || base.title || `问题 ${id}`,
      excerpt: plainExcerpt(meta.detail || meta.excerpt || '', 200),
      content: htmlToText(meta.detail || meta.excerpt || '', { maxChars: CONTENT_MAX }),
      answerCount: num(meta.answer_count) || undefined,
      followerCount: num(meta.follower_count) || undefined,
      visitCount: num(meta.visit_count) || undefined,
      answers,
      url: webUrlOf('question', id),
    }
    return this.remember(it)
  }

  async comments(ref, limit = 20) {
    const parsed = typeof ref === 'object' && ref ? ref : parseRef(ref)
    const kind = parsed.kind === 'unknown' ? 'answer' : parsed.kind
    if (kind === 'question') throw new ZhihuError('not_found', '问题是不能直接看评论的，传某一条回答的链接。')
    const n = Math.max(1, Math.min(50, Number(limit) || 20))
    const j = await this.request(`/api/v4/${kind === 'article' ? 'articles' : 'answers'}/${encodeURIComponent(parsed.id)}/comments?include=data[*].content,author.name,vote_count,created_time,reply_count&limit=${n}&offset=0&order=normal`)
    const rows = Array.isArray(j?.data) ? j.data : []
    return rows.map((c) => ({
      id: String(c.id ?? ''),
      author: str(c.author?.name) || '匿名用户',
      content: htmlToText(c.content || '', { maxChars: 1200 }),
      votes: num(c.vote_count),
      replies: num(c.reply_count),
      created: num(c.created_time),
    }))
  }

  /* ───────── 账号 ───────── */

  async me() {
    const j = await this.request('/api/v4/me?include=name,url_token,headline,gender,avatar_url')
    return {
      name: str(j.name) || str(j.url_token) || '',
      urlToken: str(j.url_token),
      headline: str(j.headline),
    }
  }

  /* ───────── 诊断 ───────── */

  /** 「测一下」：逐项报告哪条链路能走通，失败也给下一步 */
  async test() {
    const items = []
    const push = (name, ok, detail, hint) => items.push({ name, ok, detail: String(detail || ''), hint: hint || '' })
    const auth = this.auth()
    push('已配置 Cookie', Boolean(auth?.cookie), auth ? maskCookie(auth.cookie) : '没有', HINTS.no_auth)
    if (!auth?.cookie) return items

    let firstAnswer = null
    try {
      const hot = await this.hot(3)
      push('热榜接口（v3）', hot.length > 0, `拿到 ${hot.length} 条`, hot.length ? '' : '接口通了但没返回条目')
    } catch (e) {
      push('热榜接口（v3）', false, `${e?.code ?? ''} ${e?.message ?? e}`, e?.hint || '')
    }
    try {
      const rec = await this.recommend(3)
      firstAnswer = rec.find((x) => x.kind === 'answer' || x.kind === 'article') || null
      push('推荐流（v3）', rec.length > 0, `拿到 ${rec.length} 条`, rec.length ? '' : '可能你的推荐流是空的')
    } catch (e) {
      push('推荐流（v3）', false, `${e?.code ?? ''} ${e?.message ?? e}`, e?.hint || '')
    }
    try {
      const following = await this.following(3)
      push('关注动态（v3）', following.length > 0, `拿到 ${following.length} 条`, following.length ? '' : '可能你最近没关注新内容')
    } catch (e) {
      push('关注动态（v3）', false, `${e?.code ?? ''} ${e?.message ?? e}`, e?.hint || '')
    }
    try {
      const followees = await this.followees(5)
      push('关注列表（v4）', followees.length > 0, `读到 ${followees.length} 个人`, followees.length ? '' : '读不到时可以在偏好里手动填「关注的人」')
    } catch (e) {
      push('关注列表（v4）', false, `${e?.code ?? ''} ${e?.message ?? e}`, e?.hint || '读不到不影响推荐/热榜；可在偏好里手动填关注的人')
    }
    if (firstAnswer) {
      try {
        const full = await this.item({ kind: firstAnswer.kind, id: firstAnswer.id, questionId: firstAnswer.questionId })
        push('正文接口（v4）', Boolean(full?.content), full?.content ? `读到 ${full.content.length} 字` : '只有摘要，没有正文', full?.content ? '' : 'v4 正文接口被拦时，插件会退回列表里的摘要')
      } catch (e) {
        push('正文接口（v4）', false, `${e?.code ?? ''} ${e?.message ?? e}`, e?.hint || '')
      }
    } else {
      push('正文接口（v4）', false, '没有可试的条目', '推荐流没拿到东西，先解决上一条')
    }
    return items
  }

  /* ───────── 候选缓存（正文兜底 + 卡片墙） ───────── */

  cachePath() {
    return `${this.home}/items.json`
  }

  cache() {
    const v = readJson(this.cachePath(), {})
    const items = Array.isArray(v?.items) ? v.items : []
    return items.filter(isObj)
  }

  remember(item) {
    try {
      if (!item || !item.id) return item
      const key = `${item.kind}:${item.id}`
      const rows = this.cache().filter((x) => `${x.kind}:${x.id}` !== key)
      rows.unshift({ ...item, seenAt: new Date().toISOString() })
      writeJson(this.cachePath(), { savedAt: new Date().toISOString(), items: rows.slice(0, CACHE_MAX) })
      return item
    } catch {
      return item
    }
  }

  fromCache(kind, id) {
    const key = `${kind}:${id}`
    return this.cache().find((x) => `${x.kind}:${x.id}` === key) || null
  }

  cached(limit = 30) {
    return this.cache().slice(0, Math.max(1, Math.min(100, Number(limit) || 30)))
  }
}

/* ─────────────── 归一化 ─────────────── */

function dedupe(items) {
  const out = []
  const seen = new Set()
  for (const it of items) {
    if (!it || !it.id) continue
    const key = `${it.kind}:${it.id}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(it)
  }
  return out
}

/** 把 v3/v4 返回的一条（可能是 wrapper）收拾成统一形状 */
export function normalizeItem(input) {
  const wrap = isObj(input) ? input : {}
  const t = isObj(wrap.target) ? wrap.target : wrap
  const kindRaw = str(t.type || wrap.type || '').toLowerCase()
  const q = isObj(t.question) ? t.question : (isObj(wrap.question) ? wrap.question : {})
  const urlRaw = str(t.url || wrap.url || '')
  const guess = parseRefSafe(urlRaw)

  let kind = kindRaw
  if (kind === 'feed') kind = ''
  if (!['answer', 'question', 'article', 'pin', 'zvideo', 'video'].includes(kind)) {
    kind = guess?.kind && guess.kind !== 'unknown' ? guess.kind : (q.id ? 'answer' : 'question')
  }
  if (kind === 'zvideo' || kind === 'video') kind = 'zvideo'
  if (kind === 'pin') kind = 'pin'

  const id = String(t.id ?? q.id ?? guess?.id ?? '')
  const questionId = String(q.id ?? t.question_id ?? guess?.questionId ?? '')
  const title = str(t.title)
    || str(t.question?.title)
    || str(q.title)
    || str(t.excerpt).slice(0, 60)
    || `知乎${kind === 'answer' ? '回答' : kind === 'article' ? '文章' : kind === 'question' ? '问题' : '内容'} ${id}`
  const contentHtml = str(t.content) || str(t.detail)
  const excerpt = str(t.excerpt) || plainExcerpt(contentHtml, 180)
  const author = str(t.author?.name) || str(t.author?.name)
    || str(t.creator?.name) || (t.author?.is_org ? '机构号' : '') || '匿名用户'
  const metrics = isObj(t.metrics) ? t.metrics : {}
  const votes = num(t.voteup_count ?? t.vote_count ?? t.reaction_count ?? metrics.voteup_count)
  const comments = num(t.comment_count ?? metrics.comment_count)
  const hotRaw = metrics.hot ?? t.hot ?? t.detail_text
  const created = num(t.created_time ?? t.created ?? t.updated_time)

  return {
    id,
    kind: ['answer', 'question', 'article', 'pin', 'zvideo'].includes(kind) ? kind : 'answer',
    title,
    question: str(q.title) || (kind === 'question' ? str(t.title) : ''),
    questionId,
    author,
    excerpt,
    content: htmlToText(contentHtml, { maxChars: CONTENT_MAX }),
    url: normalizeWebUrl(urlRaw, kind, id, questionId) || webUrlOf(kind, id, questionId),
    votes,
    comments,
    hot: hotRaw === undefined || hotRaw === null ? '' : String(hotRaw),
    created,
  }
}

function parseRefSafe(s) {
  try { return parseRef(s) } catch { return null }
}

function normalizeWebUrl(url, kind, id, questionId) {
  if (!url) return ''
  if (/^https?:\/\/(www\.)?zhihu\.com\/question\/\d+\/answer\/\d+/i.test(url)) return url.replace('http://', 'https://')
  if (/^https?:\/\/zhuanlan\.zhihu\.com\/p\/\d+/i.test(url)) return url.replace('http://', 'https://')
  if (/^https?:\/\/(www\.)?zhihu\.com\/question\/\d+/i.test(url)) return url.replace('http://', 'https://').split('?')[0]
  return webUrlOf(kind, id, questionId)
}

function parseHeat(text) {
  const s = String(text || '').replace(/,/g, '')
  const m = s.match(/([\d.]+)\s*(亿|万)?/)
  if (!m) return 0
  const n = Number(m[1])
  if (!Number.isFinite(n)) return 0
  const unit = m[2] === '亿' ? 1e8 : m[2] === '万' ? 1e4 : 1
  return Math.round(n * unit)
}

/**
 * 知乎热榜现在是 `target.title_area / excerpt_area / metrics_area` 结构，
 * 旧的 `target.title / excerpt` 作为兜底。
 */
export function normalizeHotItem(row) {
  if (!isObj(row)) return null
  const t = isObj(row.target) ? row.target : row
  const card = str(row.card_id || t.card_id || '')
  const newShape = isObj(t.title_area) || isObj(t.excerpt_area) || isObj(t.metrics_area) || /^[QPA]_\d+$/.test(card)
  if (!newShape) {
    const it = normalizeItem(row)
    if (!it.id) return null
    it.source = 'hot'
    it.sourceLabel = '热榜'
    return it
  }
  const m = card.match(/^([QPA])_(\d+)$/)
  const kind = m ? (m[1] === 'Q' ? 'question' : m[1] === 'P' ? 'article' : 'answer') : 'question'
  const id = m ? m[2] : str(t.id || row.id || '')
  if (!id) return null
  const qid = str(t.question?.id || t.question_id || '')
  const title = str(t.title_area?.text) || str(t.title) || str(row.title_area?.text)
  const excerpt = str(t.excerpt_area?.text) || str(t.excerpt) || str(row.excerpt_area?.text)
  const metricsText = str(t.metrics_area?.text) || str(row.metrics_area?.text)
  const heat = parseHeat(metricsText)
  const url = kind === 'question'
    ? webUrlOf('question', id)
    : kind === 'article'
      ? webUrlOf('article', id)
      : webUrlOf('answer', id, qid)
  return {
    id,
    kind,
    title: title || `知乎热榜 ${id}`,
    question: kind === 'question' ? title : '',
    questionId: qid,
    author: '',
    excerpt,
    content: '',
    url,
    votes: 0,
    comments: 0,
    hot: metricsText,
    heat,
    answerCount: num(row.feed_specific?.answer_count ?? t.answer_count ?? row.answer_count),
    created: 0,
    source: 'hot',
    sourceLabel: '热榜',
  }
}

function normalizeFeed(json, ctx) {
  const data = Array.isArray(json?.data) ? json.data : []
  const out = []
  for (const row of data) {
    if (!isObj(row)) continue
    const type = str(row.type).toLowerCase()
    if (type === 'ad' || type === 'ad_feed') continue
    const target = isObj(row.target) ? row.target : row
    if (str(target.type).toLowerCase() === 'ad') continue
    const it = normalizeItem(row)
    if (!it.id) continue
    if (it.kind === 'zvideo' && !it.title) continue
    it.source = ctx.source
    out.push(it)
  }
  return out
}
