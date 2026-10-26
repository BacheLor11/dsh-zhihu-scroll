import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_CONFIG, candidateTarget, sanitizeConfig } from '../lib/config.mjs'

test('默认配置有完整的偏好模型，没有互动字段', () => {
  const c = sanitizeConfig(DEFAULT_CONFIG)
  assert.ok(c.domains.ai >= 0)
  assert.ok(c.sources.following > 0)
  assert.ok(c.quality.depth > 0)
  assert.deepEqual(c.followingUsers, [])
  assert.equal('autoVote' in c, false)
  assert.equal('feed' in c, false)
  assert.equal(c.dutySessionId, '')
  assert.deepEqual(c.scheduleTimes, [])
})

test('定时目标 session 去空白、限长', () => {
  assert.equal(sanitizeConfig({ dutySessionId: '  session-abc  ' }).dutySessionId, 'session-abc')
  assert.equal(sanitizeConfig({ dutySessionId: 'x'.repeat(200) }).dutySessionId.length, 100)
})

test('旧版 feed/topics 能迁移', () => {
  const hot = sanitizeConfig({ feed: 'hot' })
  assert.deepEqual(hot.sources, { recommend: 0, hot: 4, following: 1, followingUsers: 0 })
  const follow = sanitizeConfig({ feed: 'following' })
  assert.deepEqual(follow.sources, { recommend: 1, hot: 0, following: 4, followingUsers: 0 })
  const old = sanitizeConfig({ topics: ['旧词', '旧词', ' 另一个 '] })
  assert.deepEqual(old.keywords, ['旧词', '另一个'])
})

test('权重钳在 0..5，未知领域不进来', () => {
  const c = sanitizeConfig({ domains: { ai: 9, tech: -2, nope: 5 }, quality: { depth: 99 } })
  assert.equal(c.domains.ai, 5)
  assert.equal(c.domains.tech, 0)
  assert.equal(c.domains.nope, undefined)
  assert.equal(c.quality.depth, 5)
})

test('关注的人去重、认主页链接、坏输入丢掉', () => {
  const c = sanitizeConfig({
    followingUsers: [
      'https://www.zhihu.com/people/abc',
      'abc',
      '@def',
      'https://www.zhihu.com/people/abc/answers',
      'bad name!',
      '',
    ],
  })
  assert.deepEqual(c.followingUsers, ['abc', 'def'])
})

test('数字范围', () => {
  assert.equal(sanitizeConfig({ perDay: 99 }).perDay, 20)
  assert.equal(sanitizeConfig({ perDay: -1 }).perDay, 0)
  assert.equal(sanitizeConfig({ candidates: 1 }).candidates, 4)
  assert.equal(sanitizeConfig({ candidates: 99 }).candidates, 99)
})

test('时间点去重、排序、认 8:30、丢掉 24:00', () => {
  const c = sanitizeConfig({ scheduleTimes: ['21:15', '8:30', '08:30', '12:30', '24:00', '9:7', 'bad'] })
  assert.deepEqual(c.scheduleTimes, ['00:00', '08:30', '12:30', '21:15'])
})

test('候选目标至少 10×每天条数，上限 200', () => {
  assert.equal(candidateTarget({ perDay: 10, candidates: 30 }), 100)
  assert.equal(candidateTarget({ perDay: 3, candidates: 12 }), 30)
  assert.equal(candidateTarget({ perDay: 0, candidates: 30 }), 30)
  assert.equal(candidateTarget({ perDay: 20, candidates: 200 }), 200)
  assert.equal(sanitizeConfig({ candidates: 999 }).candidates, 200)
})
