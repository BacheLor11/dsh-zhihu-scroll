import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DOMAINS, defaultDomainWeights, keywordHit, matchDomains, parseUserRef, sanitizeWeights,
} from '../lib/domains.mjs'

test('领域目录稳定且权重默认齐全', () => {
  assert.ok(DOMAINS.length >= 12)
  const w = defaultDomainWeights()
  for (const d of DOMAINS) assert.equal(typeof w[d.id], 'number')
})

test('keywordHit：英文按词边界，中文包含', () => {
  assert.equal(keywordHit('2026 年 ai 进展', 'ai'), true)
  assert.equal(keywordHit('he said nothing', 'ai'), false)
  assert.equal(keywordHit('大模型的落地', '大模型'), true)
  assert.equal(keywordHit('LLM agents', 'llm'), true)
})

test('matchDomains：命中多个领域时加权求和', () => {
  const r = matchDomains('大模型 与 程序员 的日常', { ai: 5, tech: 3, history: 5 })
  assert.deepEqual(r.ids.sort(), ['ai', 'tech'])
  assert.equal(r.score, 8)
  const none = matchDomains('今天吃什么', { ai: 5 })
  assert.deepEqual(none.ids, [])
  assert.equal(none.score, 0)
})

test('parseUserRef：主页链接 / @ / 裸 token', () => {
  assert.equal(parseUserRef('https://www.zhihu.com/people/abc'), 'abc')
  assert.equal(parseUserRef('https://www.zhihu.com/people/abc/answers?x=1'), 'abc')
  assert.equal(parseUserRef('@abc'), 'abc')
  assert.equal(parseUserRef('abc'), 'abc')
  assert.equal(parseUserRef('bad name!'), '')
  assert.equal(parseUserRef(''), '')
})

test('sanitizeWeights 只认已知键并钳 0..5', () => {
  const w = sanitizeWeights({ ai: 9, tech: -1, nope: 4 }, { ai: 1, tech: 1 })
  assert.deepEqual(w, { ai: 5, tech: 0 })
})
