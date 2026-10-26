import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ZhihuClient, allocateQuotas, normalizeHotItem, parseRef, webUrlOf } from '../lib/zhihu.mjs'
import { ensureHome, writeAuth } from '../lib/state.mjs'
import { dayKey } from '../lib/config.mjs'
import { mergeDay } from '../lib/report.mjs'

const home = ensureHome(mkdtempSync(join(tmpdir(), 'zhihu-client-')))
let server
let base

const json = (res, code, body, type = 'application/json') => {
  res.writeHead(code, { 'content-type': type })
  res.end(typeof body === 'string' ? body : JSON.stringify(body))
}

const HOT = {
  data: [
    { type: 'hot_list_feed', target: { id: 101, type: 'question', title: '如何评价 X？', excerpt: '摘要 A', metrics: { hot: '123 万热度' } } },
    { type: 'hot_list_feed', target: { id: 102, type: 'question', title: 'Y 是什么体验？', excerpt: '摘要 B' } },
  ],
}

const RECOMMEND = {
  data: [
    {
      type: 'answer',
      target: {
        id: 201, type: 'answer', content: '<p>正文一</p><p>第二段</p>', excerpt: '摘要',
        voteup_count: 1234, comment_count: 56, author: { name: '张三' },
        question: { id: 900, title: '一个大问题' }, url: 'https://api.zhihu.com/answers/201',
      },
    },
    {
      type: 'article',
      target: {
        id: 202, type: 'article', title: '一篇文章', content: '<p>文章正文</p>', voteup_count: 10,
        author: { name: '李四' }, url: 'https://zhuanlan.zhihu.com/p/202',
      },
    },
    { type: 'ad', target: { id: 1, title: '这是广告', type: 'ad' } },
  ],
}

const ANSWER_201 = {
  id: 201, type: 'answer', content: '<p>全文正文</p><p>第二段全文</p>', voteup_count: 1234,
  comment_count: 56, author: { name: '张三' }, question: { id: 900, title: '一个大问题' },
}

before(async () => {
  writeAuth(home, { cookie: 'z_c0=test; d_c0=test; _xsrf=xsrf', userAgent: 'zhihu-test', hasAuth: true, xsrf: 'xsrf' })
  server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x')
    const p = u.pathname
    if (p === '/api/v3/feed/topstory/hot-lists/total') return json(res, 200, HOT)
    if (p === '/api/v3/feed/topstory/recommend') return json(res, 200, RECOMMEND)
    if (p === '/api/v3/feed/topstory') return json(res, 200, RECOMMEND)
    if (p === '/api/v4/answers/201') return json(res, 200, ANSWER_201)
    if (p === '/api/v4/answers/401') return json(res, 401, { error: { message: '身份未经过验证' } })
    if (p === '/api/v4/answers/403') return json(res, 403, '<html><head><meta id="zh-zse-ck" content="x"></head><body>安全验证</body></html>', 'text/html')
    if (p === '/api/v4/answers/999') return json(res, 404, { error: 'not found' })
    if (p === '/api/v4/answers/201/comments') {
      return json(res, 200, {
        data: [{ id: 1, content: '<p>说得好</p>', author: { name: '评论者' }, vote_count: 7, reply_count: 2, created_time: 1 }],
      })
    }
    if (p === '/api/v4/questions/900') {
      return json(res, 200, { id: 900, title: '一个大问题', detail: '<p>问题描述</p>', answer_count: 42, follower_count: 7 })
    }
    if (p === '/api/v4/questions/900/answers') {
      return json(res, 200, {
        data: [{ id: 301, type: 'answer', content: '<p>回答一</p>', voteup_count: 5, author: { name: '王五' }, question: { id: 900, title: '一个大问题' } }],
      })
    }
    if (p === '/api/v4/articles/202') {
      return json(res, 200, { id: 202, type: 'article', title: '一篇文章', content: '<p>文章全文</p>', voteup_count: 10, author: { name: '李四' } })
    }
    if (p === '/api/v4/me') return json(res, 200, { name: '我', url_token: 'me', headline: '签名' })
    if (p === '/api/v4/members/me/followees') {
      return json(res, 200, { data: [{ url_token: 'u1' }, { url_token: 'u2' }] })
    }
    if (p === '/api/v4/members/u1/answers') {
      return json(res, 200, {
        data: [{
          id: 501, type: 'answer', content: '<p>u1 的回答：大模型与工作流</p>', excerpt: '大模型',
          voteup_count: 99, comment_count: 8, author: { name: 'U1' },
          question: { id: 901, title: 'AI 问题：大模型怎么落地' }, url: 'https://api.zhihu.com/answers/501',
        }],
      })
    }
    if (p === '/api/v4/members/u1/articles') return json(res, 200, { data: [] })
    if (p === '/api/v4/members/u2/answers') return json(res, 200, { data: [] })
    if (p === '/api/v4/members/u2/articles') {
      return json(res, 200, {
        data: [{
          id: 502, type: 'article', title: 'U2 的文章：独立开发', content: '<p>文章正文</p>',
          voteup_count: 5, author: { name: 'U2' }, url: 'https://zhuanlan.zhihu.com/p/502',
        }],
      })
    }
    return json(res, 404, { error: 'no route ' + p })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${server.address().port}`
})

after(async () => {
  await new Promise((resolve) => server.close(resolve))
  rmSync(home, { recursive: true, force: true })
})

const client = () => new ZhihuClient({ home, base, gapMs: 0, timeoutMs: 3000 })

test('parseRef / webUrlOf', () => {
  assert.deepEqual(parseRef('https://www.zhihu.com/question/900/answer/201'), { kind: 'answer', id: '201', questionId: '900' })
  assert.deepEqual(parseRef('question:900'), { kind: 'question', id: '900' })
  assert.deepEqual(parseRef('p:202'), { kind: 'article', id: '202' })
  assert.equal(webUrlOf('answer', '201', '900'), 'https://www.zhihu.com/question/900/answer/201')
})

test('热榜归一化', async () => {
  const items = await client().hot(2)
  assert.equal(items.length, 2)
  assert.equal(items[0].id, '101')
  assert.equal(items[0].kind, 'question')
  assert.equal(items[0].url, 'https://www.zhihu.com/question/101')
  assert.match(items[0].hot, /123/)
})

test('新热榜结构（title_area/metrics_area）能归一化', () => {
  const it = normalizeHotItem({
    type: 'hot_list_feed',
    card_id: 'Q_2097190763675309990',
    feed_specific: { answer_count: 150 },
    target: {
      title_area: { text: 'Kimi K3.1 Pro 正式发布，如何评价该新模型？' },
      excerpt_area: { text: 'Kimi 发布新模型，值得关注的亮点。' },
      metrics_area: { text: '1006 万热度' },
    },
  })
  assert.equal(it.id, '2097190763675309990')
  assert.equal(it.kind, 'question')
  assert.equal(it.title, 'Kimi K3.1 Pro 正式发布，如何评价该新模型？')
  assert.equal(it.url, 'https://www.zhihu.com/question/2097190763675309990')
  assert.equal(it.hot, '1006 万热度')
  assert.equal(it.heat, 10060000)
  assert.equal(it.answerCount, 150)
  assert.equal(it.source, 'hot')

  const old = normalizeHotItem({ type: 'hot_list_feed', target: { id: 101, type: 'question', title: '旧热榜', excerpt: '旧摘要' } })
  assert.equal(old.id, '101')
  assert.equal(old.title, '旧热榜')
})

test('推荐流跳过广告，答案/文章都归一化', async () => {
  const items = await client().recommend(5)
  assert.equal(items.length, 2)
  assert.equal(items[0].kind, 'answer')
  assert.equal(items[0].title, '一个大问题')
  assert.equal(items[0].url, 'https://www.zhihu.com/question/900/answer/201')
  assert.match(items[0].content, /正文一/)
  assert.equal(items[1].kind, 'article')
  assert.equal(items[1].url, 'https://zhuanlan.zhihu.com/p/202')
})

test('mixed 去重后按 limit 截断', async () => {
  const items = await client().feed({ source: 'mixed', limit: 4 })
  assert.equal(items.length, 4)
  const keys = new Set(items.map((x) => `${x.kind}:${x.id}`))
  assert.equal(keys.size, 4)
})

test('读答案全文', async () => {
  const it = await client().item('https://www.zhihu.com/question/900/answer/201')
  assert.equal(it.kind, 'answer')
  assert.match(it.content, /全文正文/)
  assert.match(it.content, /第二段全文/)
  assert.equal(it.relatedAnswers.length, 1)
  assert.equal(it.relatedAnswers[0].id, '301')
  assert.equal(it.relatedAnswers[0].url, 'https://www.zhihu.com/question/900/answer/301')
  assert.match(it.relatedAnswers[0].content, /回答一/)
})

test('读问题 + 前几条回答', async () => {
  const it = await client().item('question:900')
  assert.equal(it.kind, 'question')
  assert.equal(it.answerCount, 42)
  assert.equal(it.answers.length, 1)
  assert.match(it.answers[0].content, /回答一/)
})

test('读文章全文', async () => {
  const it = await client().item('p:202')
  assert.equal(it.kind, 'article')
  assert.match(it.content, /文章全文/)
})

test('评论归一化', async () => {
  const comments = await client().comments('answer:201', 5)
  assert.equal(comments.length, 1)
  assert.equal(comments[0].author, '评论者')
  assert.match(comments[0].content, /说得好/)
})

test('401 映射成 not_logged_in', async () => {
  await assert.rejects(() => client().item('answer:401'), (e) => e.code === 'not_logged_in')
})

test('403 验证页映射成 challenge', async () => {
  await assert.rejects(() => client().item('answer:403'), (e) => e.code === 'challenge')
})

test('404 映射成 not_found', async () => {
  await assert.rejects(() => client().item('answer:999'), (e) => e.code === 'not_found')
})

test('诊断六项都能过', async () => {
  const items = await client().test()
  assert.equal(items.length, 6)
  assert.ok(items.every((x) => x.ok), JSON.stringify(items))
})

test('allocateQuotas 按权重分名额且总数守恒', () => {
  assert.deepEqual(allocateQuotas([['a', 3], ['b', 1]], 10), [['a', 8], ['b', 2]])
  assert.deepEqual(allocateQuotas([['a', 1], ['b', 1], ['c', 1]], 7), [['a', 3], ['b', 2], ['c', 2]])
  assert.deepEqual(allocateQuotas([['a', 0]], 5), [])
})

test('关注列表 + 关注的人', async () => {
  const c = client()
  const users = await c.followees(5)
  assert.deepEqual(users.slice(0, 2), ['u1', 'u2'])
  const items = await c.followingUsers(2, ['u1'])
  assert.ok(items.length >= 1)
  assert.equal(items[0].source, 'followingUsers')
  assert.match(items[0].content, /大模型/)
})

test('按来源权重混合 + 领域排序', async () => {
  const r = await client().collect({
    limit: 6,
    cfg: {
      sources: { recommend: 3, hot: 2, following: 1, followingUsers: 1 },
      domains: { ai: 5 },
      quality: {},
      keywords: ['大模型'],
      followingUsers: [],
    },
  })
  assert.ok(r.items.length > 0)
  assert.equal(r.quotas.reduce((s, [, q]) => s + q, 0), 6)
  assert.ok(r.quotas.some(([id]) => id === 'followingUsers'))
  assert.ok(r.items.some((x) => x.source === 'followingUsers'))
  for (let i = 1; i < r.items.length; i++) assert.ok(r.items[i - 1].score >= r.items[i].score)
  assert.ok(r.items.some((x) => (x.domains || []).includes('ai')), JSON.stringify(r.items.map((x) => x.domains)))
})

test('me 能读昵称', async () => {
  const me = await client().me()
  assert.equal(me.name, '我')
})

test('网络不通映射成 network', async () => {
  const c = new ZhihuClient({ home, base: 'http://127.0.0.1:1', gapMs: 0, timeoutMs: 800 })
  await assert.rejects(() => c.hot(1), (e) => e.code === 'network')
})

test('collect 过滤近期报告里的同问题/同作者内容', async () => {
  const h = ensureHome(mkdtempSync(join(tmpdir(), 'zhihu-history-client-')))
  try {
    writeAuth(h, { cookie: 'z_c0=test; d_c0=test; _xsrf=xsrf', userAgent: 'zhihu-test', hasAuth: true, xsrf: 'xsrf' })
    mergeDay(h, dayKey(), {
      items: [
        { title: '已收问题', url: 'https://www.zhihu.com/question/900/answer/999', why: 'x', author: '李四' },
        { title: '已收作者', url: 'https://www.zhihu.com/question/901/answer/998', why: 'x', author: '张三' },
      ],
    })
    const c = new ZhihuClient({ home: h, base, gapMs: 0, timeoutMs: 3000 })
    const r = await c.collect({ limit: 5, cfg: { sources: { recommend: 1 }, domains: {}, keywords: [] } })
    assert.equal(r.items.length, 0)
    assert.ok(!r.items.some((x) => x.url.includes('/question/900/')))
    assert.ok(!r.items.some((x) => x.author === '张三'))
  } finally {
    rmSync(h, { recursive: true, force: true })
  }
})
