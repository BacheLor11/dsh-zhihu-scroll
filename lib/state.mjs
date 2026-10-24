/**
 * lib/state.mjs —— 插件自己的「家」：目录、配置/状态/凭证的读写、日志
 * ============================================================================
 * 所有运行数据都在 `$DSH_HOME/zhihu-duty/`（DSH_HOME 默认 ~/.dsh）：
 *
 *   config.json   设置（设置页写）
 *   auth.json     知乎 Cookie（0600，绝不进日志、绝不出接口）
 *   state.json    今天跑了几轮、挑了几条、各窗口跑过没有
 *   seen.json     最近挑过的条目（防重复）
 *   items.json    最近抓到的候选条目缓存（带正文，供 zhihu_item 兜底）
 *   charter.sha256  值班章程的版本账本（用户改过就不覆盖）
 *   duty.md       值班章程（从 prompts/duty.md 铺过来，用户可改）
 *   out/<日期>.md  日报
 *   meta/<日期>.json  日报的结构化版本（设置页的卡片墙、计数都用它）
 *   duty.log      运行日志（超过 1 MB 轮转一份 .1）
 *
 * ⚠️ 规矩：这里所有写盘函数都自己 try/catch —— 插件写不了盘只该「这一轮没跑成」，
 *    绝不能把异常抛回宿主（参考 dsh-bili-scroll 2026-10-14 的崩溃事故）。
 * ============================================================================
 */
import {
  existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, appendFileSync,
  statSync, unlinkSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'

export function dshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

export function defaultHomeDir() {
  return process.env.DSH_ZHIHU_HOME || join(dshHome(), 'zhihu-duty')
}

/** 记住「用户把数据目录换到哪儿了」的指针文件；放在 DSH_HOME 下，不属于数据目录本身 */
export function locationFile() {
  return join(dshHome(), 'zhihu-duty-location.json')
}

export function readHomeLocation() {
  const v = readJson(locationFile(), null)
  if (v && typeof v.home === 'string' && isAbsolute(v.home)) return v.home
  return ''
}

export function writeHomeLocation(home) {
  return writeJson(locationFile(), { home, updatedAt: new Date().toISOString() })
}

/** 当前数据目录：环境变量 > 指针文件 > 默认 */
export function homeDir() {
  if (process.env.DSH_ZHIHU_HOME) return process.env.DSH_ZHIHU_HOME
  return readHomeLocation() || join(dshHome(), 'zhihu-duty')
}

export function ensureHome(home = homeDir()) {
  for (const d of [home, join(home, 'out'), join(home, 'meta')]) {
    try { mkdirSync(d, { recursive: true }) } catch { /* 已经存在或写不了，后面各自兜 */ }
  }
  return home
}

export function readJson(file, dflt) {
  try {
    if (!existsSync(file)) return dflt
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return dflt
  }
}

export function writeJson(file, value, mode) {
  try {
    mkdirSync(dirname(file), { recursive: true })
    const tmp = `${file}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 7)}`
    writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { encoding: 'utf8', ...(mode ? { mode } : {}) })
    renameSync(tmp, file)
    return true
  } catch {
    return false
  }
}

/* ─────────────── 日志 ─────────────── */

const LOG_MAX = 1024 * 1024

export function logPath(home = homeDir()) {
  return join(home, 'duty.log')
}

export function rotateLog(home = homeDir()) {
  try {
    const file = logPath(home)
    if (!existsSync(file)) return
    if (statSync(file).size <= LOG_MAX) return
    const old = `${file}.1`
    if (existsSync(old)) unlinkSync(old)
    renameSync(file, old)
  } catch { /* 转不动就算了，写日志不能因此失败 */ }
}

/** 写一行日志（时间戳 + 文本）；任何异常都吞掉 */
export function log(home, msg) {
  try {
    rotateLog(home)
    const line = `[${new Date().toISOString()}] ${String(msg).replace(/\s+$/, '')}\n`
    appendFileSync(logPath(home), line, 'utf8')
  } catch { /* 不抛 */ }
}

/** 读日志最后 N 行（设置页「诊断」用） */
export function tailLog(home = homeDir(), lines = 80) {
  try {
    const file = logPath(home)
    if (!existsSync(file)) return ''
    const text = readFileSync(file, 'utf8')
    return text.trimEnd().split('\n').slice(-Math.max(1, Math.min(500, lines))).join('\n')
  } catch {
    return ''
  }
}

/* ─────────────── 运行状态 ─────────────── */

export function statePath(home = homeDir()) {
  return join(home, 'state.json')
}

export function readState(home = homeDir()) {
  const st = readJson(statePath(home), {})
  return st && typeof st === 'object' ? st : {}
}

export function writeState(home, patch) {
  const next = { ...readState(home), ...(patch && typeof patch === 'object' ? patch : {}) }
  writeJson(statePath(home), next)
  return next
}

/* ─────────────── 凭证 ─────────────── */

export function authPath(home = homeDir()) {
  return join(home, 'auth.json')
}

export function readAuth(home = homeDir()) {
  const a = readJson(authPath(home), null)
  if (!a || typeof a !== 'object' || !a.cookie) return null
  return a
}

export function writeAuth(home, auth) {
  return writeJson(authPath(home), auth, 0o600)
}

/** 日志 / 设置页 / 工具输出里只显示这个，绝不回显原 Cookie */
export function maskCookie(cookie) {
  const s = String(cookie || '')
  if (!s) return ''
  const names = s.split(';').map((x) => x.trim().split('=')[0]).filter(Boolean)
  return `${names.length} 个字段（${names.slice(0, 6).join(', ')}${names.length > 6 ? '…' : ''}）`
}

/* ─────────────── 挑过的条目（防重复） ─────────────── */

export function seenPath(home = homeDir()) {
  return join(home, 'seen.json')
}

export function readSeen(home = homeDir()) {
  const v = readJson(seenPath(home), {})
  return v && typeof v === 'object' && !Array.isArray(v) ? v : {}
}

export function markSeen(home, id, day) {
  if (!id) return
  const seen = readSeen(home)
  seen[String(id)] = String(day || '')
  // 只留最近 500 条，别让文件无限长
  const keys = Object.keys(seen)
  if (keys.length > 500) {
    for (const k of keys.slice(0, keys.length - 500)) delete seen[k]
  }
  writeJson(seenPath(home), seen)
}

/* ─────────────── 值班章程 ─────────────── */

export function charterPath(home = homeDir()) {
  return join(home, 'duty.md')
}

export function charterHashPath(home = homeDir()) {
  return join(home, 'charter.sha256')
}

/**
 * 把插件里的章程铺到家里。
 * 规矩跟 dsh-bili-scroll 一样：用户改过（哈希对不上账本）就保留他那份，
 * 新版另存 `duty.md.new`，日志里说一句；没改过就跟着插件升级。
 *
 * @returns {{action:'created'|'updated'|'kept'|'new-incoming'|'same', file:string}}
 */
export function ensureCharter(home, bundledText, hashOf) {
  const file = charterPath(home)
  const bundled = String(bundledText || '')
  const bundledHash = hashOf(bundled)
  try {
    if (!existsSync(file)) {
      writeFileSync(file, bundled, 'utf8')
      writeFileSync(charterHashPath(home), bundledHash, 'utf8')
      return { action: 'created', file }
    }
    const mine = readFileSync(file, 'utf8')
    const myHash = hashOf(mine)
    const ledger = (() => {
      try { return readFileSync(charterHashPath(home), 'utf8').trim() } catch { return '' }
    })()
    if (myHash === ledger) {
      if (myHash === bundledHash) return { action: 'same', file }
      writeFileSync(file, bundled, 'utf8')
      writeFileSync(charterHashPath(home), bundledHash, 'utf8')
      return { action: 'updated', file }
    }
    // 用户改过：只有在「新版跟他手上这份不一样」时才落一份 .new
    if (bundledHash !== myHash) {
      const incoming = `${file}.new`
      try {
        const prev = existsSync(incoming) ? readFileSync(incoming, 'utf8') : ''
        if (prev !== bundled) writeFileSync(incoming, bundled, 'utf8')
      } catch { /* 写不了就算了 */ }
      return { action: 'new-incoming', file }
    }
    return { action: 'kept', file }
  } catch {
    return { action: 'kept', file }
  }
}
