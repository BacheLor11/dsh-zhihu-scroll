import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  countPicked, itemKeyOf, listMonthDays, mergeDay, monthlyReportPath, normalizePicked,
  questionKeyOf, readDay, readReport, recentPicked, renderMonthlyReport, renderReport, reportHistory,
  writeReport,
} from '../lib/report.mjs'
import { ensureHome } from '../lib/state.mjs'

test('normalizePicked 只留有标题和理由的条目', () => {
  const items = normalizePicked([
    {
      title: 'A', why: '好', url: 'https://a', tier: 'must',
      related: [
        { title: '同问题 B', url: 'https://b', author: '李四', votes: 8, why: '补了数据' },
        { title: '重复 A', url: 'https://a', why: '应该被丢掉' },
        { title: '没链接', url: '' },
        { title: '同问题 C', url: 'https://c' },
        { title: '同问题 D', url: 'https://d' },
      ],
    },
    { title: 'B', why: '' },
    { title: '', why: '好' },
    { title: 'A', why: '重复', url: 'https://a' },
    { title: 'C', why: '也不错', tier: '怪' },
  ])
  assert.equal(items.length, 2)
  assert.equal(items[0].tier, 'must')
  assert.equal(items[1].tier, 'worth')
  assert.equal(items[0].related.length, 3)
  assert.equal(items[0].related[0].title, '同问题 B')
  assert.deepEqual(items[0].related.map((x) => x.title), ['同问题 B', '同问题 C', '同问题 D'])
})

test('报告合并、计数、渲染', () => {
  const home = ensureHome(mkdtempSync(join(tmpdir(), 'zhihu-report-')))
  try {
    const day = '2026-10-23'
    const r1 = mergeDay(home, day, {
      summary: '今天挑了两条',
      items: [
        {
          title: '第一条', url: 'https://www.zhihu.com/question/1/answer/2', why: '有数据', tier: 'must',
          author: '张三', votes: 1234,
          related: [{ title: '同问题另一条', url: 'https://www.zhihu.com/question/1/answer/3', author: '李四', votes: 8, why: '补了数据' }],
        },
        { title: '第二条', url: 'https://zhuanlan.zhihu.com/p/9', why: '讲得直', tier: 'fun', author: '李四' },
      ],
    })
    assert.equal(r1.added, 2)
    assert.equal(countPicked(home, day), 2)

    const r2 = mergeDay(home, day, {
      items: [{ title: '第一条', url: 'https://www.zhihu.com/question/1/answer/2', why: '重复' }],
    })
    assert.equal(r2.added, 0)
    assert.equal(countPicked(home, day), 2)

    const d = readDay(home, day)
    const md = renderReport(d, 'full')
    assert.match(md, /# 刷知乎 · 2026-10-23/)
    assert.match(md, /## 必读/)
    assert.match(md, /## 一乐/)
    assert.match(md, /为什么值得：有数据/)
    assert.match(md, /赞同 1234/)
    assert.match(md, /同问题下还有/)
    assert.match(md, /李四的回答/)

    const wrote = writeReport(home, d, 'full')
    assert.ok(wrote.file && existsSync(wrote.file))
    assert.match(readFileSync(wrote.file, 'utf8'), /第一条/)

    assert.equal(recentPicked(home, 5).length, 2)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('月度文章：最新一天/最新条目在前，同一天增量合并且不丢旧内容', async () => {
  const home = ensureHome(mkdtempSync(join(tmpdir(), 'zhihu-monthly-')))
  try {
    const d1 = '2026-10-22'
    const d2 = '2026-10-23'
    mergeDay(home, d1, {
      summary: '第一天',
      items: [{ title: '【旧】十月二十二', url: 'https://a/1', why: '旧', tier: 'worth' }],
    })
    mergeDay(home, d2, {
      summary: '第二天',
      items: [{ title: '【早】十月二十三第一条', url: 'https://a/2', why: '早', tier: 'worth' }],
    })
    let md = renderMonthlyReport(home, d2, 'full')
    assert.match(md, /# 大肥鱼带你刷知乎 · 2026年10月/)
    assert.ok(md.indexOf('## 2026-10-23') < md.indexOf('## 2026-10-22'))
    assert.match(md, /【旧】/)

    await new Promise((r) => setTimeout(r, 5))
    mergeDay(home, d2, {
      items: [{ title: '【新】十月二十三第二条', url: 'https://a/3', why: '新', tier: 'worth' }],
    })
    md = renderMonthlyReport(home, d2, 'full')
    assert.match(md, /【新】/)
    assert.ok(md.indexOf('【新】') < md.indexOf('【早】'), '同一天的新条目应该排在旧条目前面')
    assert.equal(readDay(home, d2).items.length, 2, '同一天增量合并，不是覆盖')

    const wrote = writeReport(home, readDay(home, d2), 'full')
    assert.equal(wrote.file, monthlyReportPath(home, d2))
    assert.ok(existsSync(wrote.file))
    assert.match(readReport(home, d2), /【新】/)
    assert.equal(listMonthDays(home, d2).length, 2)

    const d3 = '2026-11-01'
    mergeDay(home, d3, { items: [{ title: '【十一月】', url: 'https://b/1', why: '新月份', tier: 'must' }] })
    writeReport(home, readDay(home, d3), 'full')
    assert.match(monthlyReportPath(home, d3), /大肥鱼带你刷知乎2026年11月\.md$/)
    assert.doesNotMatch(readReport(home, d2), /【十一月】/)
    assert.match(readReport(home, d3), /【十一月】/)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('level=off 不写 md，但 JSON 还在', () => {
  const home = ensureHome(mkdtempSync(join(tmpdir(), 'zhihu-report-off-')))
  try {
    const day = '2026-10-24'
    const { data } = mergeDay(home, day, { items: [{ title: 'X', url: 'u', why: 'w' }] })
    const wrote = writeReport(home, data, 'off')
    assert.equal(wrote.skipped, true)
    assert.equal(wrote.file, '')
    assert.equal(countPicked(home, day), 1)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('报告历史：精确键、近 30 天问题、今天作者、近 7 天作者', () => {
  const home = ensureHome(mkdtempSync(join(tmpdir(), 'zhihu-history-')))
  try {
    const today = '2026-10-24'
    mergeDay(home, '2026-09-01', {
      items: [{ title: '很久以前', url: 'https://www.zhihu.com/question/11/answer/1', why: '旧', author: '旧作者' }],
    })
    mergeDay(home, '2026-10-20', {
      items: [{
        title: '近几天', url: 'https://www.zhihu.com/question/22/answer/2', why: '近', author: '近作者',
        related: [{ title: '相关', url: 'https://www.zhihu.com/question/22/answer/3' }],
      }],
    })
    mergeDay(home, today, {
      items: [{ title: '今天', url: 'https://www.zhihu.com/question/33/answer/4', why: '今', author: '今作者' }],
    })
    const h = reportHistory(home, today)
    assert.ok(h.allKeys.has('https://www.zhihu.com/question/11/answer/1'))
    assert.ok(h.allKeys.has('https://www.zhihu.com/question/22/answer/3'), 'related 也要进精确键')
    assert.ok(h.recentQuestions.has('22'))
    assert.ok(h.recentQuestions.has('33'))
    assert.ok(!h.recentQuestions.has('11'), '超过 30 天的问题不再挡')
    assert.ok(h.todayAuthors.has('今作者'))
    assert.ok(!h.todayAuthors.has('近作者'))
    assert.ok(h.recentAuthors.has('近作者'))
    assert.ok(h.recentAuthors.has('今作者'))
    assert.ok(!h.recentAuthors.has('旧作者'), '超过 7 天的作者不降权')
    assert.equal(questionKeyOf({ url: 'https://www.zhihu.com/question/44/answer/5' }), '44')
    assert.equal(itemKeyOf({ id: 'x' }), 'x')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
