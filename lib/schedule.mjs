/**
 * lib/schedule.mjs —— 精确到分钟的时间点调度
 * ============================================================================
 * 用户配置的是本地时间 `HH:mm`（如 08:30 / 12:30 / 21:15）。
 * - 每个点每天最多跑一次；
 * - tick 每分钟一次；到点后 10 分钟内仍算「due」，用来兜住 app 忙/刚启动；
 * - 留空则退回旧的午间/夜间窗口逻辑（向后兼容）。
 * ============================================================================
 */

const pad = (n) => String(n).padStart(2, '0')

/** 本地日期 YYYY-MM-DD（不依赖 config，避免循环 import） */
export function localDay(date = new Date()) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/**
 * 把任意输入收拾成排序、去重、合法的 HH:mm 数组；最多 12 个。
 * 接受 `8:30` / `08:30`，统一成 `08:30`；非法和 24:00 丢掉。
 */
export function normalizeTimes(input) {
  const list = Array.isArray(input) ? input : []
  const out = []
  const seen = new Set()
  for (const raw of list) {
    const m = String(raw ?? '').trim().match(/^(\d{1,2}):([0-5]\d)$/)
    if (!m) continue
    let h = Number(m[1])
    if (h === 24) {
      if (m[2] !== '00') continue
      h = 0
    }
    if (h > 23) continue
    const t = `${pad(h)}:${m[2]}`
    if (seen.has(t)) continue
    seen.add(t)
    out.push(t)
  }
  return out.sort().slice(0, 12)
}

/** 某天的 HH:mm 转成本地 Date */
export function timeAt(day, hhmm) {
  const [h, m] = String(hhmm).split(':').map(Number)
  const d = new Date(`${day}T00:00:00`)
  d.setHours(h, m, 0, 0)
  return d
}

/** 下一个时间点（今天还没到就是今天，否则明天第一个） */
export function nextTimePoint(times, now = new Date()) {
  const list = normalizeTimes(times)
  if (list.length === 0) return null
  const day = localDay(now)
  for (const time of list) {
    const at = timeAt(day, time)
    if (at.getTime() > now.getTime()) return { time, at: at.toISOString(), day }
  }
  const tomorrow = new Date(now)
  tomorrow.setDate(tomorrow.getDate() + 1)
  const time = list[0]
  const at = timeAt(localDay(tomorrow), time)
  return { time, at: at.toISOString(), day: localDay(tomorrow) }
}

/**
 * 当前是否有到点且未跑过的时间点。
 * @param {string[]} times
 * @param {Date} now
 * @param {{graceMs?:number, done?:Set<string>|string[]}} [opts]
 * @returns {{time:string, at:string, key:string, lateMs:number, day:string}|null}
 */
export function dueTimePoint(times, now = new Date(), { graceMs = 10 * 60_000, done = new Set() } = {}) {
  const list = normalizeTimes(times)
  if (list.length === 0) return null
  const day = localDay(now)
  const doneSet = done instanceof Set ? done : new Set(Array.isArray(done) ? done : [])
  for (const time of list) {
    const at = timeAt(day, time)
    const lateMs = now.getTime() - at.getTime()
    if (lateMs < 0 || lateMs >= graceMs) continue
    const key = `${day}:at:${time}`
    if (doneSet.has(key)) continue
    return { time, at: at.toISOString(), key, lateMs, day }
  }
  return null
}
