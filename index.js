/**
 * dsh-zhihu-scroll —— host 半端
 * ============================================================================
 * 「每天替你刷一轮知乎」的插件版（2.0：领域/来源/判断权重 + 设置页登录）。
 *
 *   1. 用**你自己的知乎 Cookie** 调知乎的读接口（推荐 / 热榜 / 关注动态 / 关注的人 / 正文 / 评论）；
 *   2. 按「来源权重」分配候选名额、按「领域权重 + 关键词 + 互动量」排序；
 *   3. 午间 / 夜间窗口到点，起一个**进程内的值班 agent**（只给 5 只只读工具），
 *      让它读正文、按「判断权重」筛条目、交报告；
 *   4. 报告写进 `$DSH_HOME/zhihu-duty/out/<日期>.md`，结构化数据写进 `meta/`；
 *   5. 设置页（client.js）通过 `/api/zhihu-duty/*` 管理登录、偏好、跑/停、看报告。
 *
 * 🔴 红线：这个插件**不注册**任何写操作（不点赞、不评论、不关注、不私信）。
 * ============================================================================
 */
import { createHash, randomUUID } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  WINDOW_LABEL, candidateTarget, currentWindow, dayKey, loadConfig, nextWindow, saveConfig,
} from './lib/config.mjs'
import { dueTimePoint, nextTimePoint } from './lib/schedule.mjs'
import {
  authPath, charterPath, defaultHomeDir, dshHome, ensureCharter, ensureHome, homeDir, log,
  markSeen, maskCookie, readAuth, readJson, readState, tailLog, writeAuth, writeHomeLocation, writeJson, writeState,
} from './lib/state.mjs'
import {
  countPicked, itemKeyOf, listDays, mergeDay, questionKeyOf, readDay, readReport, recentPicked,
  reportHistory, reportPath, writeReport,
} from './lib/report.mjs'
import { ZhihuClient, ZhihuError, describeError } from './lib/zhihu.mjs'
import { DOMAINS, QUALITY, SOURCES, labelOfDomain, labelOfSource, labelOfQuality } from './lib/domains.mjs'

const PLUGIN_DIR = dirname(fileURLToPath(import.meta.url))
const CLI_VERSION = (() => {
  try { return JSON.parse(readFileSync(join(PLUGIN_DIR, 'package.json'), 'utf8')).version || '0.1.0' } catch { return '0.1.0' }
})()
const sha256 = (s) => createHash('sha256').update(String(s || ''), 'utf8').digest('hex')
const iso = () => new Date().toISOString()

export const name = 'zhihu-scroll'
export const inject = ['webServer', 'tools']

/** 值班 agent 能用的工具（全是只读 + 交报告） */
const DUTY_ALLOW = ['zhihu_feed', 'zhihu_hot', 'zhihu_item', 'zhihu_status', 'zhihu_report_save']

const OUTPUT = {
  schema: { type: 'object', properties: {}, additionalProperties: true },
  render: (_args, value) => [{
    type: 'text',
    text: typeof value === 'string' ? value : JSON.stringify(value, null, 2),
  }],
}

/** 宿主只吃无损 JSON */
const safe = (v) => {
  if (v === undefined || v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return v
  try { return JSON.parse(JSON.stringify(v)) } catch { return String(v) }
}

const trim = (s, n) => {
  const t = String(s ?? '')
  return t.length > n ? t.slice(0, n) + '…' : t
}

const DOMAIN_CATALOG = DOMAINS.map(({ id, label }) => ({ id, label }))
const SOURCE_CATALOG = SOURCES.map(({ id, label, hint }) => ({ id, label, hint }))
const QUALITY_CATALOG = QUALITY.map(({ id, label, hint }) => ({ id, label, hint }))

const weightText = (weights, labelFn) => Object.entries(weights || {})
  .filter(([, w]) => Number(w) > 0)
  .sort((a, b) => Number(b[1]) - Number(a[1]))
  .map(([id, w]) => `${labelFn(id)} ${w}`)
  .join('、')

export function apply(ctx) {
  ensureHome()
  let home = homeDir()
  let client = new ZhihuClient({ home })
  let cfg = loadConfig(home)
  let running = false
  let currentAgent = null
  let parentRun = null
  let lastRound = null
  let lastTargetWarn = ''
  // desktop 账号模型只在前台会话里可用。手动按钮不再跑；定时只投递到用户选中的
  // 「刷知乎」对话，并带上完整的 role/id，避免 0.2.6 那种 422 弄坏对话。
  const RUN_DISABLED = true
  const RUN_DISABLED_MSG = '手动按钮已停用：请直接在对话里说「刷一轮知乎」；定时请在「自动值班」里选目标对话。'

  const logger = (m) => log(home, m)
  const refreshCfg = () => { cfg = loadConfig(home); return cfg }

  const sessionTitleOf = (agent) => {
    const id = String(agent?.session?.id || '')
    try {
      const raw = readJson(join(dshHome(), 'storages', 'session_projcache', 'sessions', `${id}.json`), null)
      const t = String(raw?.record?.rows?.title?.val || '').trim()
      if (t) return t.slice(0, 60)
    } catch { /* 没缓存就用 id */ }
    try {
      const msgs = agent.session.deriveMessages()
      const first = msgs.find((m) => m.role === 'user' && (m.source?.kind === 'user' || !m.source?.kind))
      const text = (first?.content || []).filter((b) => b.type === 'text').map((b) => b.text).join(' ').trim()
      if (text) return text.replace(/\s+/g, ' ').slice(0, 40)
    } catch { /* 读不到就退回 id */ }
    return id ? id.slice(-12) : ''
  }

  const listDutySessions = () => {
    try {
      const agents = ctx.get('agents')
      const roots = typeof agents?.roots === 'function' ? agents.roots() : []
      return roots
        .filter((a) => a?.session?.id)
        .map((a) => ({
          id: a.session.id,
          title: sessionTitleOf(a),
          cwd: String(a.session.header?.cwd || ''),
          createdAt: Number(a.session.header?.createdAt) || 0,
        }))
        .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
        .slice(0, 20)
    } catch { return [] }
  }

  const findDutyTarget = () => {
    const id = String(cfg.dutySessionId || '')
    if (!id) return null
    try {
      const agents = ctx.get('agents')
      if (!agents) return null
      const direct = typeof agents.get === 'function' ? agents.get(id) : null
      if (direct) return direct
      const roots = typeof agents.roots === 'function' ? agents.roots() : []
      return roots.find((a) => String(a?.session?.id || '') === id) || null
    } catch { return null }
  }

  const deliverToTarget = (target, text) => {
    if (!target) throw new Error('定时目标对话没开着')
    target.followup({
      role: 'user',
      id: randomUUID(),
      content: [{ type: 'text', text }],
      source: { kind: 'user' },
    })
    return target.session.id
  }

  /** 用 Cookie 读一次 /api/v4/me，把昵称记进 auth.json（读不到不影响刷） */
  const hydrateMe = async () => {
    const auth = readAuth(home)
    if (!auth?.cookie) return null
    try {
      const me = await client.me()
      if (me && (me.name || me.urlToken)) {
        writeAuth(home, {
          ...auth,
          name: me.name || auth.name || '',
          urlToken: me.urlToken || auth.urlToken || '',
          checkedAt: iso(),
        })
      }
      return me
    } catch (e) {
      logger(`读账号信息失败（不影响刷）：${describeError(e)}`)
      return null
    }
  }

  /* ─────────────── 值班章程 ─────────────── */
  const bundledCharter = (() => {
    try { return readFileSync(join(PLUGIN_DIR, 'prompts', 'duty.md'), 'utf8') } catch { return '' }
  })()
  let charterInfo = ensureCharter(home, bundledCharter, sha256)
  if (charterInfo.action !== 'same') logger(`值班章程：${charterInfo.action}（${charterPath(home)}）`)
  const charter = () => {
    try { return readFileSync(charterPath(home), 'utf8') } catch { return bundledCharter }
  }

  /* ─────────────── 数据目录 ─────────────── */
  const HOME_ITEMS = [
    'config.json', 'auth.json', 'state.json', 'seen.json', 'items.json', 'followees.json',
    'duty.md', 'charter.sha256', 'duty.log', 'out', 'meta',
  ]

  /** 把旧目录里的数据复制到新目录；目标已有同名项就跳过，绝不覆盖 */
  const copyHomeData = (from, to) => {
    const copied = []
    for (const item of HOME_ITEMS) {
      const src = join(from, item)
      const dst = join(to, item)
      if (!existsSync(src) || existsSync(dst)) continue
      try {
        cpSync(src, dst, { recursive: true, force: false, errorOnExist: false })
        copied.push(item)
      } catch { /* 复制不了的项跳过，不影响其余 */ }
    }
    return copied
  }

  /** 校验并创建用户填的目录；不是绝对路径 / 不能写 / 指向宿主区域都拒绝 */
  const normalizeHomePath = (input) => {
    let p = String(input ?? '').trim()
    if (!p) throw new Error('目录不能为空')
    if (p === '~') p = homedir()
    else if (p.startsWith('~/')) p = join(homedir(), p.slice(2))
    if (!isAbsolute(p)) throw new Error('请填绝对路径（也可以 ~/ 开头）')
    p = resolve(p)
    if (p === '/') throw new Error('不能用根目录')
    if (p === homedir()) throw new Error('别直接用主目录，给它一个子目录')
    if (p === PLUGIN_DIR || p.startsWith(PLUGIN_DIR + sep)) throw new Error('不能把数据放进插件包目录')
    if (p === dshHome()) throw new Error('别直接用 DSH_HOME，给它一个子目录')
    const profiles = join(dshHome(), 'profiles')
    if (p === profiles || p.startsWith(profiles + sep)) throw new Error('不能放进 DSH 的 profile 目录')
    if (existsSync(p)) {
      if (!statSync(p).isDirectory()) throw new Error('这个路径是一个文件，不是目录')
    }
    return p
  }

  /** 运行时切换数据目录：复制数据、写指针、换 client/config/章程，不需要重启 */
  const switchHome = (input) => {
    if (running) throw new Error('这一轮还没跑完，等它结束再换目录')
    const target = normalizeHomePath(input)
    if (target === home) return { home, copied: [], reused: false, cfg }
    if (target.startsWith(home + sep) || home.startsWith(target + sep)) {
      throw new Error('新旧目录不能互相嵌套')
    }
    try { mkdirSync(target, { recursive: true }) } catch (e) { throw new Error(`建不了目录：${e?.message ?? e}`) }
    const probe = join(target, `.write-test-${process.pid}`)
    try {
      writeFileSync(probe, 'x')
      unlinkSync(probe)
    } catch (e) {
      throw new Error(`这个目录写不进去：${e?.message ?? e}`)
    }
    ensureHome(target)
    const old = home
    const reused = existsSync(join(target, 'config.json')) || existsSync(join(target, 'auth.json'))
    const copied = copyHomeData(old, target)
    if (!writeHomeLocation(target)) throw new Error('写不进目录指针（检查 DSH_HOME 权限）')
    home = target
    client = new ZhihuClient({ home })
    cfg = loadConfig(home)
    charterInfo = ensureCharter(home, bundledCharter, sha256)
    log(old, `数据目录切换：${old} -> ${home}`)
    log(home, `数据目录已切换${reused ? '（目标已有数据，直接使用）' : `（从旧目录复制 ${copied.length} 项）`}`)
    return { home, copied, reused, cfg }
  }

  /* ─────────────── 工具 ─────────────── */
  const registered = new Set()
  const registerTool = (spec) => {
    try {
      ctx.effect(() => ctx.tools.register({ ...spec, output: OUTPUT }), `zhihu-scroll: tool ${spec.name}`)
      registered.add(spec.name)
    } catch (e) {
      logger(`工具 ${spec.name} 没挂上：${e?.message ?? e}`)
    }
  }
  const guard = async (fn) => {
    try { return safe({ ok: true, ...(await fn()) }) } catch (e) {
      if (e instanceof ZhihuError) return safe({ ok: false, code: e.code, error: e.message, hint: e.hint })
      return safe({ ok: false, code: 'error', error: String(e?.message ?? e) })
    }
  }

  const compact = (it) => ({
    id: it.id,
    kind: it.kind,
    title: trim(it.title, 160),
    question: trim(it.question, 160),
    author: it.author,
    url: it.url,
    votes: it.votes,
    comments: it.comments,
    hot: it.hot,
    excerpt: trim(it.excerpt, 220),
    source: it.source || '',
    sourceLabel: it.source ? labelOfSource(it.source) : '',
    domains: Array.isArray(it.domains) ? it.domains.map((id) => labelOfDomain(id)) : [],
    score: it.score,
    fromCache: it.fromCache || false,
  })

  registerTool({
    name: 'zhihu_feed',
    description: '捞一轮知乎候选。默认**按设置里的来源权重**混合推荐流 / 热榜 / 关注动态 / 关注的人，'
      + '再按领域权重 + 关键词 + 互动量排序；只返回标题、摘要、来源、领域、分数，没有正文。\n'
      + '判断一条值不值得读，必须再用 zhihu_item 读正文。\n'
      + '默认候选目标是 max(candidates, 10 × 每天条数)，上限 200；不够用 page 继续翻。',
    parameters: {
      type: 'object',
      properties: {
        source: {
          type: 'string',
          enum: ['recommend', 'hot', 'following', 'followingUsers'],
          description: '只用某一个来源；不填 = 按权重混合（推荐）',
        },
        limit: { type: 'integer', description: '捞几条（1–200，默认按 10×每天条数自动算）' },
        page: { type: 'integer', description: '第几页（1–10，默认 1；没合适的就翻页继续）' },
      },
      additionalProperties: false,
    },
    async execute(args) {
      return guard(async () => {
        refreshCfg()
        const limit = Math.max(1, Math.min(200, Number(args.limit) || candidateTarget(cfg)))
        const page = Math.max(1, Math.min(10, Number(args.page) || 1))
        const source = String(args.source || '')
        if (source) {
          const items = await client.feed({ source, limit, page, followingUsers: cfg.followingUsers })
          return {
            mode: 'single-source',
            source,
            sourceLabel: labelOfSource(source),
            count: items.length,
            items: items.map(compact),
            note: cfg.followingUsers.length
              ? `关注的人：${cfg.followingUsers.length} 个指定账号（读不到时自动退回关注列表）。`
              : '关注的人：没指定，用你的关注列表。',
          }
        }
        const r = await client.collect({ limit, cfg, page })
        return {
          mode: 'weighted',
          page,
          limit,
          count: r.items.length,
          items: r.items.map(compact),
          quotas: r.quotas.map(([id, q]) => ({ source: id, label: labelOfSource(id), quota: q })),
          weights: {
            domains: cfg.domains,
            sources: cfg.sources,
            quality: cfg.quality,
          },
          errors: r.errors,
          note: `候选目标 ${limit}（至少 10×每天条数，page ${page}）；领域权重只影响排序，来源权重决定名额。没合适的用 page 继续翻，不要降标准。`,
        }
      })
    },
  })

  registerTool({
    name: 'zhihu_hot',
    description: '看知乎热榜（带热度）。热榜是「全站正在热」，不等于「对你的口味」；'
      + '适合用来发现新东西，或者给推荐流兜底。',
    parameters: {
      type: 'object',
      properties: { limit: { type: 'integer', description: '几条（1–50，默认 12）' } },
      additionalProperties: false,
    },
    async execute(args) {
      return guard(async () => {
        const items = await client.hot(Math.max(1, Math.min(50, Number(args.limit) || 12)))
        return { count: items.length, items: items.map(compact) }
      })
    },
  })

  registerTool({
    name: 'zhihu_item',
    description: '读一条知乎内容的正文：回答给全文，文章给全文，问题给前 3 条高赞回答。\n'
      + '⭐ 判断内容只靠这个工具，不看摘要。返回里会区分「正文」和「只有摘要」。\n'
      + 'ref 可以传：回答/问题/文章链接，或 `answer:123` / `question:456` / `p:789`。',
    parameters: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: '链接或 answer:123 / question:456 / p:789' },
        maxChars: { type: 'integer', description: '正文最多返回多少字（1000–16000，默认 8000）' },
        related: { type: 'boolean', description: '回答是否顺手带同问题下其他高赞回答（默认 true）' },
      },
      required: ['ref'],
      additionalProperties: false,
    },
    async execute(args) {
      return guard(async () => {
        const full = await client.item(String(args.ref), { related: args.related !== false })
        const max = Math.max(1000, Math.min(16000, Number(args.maxChars) || 8000))
        return {
          item: {
            ...compact(full),
            content: trim(full.content, max),
            contentChars: String(full.content || '').length,
            truncated: String(full.content || '').length > max,
            answerCount: full.answerCount,
            followerCount: full.followerCount,
            visitCount: full.visitCount,
            warning: full.warning || '',
            relatedWarning: full.relatedWarning || '',
            relatedAnswers: Array.isArray(full.relatedAnswers)
              ? full.relatedAnswers.map((a) => ({
                id: a.id, title: trim(a.title, 160), url: a.url, author: a.author,
                votes: a.votes, comments: a.comments,
                excerpt: trim(a.excerpt, 200), content: trim(a.content, 1200),
              }))
              : undefined,
            answers: Array.isArray(full.answers)
              ? full.answers.map((a) => ({
                id: a.id, author: a.author, votes: a.votes, comments: a.comments,
                content: trim(a.content, Math.max(1500, Math.floor(max / 2))),
              }))
              : undefined,
          },
          readFullText: Boolean(full.content && String(full.content).length > 80),
          note: full.content ? '' : '只有摘要，没有拿到正文 —— 汇报时要如实说明。',
        }
      })
    },
  })

  registerTool({
    name: 'zhihu_comments',
    description: '看一条回答/文章下的热门评论（作者、内容、赞数）。用来判断「这条有没有被反驳/补充」，'
      + '不是必读步骤。',
    parameters: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: '回答或文章链接' },
        limit: { type: 'integer', description: '几条（1–50，默认 20）' },
      },
      required: ['ref'],
      additionalProperties: false,
    },
    async execute(args) {
      return guard(async () => {
        const items = await client.comments(String(args.ref), Math.max(1, Math.min(50, Number(args.limit) || 20)))
        return { count: items.length, comments: items }
      })
    },
  })

  registerTool({
    name: 'zhihu_report_save',
    description: '把这一轮挑出来的条目交上去（增量写进本月文章 + 计数）。**一轮只调一次**，交完就收尾。\n手动提交不受每天目标硬拦：超过 perDay 也会继续并入当月文章。\n'
      + '每条必须带 title / url / why；quote 可选但必须原文；tier = must | worth | fun。\n'
      + '同问题下其他值得一起看的回答放进该条目的 related（最多 3 条），不要单独占主条目额度。\n'
      + '重复内容、30 天内出现过的问题、今天已经收过的同一作者会被跳过（skipped），不会写进文章；'
      + '一条都没挑到也要交空 items，并在 summary 里说明原因。',
    parameters: {
      type: 'object',
      properties: {
        summary: { type: 'string', description: '一句话总结这一轮（≤ 60 字）' },
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              title: { type: 'string' },
              url: { type: 'string' },
              id: { type: 'string' },
              questionId: { type: 'string', description: '同问题去重用的知乎问题 id（可选；能从 url 推出来）' },
              kind: { type: 'string', enum: ['answer', 'article', 'question'] },
              author: { type: 'string' },
              votes: { type: 'number' },
              comments: { type: 'number' },
              tier: { type: 'string', enum: ['must', 'worth', 'fun'] },
              why: { type: 'string' },
              quote: { type: 'string' },
              related: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    title: { type: 'string' },
                    url: { type: 'string' },
                    author: { type: 'string' },
                    votes: { type: 'number' },
                    why: { type: 'string' },
                    quote: { type: 'string' },
                  },
                  required: ['title', 'url'],
                  additionalProperties: true,
                },
              },
            },
            required: ['title', 'url', 'why'],
            additionalProperties: true,
          },
        },
      },
      required: ['items'],
      additionalProperties: false,
    },
    async execute(args) {
      return guard(async () => {
        refreshCfg()
        const day = dayKey()
        const already = countPicked(home, day)
        const rawItems = Array.isArray(args.items) ? args.items : []
        const history = reportHistory(home, day)
        const seen = new Set(history.allKeys)
        const questions = new Set(history.recentQuestions)
        const authors = new Set(history.todayAuthors)
        const kept = []
        const skipped = []
        for (const raw of rawItems) {
          const title = String(raw?.title ?? '').trim()
          const key = itemKeyOf(raw)
          if (key && seen.has(key)) { skipped.push({ title, reason: 'repeat' }); continue }
          const q = questionKeyOf(raw)
          if (q && questions.has(q)) { skipped.push({ title, reason: 'question' }); continue }
          const author = String(raw?.author ?? '').trim()
          if (author && authors.has(author)) { skipped.push({ title, reason: 'author' }); continue }
          const relSeen = new Set()
          const related = (Array.isArray(raw?.related) ? raw.related : []).filter((rel) => {
            const rk = itemKeyOf(rel)
            if (!rk || seen.has(rk) || relSeen.has(rk)) return false
            relSeen.add(rk)
            return true
          })
          kept.push({ ...raw, ...(related.length ? { related } : {}) })
          if (key) seen.add(key)
          if (q) questions.add(q)
          if (author) authors.add(author)
        }
        if (rawItems.length > 0 && kept.length === 0) {
          return {
            saved: false,
            blocked: 'duplicates',
            added: 0,
            picked: already,
            perDay: cfg.perDay,
            skipped,
            hint: '全是重复内容/同问题/同日同作者，已全部跳过；换内容或用 page 继续翻，不要降标准。',
          }
        }
        // perDay 是「自动调度 + 章程」的目标，不是手动提交的硬闸：
        // 用户手动再跑一轮时，新条目要能继续增量并入月度文章，哪怕今天已超过额度。
        const { data, added } = mergeDay(home, day, {
          summary: String(args.summary || '').slice(0, 300),
          items: kept,
          rounds: 1,
        })
        const wrote = writeReport(home, data, cfg.reportLevel)
        const fresh = data.items.slice(already)
        for (const it of fresh) if (it.id) markSeen(home, it.id, day)
        const overQuota = cfg.perDay > 0 ? Math.max(0, data.items.length - cfg.perDay) : 0
        logger(`交报告：新增 ${added} 条${skipped.length ? `，跳过 ${skipped.length} 条重复` : ''}，今天共 ${data.items.length} 条${overQuota ? `（超每日目标 ${overQuota} 条）` : ''}${wrote.file ? `，已写 ${wrote.file}` : ''}`)
        return {
          saved: true,
          added,
          picked: data.items.length,
          perDay: cfg.perDay,
          overQuota,
          skipped,
          file: wrote.file || '',
          reportLevel: cfg.reportLevel,
          hint: added === 0
            ? '这次没有新增（可能都是今天挑过的）—— 如果是空 items，那就是如实交白卷。'
            : (skipped.length
              ? `已跳过 ${skipped.length} 条重复/同问题/同作者，只写入新的。`
              : (overQuota > 0 ? '今天已超过每天目标；手动交的条目已增量写进月度文章。' : '')),
        }
      })
    },
  })

  registerTool({
    name: 'zhihu_status',
    description: '看「刷知乎」今天的状态：跑了没跑、挑了几条、额度、登录账号、偏好权重、下次窗口、报告在哪。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    async execute() {
      return guard(async () => {
        refreshCfg()
        const day = dayKey()
        const st = readState(home)
        const auth = readAuth(home)
        return {
          today: day,
          picked: countPicked(home, day),
          perDay: cfg.perDay,
          auto: cfg.auto,
          running,
          lastRunAt: st.lastRunAt || '',
          lastWhy: st.lastWhy || '',
          lastError: st.lastError || '',
          authConfigured: Boolean(auth?.cookie),
          account: auth?.name || '',
          domains: weightText(cfg.domains, labelOfDomain),
          sources: weightText(cfg.sources, labelOfSource),
          quality: weightText(cfg.quality, labelOfQuality),
          followingUsers: cfg.followingUsers.length,
          report: reportPath(home, day),
          nextWindow: nextWindow(new Date(), cfg),
          home,
        }
      })
    },
  })

  const dutyTools = DUTY_ALLOW.filter((n) => registered.has(n))

  /* ─────────────── 跑一轮 ─────────────── */
  const buildTask = (day) => {
    const picked = readDay(home, day)?.items || []
    const lines = [
      `今天是 ${day}。按值班章程刷一轮知乎。`,
      `每天最多 ${cfg.perDay} 条；候选目标 ${candidateTarget(cfg)} 条（至少 10×每天条数）。`,
      `领域权重：${weightText(cfg.domains, labelOfDomain) || '没选（按中性判断）'}`,
      `来源权重：${weightText(cfg.sources, labelOfSource) || '没选（默认推荐流）'}`,
      `判断权重：${weightText(cfg.quality, labelOfQuality) || '没设（按中性判断）'}`,
      `关注的人：${cfg.followingUsers.length ? cfg.followingUsers.join('、') : '（空，用你的关注列表）'}`,
      cfg.keywords.length ? `额外关键词：${cfg.keywords.join('、')}` : '',
      cfg.perDay === 0 ? '注意：每天上限设成了 0（只手动）——这一轮最多交 3 条，别贪。' : '',
      cfg.persona ? `人设提示词（只借语气，不借事实）：${cfg.persona}` : '',
      picked.length
        ? `今天已经挑过（不要重复）：\n${picked.map((x, i) => `${i + 1}. ${x.title}`).join('\n')}`
        : '今天还没挑过。',
      '现在开始：先调 zhihu_feed（不传 source，按权重捞），再逐条读正文。没合适的就用 page 翻页/换来源继续捞，不要放宽标准；最后调一次 zhihu_report_save。',
    ]
    return lines.filter(Boolean).join('\n\n')
  }

  const runRound = async (why = 'manual') => {
    const scheduled = String(why).startsWith('window:') || String(why).startsWith('at:')
    if (RUN_DISABLED && !scheduled) {
      writeState(home, { running: false, lastError: RUN_DISABLED_MSG })
      logger(RUN_DISABLED_MSG)
      return { ok: false, error: RUN_DISABLED_MSG }
    }
    if (running) return { ok: false, error: '上一轮还没结束' }
    running = true
    const startedAt = Date.now()
    const day = dayKey()
    writeState(home, { lastRunAt: iso(), lastWhy: why, running: true, lastError: '' })
    logger(`刷知乎开跑（${why}）`)
    let parent = null
    try {
      const agents = ctx.get('agents')
      const defaultModel = ctx.get('agentDefaultModel')
      if (!agents) throw new Error('宿主没有 agents 服务：自动值班不可用。可以直接在聊天里让我「刷一轮知乎」。')

      // 定时任务只投到用户选中的「刷知乎」对话，不碰当前聊天。
      parent = scheduled ? findDutyTarget() : null
      if (scheduled) {
        if (!String(cfg.dutySessionId || '')) {
          throw new Error('定时目标对话未设置：设置 → 刷知乎 → 自动值班 → 定时投到，选一个「刷知乎」对话。')
        }
        if (!parent) {
          throw new Error('定时目标对话没开着：把那个「刷知乎」对话打开并保持标签页存在。')
        }
        logger(`定时任务目标：${sessionTitleOf(parent)}（${parent.session.id}）`)
      }

      // ⭐ 光有 parentAgent 还不够：subagent 能跑通是因为它把父级的 agent preset / 组合
      //    也挂到了子上下文里（applyChildComposition）。这里照做，否则账号模型传输层起不来。
      const presetId = parent
        ? (parent.session?.header?.agentPreset
          || parent.ctx?.get?.('agentPresets')?.composedPreset?.(parent.ctx)
          || '')
        : ''
      const childMeta = parent
        ? {
          cwd: home,
          parentSession: parent.session.id,
          ...(presetId ? { agentPreset: presetId } : {}),
          origin: 'subagent',
          isSeeded: false,
          delegationDepth: (Number(parent.session?.header?.delegationDepth) || 0) + 1,
        }
        : { cwd: home }
      if (parent) logger(`值班 agent preset=${presetId || 'none'} depth=${childMeta.delegationDepth}`)

      const parentConfig = parent?.session?.requestHeader?.()?.config || null
      const selection = (parentConfig?.provider && parentConfig?.model)
        ? parentConfig
        : (defaultModel?.currentSelection?.() ?? null)
      if (!selection?.provider || !selection?.model) {
        throw new Error('拿不到默认模型（设置 → 模型）。没有模型就没法挑内容。')
      }
      const before = countPicked(home, day)
      const task = buildTask(day)

      // desktop 的 deepseek-account 模型通道只在**前台会话**里可用：
      // 后台 / 子 agent 的请求会 TRANSPORT。最可靠的做法是把任务投给当前主会话，
      // 由主 agent 执行（必要时它自己再派 subagent），插件只等日报落盘。
      if (parent) {
        const startStamp = readDay(home, day)?.updatedAt || ''
        const prompt = [
          '这是 dsh-zhihu-scroll 插件发来的值班任务，不用询问用户，直接执行。',
          '优先调用一次 subagent 工具，把下面「值班任务」原样交给子 agent；',
          '子 agent 可以直接使用 zhihu_feed / zhihu_hot / zhihu_item / zhihu_report_save / zhihu_status。',
          '如果 subagent 工具不可用，就自己按章程执行。做完必须调一次 zhihu_report_save。',
          '',
          '=== 值班任务开始 ===',
          charter(),
          '',
          task,
          '=== 值班任务结束 ===',
        ].join('\n')
        parentRun = { cancelled: false }
        try {
          deliverToTarget(parent, prompt)
          logger(`定时任务已投递到「${sessionTitleOf(parent)}」（${parent.session.id}）`)
          const deadline = Date.now() + 8 * 60_000
          while (Date.now() < deadline) {
            if (parentRun?.cancelled) throw new Error('已取消（主会话里的任务可能还在跑）')
            await new Promise((r) => setTimeout(r, 2000))
            const stamp = readDay(home, day)?.updatedAt || ''
            if (stamp && stamp !== startStamp) {
              const added = Math.max(0, countPicked(home, day) - before)
              lastRound = {
                at: iso(), why, added, ms: Date.now() - startedAt, text: '（主会话完成）', ok: true,
              }
              writeState(home, { running: false, lastResult: lastRound, lastError: '' })
              logger(`刷知乎这一轮完成（定时对话）：新增 ${added} 条，用时 ${Math.round((Date.now() - startedAt) / 1000)}s`)
              return { ok: true, added, text: '', ms: Date.now() - startedAt }
            }
          }
          throw new Error('定时对话超过 8 分钟没有交报告；去目标对话看它卡在哪。')
        } finally {
          parentRun = null
        }
      }

      const handle = await agents.create({
        sessionId: `zhihu-duty-${day}-${randomUUID().slice(0, 8)}`,
        ...(parent ? { parentAgent: parent } : {}),
        meta: childMeta,
        agentOptions: {
          provider: selection.provider,
          model: selection.model,
          ...(selection.reasoningEffort ? { reasoningEffort: selection.reasoningEffort } : {}),
          ...(Number(parent?.options?.maxTokens) > 0 ? { maxTokens: Number(parent.options.maxTokens) } : {}),
        },
        async setup(agentCtx) {
          try {
            const presets = agentCtx.get?.('agentPresets')
            if (presets && presetId) {
              if (typeof presets.mount === 'function') await presets.mount(agentCtx, presetId)
              else if (parent && typeof presets.composeFrom === 'function') await presets.composeFrom(agentCtx, parent.ctx)
            } else if (presets && parent && typeof presets.composeFrom === 'function') {
              await presets.composeFrom(agentCtx, parent.ctx)
            }
          } catch (e) { logger(`预设组合没挂上：${e?.message ?? e}`) }
          try {
            agentCtx.systemPrompt.section({ name: 'zhihu:duty', order: 9000, text: charter() })
          } catch (e) { logger(`值班章程没挂上：${e?.message ?? e}`) }
          if (dutyTools.length > 0) {
            try {
              agentCtx.tools.restrict({ allow: dutyTools })
            } catch (e) { logger(`工具限制没挂上（这一轮会看到别的工具）：${e?.message ?? e}`) }
          }
        },
      })
      const agent = handle.agent
      logger(`值班 agent 已创建：session=${agent.session.id} preset=${agent.session.header?.agentPreset || 'none'} depth=${agent.session.header?.delegationDepth ?? 0}`)
      currentAgent = agent
      let agentError = null
      const offError = ctx.on('agent/error', ({ agent: a, error }) => {
        if (a === agent) agentError = error
      })
      try {
        agent.followup({
          content: [{ type: 'text', text: task }],
          source: { kind: 'user' },
        })
        const timeout = new Promise((resolve) => {
          const t = setTimeout(() => resolve({ timeout: true }), 8 * 60_000)
          t.unref?.()
        })
        const winner = await Promise.race([agent.whenIdle().then(() => ({ idle: true })), timeout])
        if (winner?.timeout) {
          logger('本轮超过 8 分钟，主动取消')
          try { await agent.cancel({ kind: 'user' }) } catch { /* 已经停了 */ }
        }
        if (agentError) throw agentError
        let finalText = ''
        try {
          const msgs = agent.session.deriveMessages()
          const last = [...msgs].reverse().find((m) => m.role === 'assistant')
          if (last) finalText = (last.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('')
        } catch { /* 读不到就算了 */ }
        try { await ctx.get('sessions')?.flush?.(agent.session) } catch { /* 没有就算了 */ }
        const after = countPicked(home, day)
        if (after === before) {
          const { data } = mergeDay(home, day, {
            summary: '这一轮没有交报告（模型没有调用 zhihu_report_save）。',
            items: [],
            rounds: 1,
          })
          writeReport(home, data, cfg.reportLevel)
          logger('这一轮没有交报告，已补占位')
        }
        const added = Math.max(0, after - before)
        lastRound = { at: iso(), why, added, ms: Date.now() - startedAt, text: trim(finalText, 500), ok: true }
        writeState(home, { running: false, lastResult: lastRound, lastError: '' })
        logger(`刷知乎结束（${why}）：新增 ${added} 条，用时 ${Math.round((Date.now() - startedAt) / 1000)}s${finalText ? ` · ${trim(finalText, 180)}` : ''}`)
        return { ok: true, added, text: finalText, ms: Date.now() - startedAt }
      } finally {
        offError?.()
        currentAgent = null
        try { await handle.dispose() } catch (e) { logger(`值班 agent 收尾失败：${e?.message ?? e}`) }
      }
    } catch (e) {
      let msg = describeError(e)
      if (!parent && /TRANSPORT|transport/i.test(msg)) {
        msg += '\n（没有可用的前端会话。deepseek-account 的模型通道需要挂在主会话下：打开一个对话再点「现在跑一轮」。）'
      }
      writeState(home, { running: false, lastError: msg })
      logger(`刷知乎这一轮失败（${why}）：${msg}`)
      lastRound = { at: iso(), why, ok: false, error: msg }
      return { ok: false, error: msg }
    } finally {
      running = false
    }
  }

  /* ─────────────── 定时窗口 ─────────────── */
  const tick = () => {
    try {
      refreshCfg()
      if (!cfg.auto || running) return
      if (cfg.perDay <= 0) return
      const day = dayKey()
      if (countPicked(home, day) >= cfg.perDay) return
      const st = readState(home)

      // 精确时间点模式：到点后 10 分钟内都算 due，每个点每天一次。
      if (cfg.scheduleTimes.length > 0) {
        const due = dueTimePoint(cfg.scheduleTimes, new Date(), {
          graceMs: 10 * 60_000,
          done: Object.keys(st.windows || {}),
        })
        if (!due) return
        const target = findDutyTarget()
        if (!target) {
          if (lastTargetWarn !== due.key) {
            lastTargetWarn = due.key
            logger('自动值班：目标对话没开着或还没选；这个时间点先不跑，打开那个「刷知乎」对话后 10 分钟内会重试。')
          }
          return
        }
        const windows = { ...(st.windows || {}), [due.key]: iso() }
        for (const k of Object.keys(windows)) {
          if (!k.startsWith(day) && !k.startsWith(prevDayKey(day))) delete windows[k]
        }
        writeState(home, { windows })
        const late = due.lateMs >= 60_000 ? `（补跑 ${Math.round(due.lateMs / 60_000)} 分钟）` : ''
        logger(`到点 ${due.time}${late}，自动开跑（目标=${sessionTitleOf(target)}）`)
        runRound(`at:${due.time}`).catch((e) => logger(`自动跑异常（已兜住）：${e?.message ?? e}`))
        return
      }

      // 兼容旧的午间/夜间窗口
      const win = currentWindow(new Date(), cfg)
      if (!win) return
      const key = `${day}:${win}`
      if (st.windows && st.windows[key]) return
      const target = findDutyTarget()
      if (!target) {
        if (lastTargetWarn !== key) {
          lastTargetWarn = key
          logger('自动值班：目标对话没开着或还没选；这一窗口先不跑，打开那个「刷知乎」对话后会重试。')
        }
        return
      }
      const windows = { ...(st.windows || {}), [key]: iso() }
      for (const k of Object.keys(windows)) {
        if (!k.startsWith(day) && !k.startsWith(prevDayKey(day))) delete windows[k]
      }
      writeState(home, { windows })
      logger(`进入${WINDOW_LABEL[win] || win}窗口，自动开跑（目标=${sessionTitleOf(target)}）`)
      runRound(`window:${win}`).catch((e) => logger(`自动跑异常（已兜住）：${e?.message ?? e}`))
    } catch (e) {
      logger(`定时器这一跳出错（已兜住，不影响宿主）：${e?.stack ?? e}`)
    }
  }
  try {
    const timer = setInterval(tick, 60_000)
    timer.unref?.()
    ctx.effect(() => () => clearInterval(timer), 'zhihu-scroll: 窗口定时器')
    const first = setTimeout(tick, 12_000)
    first.unref?.()
    ctx.effect(() => () => clearTimeout(first), 'zhihu-scroll: 启动首跳')
  } catch (e) {
    logger(`定时器没起来：${e?.message ?? e}`)
  }

  /* ─────────────── 设置页 HTTP 接口 ─────────────── */
  const json = (res, code, body) => {
    try {
      const data = JSON.stringify(body)
      res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end(data)
    } catch { /* 连接可能已经断了 */ }
  }
  const readBody = (req) => new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (c) => {
      size += c.length
      if (size > 1_000_000) { reject(new Error('请求体太大')); req.destroy(); return }
      chunks.push(c)
    })
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8')
      if (!text) return resolve({})
      try { resolve(JSON.parse(text)) } catch { reject(new Error('请求体不是合法 JSON')) }
    })
    req.on('error', reject)
  })

  const status = () => {
    refreshCfg()
    const day = dayKey()
    const st = readState(home)
    const auth = readAuth(home)
    const data = readDay(home, day)
    const scheduleNext = cfg.scheduleTimes.length ? nextTimePoint(cfg.scheduleTimes, new Date()) : null
    return {
      ok: true,
      version: CLI_VERSION,
      dsh: process.versions?.electron ? `desktop ${process.versions.electron}` : `node ${process.versions.node}`,
      home,
      defaultHome: defaultHomeDir(),
      defaultHomeExists: existsSync(defaultHomeDir()),
      homeLocked: Boolean(process.env.DSH_ZHIHU_HOME),
      running,
      cfg,
      sessions: listDutySessions(),
      auth: auth
        ? {
          configured: true,
          hasAuth: Boolean(auth.hasAuth),
          savedAt: auth.savedAt || '',
          fields: maskCookie(auth.cookie),
          name: auth.name || '',
          urlToken: auth.urlToken || '',
          source: auth.source || '',
        }
        : { configured: false, hasAuth: false, savedAt: '', fields: '', name: '', urlToken: '', source: '' },
      today: {
        day,
        picked: data?.items?.length || 0,
        perDay: cfg.perDay,
        summary: data?.summary || '',
        lastRunAt: st.lastRunAt || '',
        lastWhy: st.lastWhy || '',
        lastError: st.lastError || '',
        rounds: data?.rounds || 0,
      },
      windows: {
        noon: cfg.noon,
        night: cfg.night,
        current: currentWindow(new Date(), cfg),
        next: nextWindow(new Date(), cfg),
      },
      schedule: {
        mode: cfg.scheduleTimes.length ? 'times' : 'windows',
        times: cfg.scheduleTimes,
        graceMinutes: 10,
        next: scheduleNext?.at || '',
        nextTime: scheduleNext?.time || '',
      },
      charter: {
        file: charterPath(home),
        hasNew: existsSync(`${charterPath(home)}.new`),
        action: charterInfo.action,
      },
      report: { day, path: reportPath(home, day), exists: existsSync(reportPath(home, day)) },
      lastRound,
      days: listDays(home, 7),
      domainCatalog: DOMAIN_CATALOG,
      sourceCatalog: SOURCE_CATALOG,
      qualityCatalog: QUALITY_CATALOG,
    }
  }

  const diagnose = () => {
    const st = readState(home)
    const auth = readAuth(home)
    const lines = [
      `dsh-zhihu-scroll ${CLI_VERSION}`,
      `runtime: ${process.versions?.electron ? `desktop electron ${process.versions.electron}` : `node ${process.versions.node}`}`,
      `home: ${home}`,
      `defaultHome: ${defaultHomeDir()}${process.env.DSH_ZHIHU_HOME ? '（由 DSH_ZHIHU_HOME 固定）' : ''}`,
      `config: ${JSON.stringify(cfg)}`,
      `auth: ${auth ? `已配置（${maskCookie(auth.cookie)}${auth.name ? `，${auth.name}` : ''}，hasAuth=${Boolean(auth.hasAuth)}，savedAt=${auth.savedAt || ''}）` : '未配置'}`,
      `charter: ${charterPath(home)}（${charterInfo.action}${existsSync(`${charterPath(home)}.new`) ? '，有新版 duty.md.new' : ''}）`,
      `state: ${JSON.stringify(st)}`,
      `report: ${reportPath(home, dayKey())}`,
      '',
      '--- duty.log 最后 60 行 ---',
      tailLog(home, 60),
    ]
    return lines.join('\n')
  }

  const sameOriginOk = (req) => {
    try {
      const host = String(req.headers.host || '')
      if (!host) return true
      if (!/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(host)) return false
      const pick = String(req.headers.origin || req.headers.referer || '')
      if (!pick) return true
      try {
        const u = new URL(pick)
        return /^(127\.0\.0\.1|localhost|\[::1\])$/i.test(u.hostname)
      } catch { return false }
    } catch { return false }
  }

  const handle = async (req, res, url) => {
    const path = url.pathname.replace(/\/+$/, '') || '/'
    const method = req.method || 'GET'

    if (method === 'GET' && path === '/api/zhihu-duty/status') return json(res, 200, status())
    if (method === 'GET' && path === '/api/zhihu-duty/config') return json(res, 200, { ok: true, cfg: refreshCfg() })
    if (method === 'POST' && path === '/api/zhihu-duty/config') {
      const body = await readBody(req)
      cfg = saveConfig(home, body?.cfg && typeof body.cfg === 'object' ? body.cfg : body)
      logger(`设置已更新：${JSON.stringify(cfg)}`)
      return json(res, 200, { ok: true, cfg })
    }

    // ── 数据目录 ──
    if (method === 'POST' && path === '/api/zhihu-duty/home') {
      if (process.env.DSH_ZHIHU_HOME) {
        return json(res, 400, { ok: false, error: '当前数据目录由 DSH_ZHIHU_HOME 固定，改不了' })
      }
      const body = await readBody(req)
      try {
        const r = switchHome(body.home || body.path)
        return json(res, 200, { ok: true, ...r })
      } catch (e) {
        return json(res, 400, { ok: false, error: e?.message ?? String(e) })
      }
    }

    // ── 登录：粘贴 / 剪贴板导入 ──
    if (method === 'POST' && path === '/api/zhihu-duty/auth') {
      const body = await readBody(req)
      const text = String(body.text || body.cookie || '')
      const saved = client.setAuthFromText(text)
      let me = null
      try {
        // 读昵称可能被风控拖住，最多等 2.5 秒；超时就让它在后台继续写
        me = await Promise.race([
          hydrateMe(),
          new Promise((resolve) => { const t = setTimeout(() => resolve(null), 2500); t.unref?.() }),
        ])
      } catch { /* 读不到昵称不影响保存 */ }
      return json(res, 200, { ok: true, ...saved, me })
    }
    if (method === 'POST' && path === '/api/zhihu-duty/auth/clear') {
      try { writeJson(authPath(home), {}) } catch { /* 忽略 */ }
      logger('已清空知乎 Cookie')
      return json(res, 200, { ok: true, configured: false })
    }

    if (method === 'POST' && path === '/api/zhihu-duty/test') {
      return json(res, 200, { ok: true, items: await client.test() })
    }
    if (method === 'POST' && path === '/api/zhihu-duty/deliver-test') {
      refreshCfg()
      const target = findDutyTarget()
      if (!target) return json(res, 400, { ok: false, error: '目标对话没开着；先打开那个「刷知乎」对话并选中它' })
      try {
        const sid = deliverToTarget(target, '这是 dsh-zhihu-scroll 的定时投递测试，请只回复 OK。')
        return json(res, 200, { ok: true, session: sid, title: sessionTitleOf(target) })
      } catch (e) {
        return json(res, 500, { ok: false, error: describeError(e) })
      }
    }
    if (method === 'POST' && path === '/api/zhihu-duty/run') {
      if (RUN_DISABLED) {
        writeState(home, { running: false, lastError: RUN_DISABLED_MSG })
        return json(res, 400, { ok: false, error: RUN_DISABLED_MSG })
      }
      if (running) return json(res, 409, { ok: false, error: '上一轮还没结束' })
      runRound('manual').catch((e) => logger(`手动跑异常（已兜住）：${e?.message ?? e}`))
      return json(res, 200, { ok: true, started: true })
    }
    if (method === 'POST' && path === '/api/zhihu-duty/cancel') {
      if (parentRun) {
        parentRun.cancelled = true
        return json(res, 200, { ok: true, cancelled: true, reason: '已停止等待；主会话里的任务可能还在跑' })
      }
      if (!running || !currentAgent) return json(res, 200, { ok: true, cancelled: false })
      try { await currentAgent.cancel({ kind: 'user' }) } catch (e) { logger(`取消失败：${e?.message ?? e}`) }
      return json(res, 200, { ok: true, cancelled: true })
    }
    if (method === 'GET' && path === '/api/zhihu-duty/report') {
      const day = String(url.searchParams.get('day') || dayKey()).replace(/[^0-9-]/g, '') || dayKey()
      const text = readReport(home, day)
      return json(res, 200, { ok: true, day, text, exists: Boolean(text), path: reportPath(home, day) })
    }
    if (method === 'GET' && path === '/api/zhihu-duty/days') {
      return json(res, 200, { ok: true, days: listDays(home, 60) })
    }
    if (method === 'GET' && path === '/api/zhihu-duty/items') {
      const limit = Number(url.searchParams.get('limit')) || 30
      return json(res, 200, { ok: true, items: recentPicked(home, limit) })
    }
    if (method === 'GET' && path === '/api/zhihu-duty/logs') {
      const lines = Number(url.searchParams.get('lines')) || 120
      return json(res, 200, { ok: true, text: tailLog(home, lines), path: join(home, 'duty.log') })
    }
    if (method === 'GET' && path === '/api/zhihu-duty/diagnose') {
      return json(res, 200, { ok: true, text: diagnose() })
    }
    if (method === 'POST' && path === '/api/zhihu-duty/preview') {
      const body = await readBody(req)
      refreshCfg()
      const limit = Math.max(1, Math.min(30, Number(body.limit) || cfg.candidates))
      const r = await client.collect({ limit, cfg })
      return json(res, 200, { ok: true, items: r.items.map(compact), quotas: r.quotas, errors: r.errors })
    }
    return json(res, 404, { ok: false, error: `unknown ${method} ${path}` })
  }

  try {
    ctx.effect(() => ctx.webServer.register({
      kind: 'prefix',
      path: '/api/zhihu-duty',
      handler: async (req, res) => {
        if (!sameOriginOk(req)) {
          try { json(res, 403, { ok: false, error: '只接受本机同源请求' }) } catch { /* 忽略 */ }
          return
        }
        try {
          await handle(req, res, new URL(req.url, 'http://127.0.0.1'))
        } catch (e) {
          try { json(res, 500, { ok: false, error: e?.message ?? String(e) }) } catch { /* 忽略 */ }
        }
      },
    }), 'zhihu-scroll: /api/zhihu-duty 路由')
  } catch (e) {
    logger(`HTTP 路由没挂上：${e?.message ?? e}`)
  }

  logger(`已挂载（家=${home}，自动=${cfg.auto ? '开' : '关'}，每天 ${cfg.perDay} 条，工具 ${[...registered].join('/')}）`)
}

/* 前一天的日期键 */
function prevDayKey(day) {
  const d = new Date(`${day}T12:00:00`)
  d.setDate(d.getDate() - 1)
  return dayKey(d)
}
