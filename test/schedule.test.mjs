import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dueTimePoint, nextTimePoint, normalizeTimes } from '../lib/schedule.mjs'

test('时间点规范化：8:30 → 08:30，去重排序，24:00 丢掉', () => {
  assert.deepEqual(normalizeTimes(['21:15', '8:30', '08:30', '12:30', '24:00', '9:7', 'bad']), ['00:00', '08:30', '12:30', '21:15'])
  assert.deepEqual(normalizeTimes([]), [])
})

test('下一个时间点：今天/明天', () => {
  const a = nextTimePoint(['08:30', '12:30', '21:15'], new Date(2026, 9, 24, 12, 0, 0))
  assert.equal(a.time, '12:30')
  assert.equal(a.day, '2026-10-24')
  const b = nextTimePoint(['08:30', '21:15'], new Date(2026, 9, 24, 22, 0, 0))
  assert.equal(b.time, '08:30')
  assert.equal(b.day, '2026-10-25')
})

test('到点判定：点后 10 分钟内补跑，每天每个点一次', () => {
  const times = ['12:30']
  const due = dueTimePoint(times, new Date(2026, 9, 24, 12, 35, 0))
  assert.equal(due.time, '12:30')
  assert.equal(due.key, '2026-10-24:at:12:30')
  assert.equal(due.lateMs, 5 * 60_000)
  assert.equal(dueTimePoint(times, new Date(2026, 9, 24, 12, 29, 0)), null)
  assert.equal(dueTimePoint(times, new Date(2026, 9, 24, 12, 41, 0)), null)
  assert.equal(dueTimePoint(times, new Date(2026, 9, 24, 12, 35, 0), { done: new Set([due.key]) }), null)
})
