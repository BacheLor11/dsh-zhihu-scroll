/**
 * lib/report.mjs —— 日报的结构化数据 + Markdown 渲染
 * ============================================================================
 * 事实来源是 `meta/<日期>.json`：设置页的卡片墙、每天挑了几条、防重复，
 * 都读它；`out/<日期>.md` 是给人看的那一份（可以「不写」，但 JSON 留着）。
 * ============================================================================
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

export const TIERS = {
  must: '必读',
  worth: '值得',
  fun: '一乐',
}

export const TIER_ORDER = ['must', 'worth', 'fun']

export function tierOf(v) {
  const s = String(v || '').toLowerCase()
  if (['must', '必读', '强', 'top'].includes(s)) return 'must'
  if (['fun', '一乐', '有趣', 'interesting'].includes(s)) return 'fun'
  return 'worth'
}

export function fmtNum(n) {
  const v = Number(n) || 0
  if (v >= 100000000) return `${(v / 100000000).toFixed(1).replace(/\.0$/, '')} 亿`
  if (v >= 10000) return `${(v / 10000).toFixed(1).replace(/\.0$/, '')} 万`
  return String(v)
}

export function metaPath(home, day) {
  return join(home, 'meta', `${day}.json`)
}

export function monthlyReportPath(home, day) {
  const [year, month] = String(day).split('-')
  return join(home, 'out', `大肥鱼带你刷知乎${year}年${Number(month)}月.md`)
}

/** 兼容旧调用：现在 reportPath 指向月度文章，不再按天生成 md */
export function reportPath(home, day) {
  return monthlyReportPath(home, day)
}

/** 本月已有的日期（倒序，最新在前） */
export function listMonthDays(home, day) {
  const prefix = String(day).slice(0, 7)
  try {
    const dir = join(home, 'meta')
    if (!existsSync(dir)) return []
    return readdirSync(dir)
      .filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f) && f.startsWith(prefix))
      .map((f) => f.slice(0, 10))
      .sort()
      .reverse()
  } catch {
    return []
  }
}

export function readDay(home, day) {
  try {
    const raw = JSON.parse(readFileSync(metaPath(home, day), 'utf8'))
    if (!raw || typeof raw !== 'object') return null
    return {
      date: String(raw.date || day),
      summary: String(raw.summary || ''),
      items: Array.isArray(raw.items) ? raw.items : [],
      createdAt: String(raw.createdAt || ''),
      updatedAt: String(raw.updatedAt || ''),
      rounds: Number(raw.rounds) || 0,
    }
  } catch {
    return null
  }
}

export function writeDay(home, day, data) {
  try {
    mkdirSync(join(home, 'meta'), { recursive: true })
    const file = metaPath(home, day)
    const tmp = `${file}.tmp-${process.pid}`
    writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8')
    renameSync(tmp, file)
    return true
  } catch {
    return false
  }
}

/**
 * 把模型交上来的条目收拾成能落盘的形状。
 * 只认「有标题 + 有理由」的条目 —— 宁缺毋滥。
 */
export function normalizePicked(items, { limit = 20 } = {}) {
  const out = []
  const safeUrl = (v) => {
    const u = String(v ?? '').trim()
    return /^https?:\/\//i.test(u) ? u : ''
  }
  const seen = new Set()
  for (const raw of Array.isArray(items) ? items : []) {
    if (!raw || typeof raw !== 'object') continue
    const title = String(raw.title ?? '').trim()
    const why = String(raw.why ?? raw.reason ?? '').trim()
    if (!title || !why) continue
    const url = String(raw.url ?? '').trim()
    const id = String(raw.id ?? '').trim() || url
    const key = url || id || title
    if (seen.has(key)) continue
    seen.add(key)
    const related = []
    const relSeen = new Set([key])
    for (const rel of Array.isArray(raw.related) ? raw.related : []) {
      if (!rel || typeof rel !== 'object') continue
      const rt = String(rel.title ?? '').trim()
      const ru = safeUrl(rel.url)
      if (!rt || !ru || relSeen.has(ru)) continue
      relSeen.add(ru)
      related.push({
        title: rt.slice(0, 160),
        url: ru,
        author: String(rel.author ?? '').trim().slice(0, 80),
        votes: Number(rel.votes) || 0,
        why: String(rel.why ?? '').trim().slice(0, 300),
        quote: String(rel.quote ?? '').trim().slice(0, 200),
      })
      if (related.length >= 3) break
    }
    out.push({
      id,
      kind: ['answer', 'article', 'question'].includes(raw.kind) ? raw.kind : 'answer',
      title: title.slice(0, 200),
      url: safeUrl(url),
      author: String(raw.author ?? '').trim().slice(0, 80),
      why: why.slice(0, 1200),
      quote: String(raw.quote ?? raw.highlight ?? '').trim().slice(0, 600),
      tier: tierOf(raw.tier),
      votes: Number(raw.votes) || 0,
      comments: Number(raw.comments) || 0,
      related,
      addedAt: new Date().toISOString(),
    })
    if (out.length >= Math.max(1, Math.min(20, Number(limit) || 20))) break
  }
  return out
}

/** 今天的报告合并进新条目（按 id 去重；老条目的理由不覆盖） */
export function mergeDay(home, day, { summary = '', items = [], rounds = 1 } = {}) {
  const prev = readDay(home, day)
  const now = new Date().toISOString()
  const picked = normalizePicked(items)
  const merged = []
  const seen = new Set()
  for (const it of [...(prev?.items || []), ...picked]) {
    const key = it.url || it.id || it.title
    if (seen.has(key)) continue
    seen.add(key)
    merged.push(it)
  }
  const data = {
    date: day,
    summary: summary || prev?.summary || '',
    items: merged,
    createdAt: prev?.createdAt || now,
    updatedAt: now,
    rounds: (Number(prev?.rounds) || 0) + Math.max(0, Number(rounds) || 0),
  }
  writeDay(home, day, data)
  return { data, added: merged.length - (prev?.items?.length || 0) }
}

function renderPickedItem(lines, it, { brief = false, level = '###', index = 1 } = {}) {
  lines.push(`${level} ${index}. ${it.title}`)
  const meta = []
  if (it.author) meta.push(`答主：${it.author}`)
  if (it.votes) meta.push(`赞同 ${fmtNum(it.votes)}`)
  if (it.comments) meta.push(`评论 ${fmtNum(it.comments)}`)
  if (meta.length) lines.push(`- ${meta.join(' · ')}`)
  if (it.url) lines.push(`- 链接：${it.url}`)
  if (!brief) {
    lines.push(`- 为什么值得：${it.why}`)
    if (it.quote) {
      lines.push('')
      lines.push(`> ${String(it.quote).replace(/\n+/g, ' ').trim()}`)
    }
  } else {
    lines.push(`- ${String(it.why || '').split('\n')[0].slice(0, 160)}`)
  }
  if (Array.isArray(it.related) && it.related.length) {
    if (brief) {
      lines.push(`- 同问题：${it.related.map((r) => `[${r.author ? `${r.author}的回答` : r.title}](${r.url})`).join('、')}`)
    } else {
      lines.push('')
      lines.push('**同问题下还有：**')
      for (const r of it.related) {
        const bits = []
        if (r.votes) bits.push(`赞同 ${fmtNum(r.votes)}`)
        if (r.why) bits.push(r.why)
        const relLabel = r.author ? `${r.author}的回答` : r.title
        lines.push(`- [${relLabel}](${r.url})${bits.length ? ` —— ${bits.join(' · ')}` : ''}`)
      }
    }
  }
  lines.push('')
}

/** 渲染 Markdown（full / brief） */
export function renderReport(data, level = 'full') {
  const day = data.date
  const items = Array.isArray(data.items) ? data.items : []
  const brief = level === 'brief'
  const lines = []
  lines.push(`# 刷知乎 · ${day}`)
  lines.push('')
  if (data.summary) {
    lines.push(`> ${String(data.summary).replace(/\n+/g, ' ').trim()}`)
    lines.push('')
  }
  lines.push(`> 今天挑出 **${items.length}** 条${brief ? '（薄版）' : ''} · 生成于 ${new Date().toLocaleString('zh-CN', { hour12: false })}`)
  lines.push('')

  if (items.length === 0) {
    lines.push('今天没有挑到值得占你注意力的条目。')
    lines.push('')
    lines.push('> 可能是候选太少、都被筛掉了，或者这一轮没读到正文（看 `duty.log`）。下一轮会重来。')
    lines.push('')
    return lines.join('\n')
  }

  for (const tier of TIER_ORDER) {
    const group = items.filter((x) => tierOf(x.tier) === tier)
    if (group.length === 0) continue
    lines.push(`## ${TIERS[tier]}`)
    lines.push('')
    let i = 0
    for (const it of group) {
      i += 1
      renderPickedItem(lines, it, { brief, level: '###', index: i })
    }
  }
  lines.push('---')
  lines.push('')
  lines.push('由 `dsh-zhihu-scroll` 生成。口径见插件家目录的 `duty.md`；条目只代表这一轮的判断，不是投资/医疗/法律建议。')
  lines.push('')
  return lines.join('\n')
}

/**
 * 月度文章：一个月一个 md，最新的一天排在最前面；
 * 同一天多次手动跑的新条目按 addedAt 倒序排进当天分区。
 * 每次写入都从 meta 重建，旧内容不会丢，也不会重复。
 */
export function renderMonthlyReport(home, day, level = 'full') {
  const brief = level === 'brief'
  const [year, month] = String(day).split('-')
  const monthLabel = `${year}年${Number(month)}月`
  const records = listMonthDays(home, day).map((d) => readDay(home, d)).filter(Boolean)
  const total = records.reduce((n, d) => n + (d.items?.length || 0), 0)
  const lines = []
  lines.push(`# 大肥鱼带你刷知乎 · ${monthLabel}`)
  lines.push('')
  lines.push(`> 本月共 **${total}** 条${brief ? '（薄版）' : ''} · 更新于 ${new Date().toLocaleString('zh-CN', { hour12: false })}`)
  lines.push('')
  lines.push('---')
  lines.push('')
  if (records.length === 0) {
    lines.push('这个月还没有内容。')
    lines.push('')
    return lines.join('\n')
  }
  for (const data of records) {
    const items = [...(data.items || [])].sort((a, b) => String(b.addedAt || '').localeCompare(String(a.addedAt || '')))
    const stamp = Date.parse(data.updatedAt || '')
    const when = Number.isFinite(stamp) ? new Date(stamp).toLocaleString('zh-CN', { hour12: false }) : ''
    lines.push(`## ${data.date}`)
    lines.push('')
    lines.push(`> ${items.length ? `今天挑出 **${items.length}** 条` : '今天没有挑到条目'}${data.summary ? ` · ${String(data.summary).replace(/\n+/g, ' ').trim()}` : ''}${when ? ` · 更新于 ${when}` : ''}`)
    lines.push('')
    if (items.length === 0) {
      lines.push('今天没有挑到值得占你注意力的条目。')
      lines.push('')
      lines.push('---')
      lines.push('')
      continue
    }
    for (const tier of TIER_ORDER) {
      const group = items.filter((x) => tierOf(x.tier) === tier)
      if (group.length === 0) continue
      lines.push(`### ${TIERS[tier]}`)
      lines.push('')
      let i = 0
      for (const it of group) {
        i += 1
        renderPickedItem(lines, it, { brief, level: '####', index: i })
      }
    }
    lines.push('---')
    lines.push('')
  }
  lines.push('由 `dsh-zhihu-scroll` 生成。口径见插件家目录的 `duty.md`；条目只代表这一轮的判断，不是投资/医疗/法律建议。')
  lines.push('')
  return lines.join('\n')
}

/** 写日报（level=off 时只留 JSON，不写 md） */
export function writeReport(home, data, level = 'full') {
  const day = data.date
  if (level === 'off') return { file: '', skipped: true }
  try {
    mkdirSync(join(home, 'out'), { recursive: true })
    const file = monthlyReportPath(home, day)
    const tmp = `${file}.tmp-${process.pid}`
    writeFileSync(tmp, renderMonthlyReport(home, day, level), 'utf8')
    renameSync(tmp, file)
    return { file, skipped: false }
  } catch (e) {
    return { file: '', skipped: false, error: String(e?.message ?? e) }
  }
}

export function readReport(home, day) {
  try {
    const file = reportPath(home, day)
    return existsSync(file) ? readFileSync(file, 'utf8') : ''
  } catch {
    return ''
  }
}

export function listDays(home, limit = 30) {
  try {
    const dir = join(home, 'meta')
    if (!existsSync(dir)) return []
    return readdirSync(dir)
      .filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
      .map((f) => f.slice(0, 10))
      .sort()
      .reverse()
      .slice(0, Math.max(1, Math.min(365, Number(limit) || 30)))
      .map((day) => {
        const d = readDay(home, day)
        return { day, count: d?.items?.length || 0, summary: d?.summary || '', updatedAt: d?.updatedAt || '' }
      })
  } catch {
    return []
  }
}

export function countPicked(home, day) {
  return readDay(home, day)?.items?.length || 0
}

/** 最近的条目（卡片墙） */
export function recentPicked(home, limit = 30) {
  const out = []
  for (const { day } of listDays(home, 14)) {
    const d = readDay(home, day)
    for (const it of d?.items || []) out.push({ ...it, day })
    if (out.length >= limit) break
  }
  return out.slice(0, Math.max(1, Math.min(100, Number(limit) || 30)))
}
