/**
 * lib/config.mjs —— 「刷知乎」的配置：默认值、迁移、读取、保存、窗口
 * ============================================================================
 * 配置落在 `$DSH_HOME/zhihu-duty/config.json`。设置页改完下一轮生效，不用重启。
 *
 * 偏好模型（2.0）：
 *   domains        领域 → 权重 0..5（用户选）
 *   sources        来源 → 权重 0..5（推荐/热榜/关注动态/关注的人，按比例分配候选名额）
 *   quality        判断口径 → 权重 0..5（信息密度/时效/实操/观点多元）
 *   followingUsers 指定要主动翻的人（主页链接或 url_token；空 = 用关注列表）
 *   keywords       额外关键词（可空）
 * ============================================================================
 */
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import {
  defaultDomainWeights, defaultQualityWeights, defaultSourceWeights,
  parseUserRef, sanitizeWeights,
} from './domains.mjs'
import { normalizeTimes } from './schedule.mjs'

export const DEFAULT_CONFIG = {
  auto: false,
  noon: true,
  night: true,
  perDay: 3,
  candidates: 12,
  domains: defaultDomainWeights(),
  sources: defaultSourceWeights(),
  quality: defaultQualityWeights(),
  followingUsers: [],
  keywords: [],
  reportLevel: 'full',
  persona: '',
  dutySessionId: '',
  scheduleTimes: [],
}

/** 两个窗口（本地时间，左闭右开；24 表示当天结束） */
export const WINDOWS = {
  noon: [12, 14],
  night: [18, 24],
}

export const WINDOW_LABEL = {
  noon: '中午 12–14',
  night: '晚上 18–24',
}

const clamp = (n, lo, hi, dflt) => {
  const v = Number(n)
  if (!Number.isFinite(v)) return dflt
  return Math.max(lo, Math.min(hi, Math.round(v)))
}

const uniqStrings = (arr, max, maxLen) => {
  if (!Array.isArray(arr)) return []
  const out = []
  const seen = new Set()
  for (const raw of arr) {
    const s = String(raw ?? '').trim().slice(0, maxLen)
    if (!s || seen.has(s)) continue
    seen.add(s)
    out.push(s)
    if (out.length >= max) break
  }
  return out
}

/** 旧版（只有 feed/topics/autoVote）迁移成来源权重 */
function migrateSources(raw) {
  if (raw?.sources && typeof raw.sources === 'object') return sanitizeWeights(raw.sources, defaultSourceWeights())
  const feed = String(raw?.feed || '')
  if (feed === 'hot') return { recommend: 0, hot: 4, following: 1, followingUsers: 0 }
  if (feed === 'recommend') return { recommend: 4, hot: 1, following: 1, followingUsers: 0 }
  if (feed === 'following') return { recommend: 1, hot: 0, following: 4, followingUsers: 0 }
  return defaultSourceWeights()
}

/** 把任意输入收拾成一份能用的配置（永远不抛，坏字段回默认值） */
export function sanitizeConfig(input) {
  const raw = input && typeof input === 'object' ? input : {}
  const reportLevel = ['full', 'brief', 'off'].includes(raw.reportLevel) ? raw.reportLevel : DEFAULT_CONFIG.reportLevel
  const followingUsers = (Array.isArray(raw.followingUsers) ? raw.followingUsers : [])
    .map((x) => parseUserRef(x))
    .filter(Boolean)
    .filter((x, i, a) => a.indexOf(x) === i)
    .slice(0, 30)
  const keywords = uniqStrings(raw.keywords ?? raw.topics, 20, 30)
  return {
    auto: Boolean(raw.auto),
    noon: raw.noon === undefined ? DEFAULT_CONFIG.noon : Boolean(raw.noon),
    night: raw.night === undefined ? DEFAULT_CONFIG.night : Boolean(raw.night),
    perDay: clamp(raw.perDay, 0, 20, DEFAULT_CONFIG.perDay),
    candidates: clamp(raw.candidates, 4, 30, DEFAULT_CONFIG.candidates),
    domains: sanitizeWeights(raw.domains, defaultDomainWeights()),
    sources: migrateSources(raw),
    quality: sanitizeWeights(raw.quality, defaultQualityWeights()),
    followingUsers,
    keywords,
    reportLevel,
    persona: String(raw.persona ?? '').slice(0, 2000),
    dutySessionId: String(raw.dutySessionId ?? '').trim().slice(0, 100),
    scheduleTimes: normalizeTimes(raw.scheduleTimes),
  }
}

export function configPath(home) {
  return join(home, 'config.json')
}

/** 读配置；文件不存在 / 坏了都退回默认值 */
export function loadConfig(home) {
  try {
    const file = configPath(home)
    if (!existsSync(file)) return sanitizeConfig(DEFAULT_CONFIG)
    return sanitizeConfig(JSON.parse(readFileSync(file, 'utf8')))
  } catch {
    return sanitizeConfig(DEFAULT_CONFIG)
  }
}

/** 合并写回（设置页每次只发变化的字段也行） */
export function saveConfig(home, patch) {
  const next = sanitizeConfig({ ...loadConfig(home), ...(patch && typeof patch === 'object' ? patch : {}) })
  const file = configPath(home)
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}`
  writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', 'utf8')
  renameSync(tmp, file)
  return next
}

/** 本地日期 YYYY-MM-DD */
export function dayKey(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`
}

/** 现在在不在窗口里 */
export function inWindow(now, [start, end]) {
  const h = now.getHours() + now.getMinutes() / 60
  return h >= start && h < end
}

/** 当前命中的窗口名（没命中返回 null） */
export function currentWindow(now, cfg) {
  for (const key of ['noon', 'night']) {
    if (!cfg[key]) continue
    if (inWindow(now, WINDOWS[key])) return key
  }
  return null
}

/** 下一次窗口在什么时候 */
export function nextWindow(now = new Date(), cfg = DEFAULT_CONFIG) {
  for (let add = 0; add <= 2; add++) {
    const d = new Date(now)
    d.setDate(d.getDate() + add)
    d.setHours(0, 0, 0, 0)
    for (const key of ['noon', 'night']) {
      if (!cfg[key]) continue
      const start = new Date(d)
      start.setHours(WINDOWS[key][0], 0, 0, 0)
      if (start.getTime() > now.getTime()) return { key, label: WINDOW_LABEL[key], at: start.toISOString() }
    }
  }
  return null
}
