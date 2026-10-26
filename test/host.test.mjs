import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'zhihu-host-'))
let zhihuServer
let hostServer
let hostBase
let disposers = []
let tools = []
const delivered = []
let handler

const json = (res, code, body) => {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

const HOT = { data: [{ type: 'hot_list_feed', target: { id: 101, type: 'question', title: '热榜问题', excerpt: '摘要' } }] }
const REC = {
  data: [{
    type: 'answer',
    target: {
      id: 201, type: 'answer', content: '<p>正文</p>', voteup_count: 10, comment_count: 1,
      author: { name: '张三' }, question: { id: 900, title: 'AI 大模型问题' },
    },
  }],
}
const FOLLOWEES = { data: [{ url_token: 'u1' }] }
const U1_ANSWERS = {
  data: [{
    id: 501, type: 'answer', content: '<p>u1 讲大模型</p>', voteup_count: 5,
    author: { name: 'U1' }, question: { id: 901, title: 'AI 问题' },
  }],
}

before(async () => {
  zhihuServer = http.createServer((req, res) => {
    const p = new URL(req.url, 'http://x').pathname
    if (p === '/api/v4/me') return json(res, 200, { name: '测试号', url_token: 'tester' })
    if (p === '/api/v3/feed/topstory/hot-lists/total') return json(res, 200, HOT)
    if (p === '/api/v3/feed/topstory/recommend') return json(res, 200, REC)
    if (p === '/api/v3/feed/topstory') return json(res, 200, REC)
    if (p === '/api/v4/members/me/followees') return json(res, 200, FOLLOWEES)
    if (p === '/api/v4/members/u1/answers') return json(res, 200, U1_ANSWERS)
    if (p === '/api/v4/members/u1/articles') return json(res, 200, { data: [] })
    return json(res, 404, { error: 'mock: no ' + p })
  })
  await new Promise((r) => zhihuServer.listen(0, '127.0.0.1', r))
  process.env.ZHIHU_DUTY_API_BASE = `http://127.0.0.1:${zhihuServer.address().port}`
  process.env.DSH_ZHIHU_HOME = home
  process.env.DSH_HOME = join(home, 'dsh-home')

  const fakeSession = {
    id: 'session-test',
    header: { cwd: home, createdAt: Date.now() },
    requestHeader: () => ({ config: { provider: 'mock', model: 'mock' } }),
    deriveMessages: () => [],
  }
  const fakeParent = { session: fakeSession, options: {}, followup: (msg) => delivered.push(msg) }
  const fakeAgents = { roots: () => [fakeParent], get: (id) => (id === fakeSession.id ? fakeParent : null) }
  const services = { agents: fakeAgents }
  const mod = await import('../index.js')
  const ctx = {
    tools: { register: (t) => { tools.push(t); return () => {} } },
    webServer: { register: (r) => { handler = r.handler; return () => {} } },
    effect: (fn) => { const d = fn(); if (typeof d === 'function') disposers.push(d); return d },
    get: (n) => services[n],
    on: () => () => {},
  }
  mod.apply(ctx)
  delete process.env.DSH_ZHIHU_HOME

  hostServer = http.createServer((req, res) => {
    handler(req, res, new URL(req.url, 'http://127.0.0.1'))
  })
  await new Promise((r) => hostServer.listen(0, '127.0.0.1', r))
  hostBase = `http://127.0.0.1:${hostServer.address().port}`
})

after(async () => {
  for (const d of disposers) { try { d() } catch { /* 忽略 */ } }
  await new Promise((r) => hostServer?.close(r))
  await new Promise((r) => zhihuServer?.close(r))
  rmSync(home, { recursive: true, force: true })
})

const get = async (p) => {
  const r = await fetch(hostBase + p)
  return { status: r.status, body: await r.json() }
}
const post = async (p, body) => {
  const r = await fetch(hostBase + p, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body || {}),
  })
  return { status: r.status, body: await r.json() }
}

test('工具都挂上了', () => {
  const names = tools.map((t) => t.name)
  for (const n of ['zhihu_feed', 'zhihu_hot', 'zhihu_item', 'zhihu_comments', 'zhihu_report_save', 'zhihu_status']) {
    assert.ok(names.includes(n), `缺工具 ${n}：${names.join(',')}`)
  }
  assert.ok(!names.includes('zhihu_vote'), '不应该再有 zhihu_vote（这一版不做互动）')
  const save = tools.find((t) => t.name === 'zhihu_report_save')
  assert.equal(save.parameters.type, 'object')
  assert.deepEqual(save.parameters.required, ['items'])
})

test('status 初始形状', async () => {
  const { status, body } = await get('/api/zhihu-duty/status')
  assert.equal(status, 200)
  assert.equal(body.ok, true)
  assert.equal(body.version, '0.3.3')
  assert.equal(body.cfg.perDay, 3)
  assert.equal(body.cfg.domains.ai, 4)
  assert.equal(body.cfg.sources.following, 4)
  assert.deepEqual(body.cfg.followingUsers, [])
  assert.equal(body.auth.configured, false)
  assert.equal(body.today.picked, 0)
  assert.ok(body.home)
})

test('config 能改且会钳范围', async () => {
  const r = await post('/api/zhihu-duty/config', {
    cfg: {
      perDay: 999,
      auto: true,
      sources: { recommend: 1, hot: 4, following: 2, followingUsers: 0 },
      domains: { ai: 9, tech: -2 },
      quality: { depth: 6 },
      followingUsers: ['https://www.zhihu.com/people/u1', 'u1', 'bad name!'],
    },
  })
  assert.equal(r.status, 200)
  assert.equal(r.body.cfg.perDay, 20)
  assert.equal(r.body.cfg.auto, true)
  assert.equal(r.body.cfg.sources.hot, 4)
  assert.equal(r.body.cfg.domains.ai, 5)
  assert.equal(r.body.cfg.domains.tech, 0)
  assert.equal(r.body.cfg.quality.depth, 5)
  assert.deepEqual(r.body.cfg.followingUsers, ['u1'])
  assert.equal('autoVote' in r.body.cfg, false)
  const s = await get('/api/zhihu-duty/status')
  assert.equal(s.body.cfg.auto, true)
})

test('zhihu_feed 按权重混合，能捞到关注的人', async () => {
  await post('/api/zhihu-duty/config', {
    cfg: {
      sources: { recommend: 1, hot: 1, following: 1, followingUsers: 1 },
      domains: { ai: 5 },
      candidates: 6,
    },
  })
  const feed = tools.find((t) => t.name === 'zhihu_feed')
  await post('/api/zhihu-duty/auth', { text: 'z_c0=test; d_c0=test' })
  const r = await feed.execute({ limit: 4 })
  assert.equal(r.ok, true)
  assert.equal(r.mode, 'weighted')
  assert.ok(r.count >= 1, JSON.stringify(r))
  assert.equal(r.quotas.reduce((s, q) => s + q.quota, 0), 4)
  assert.ok(r.items.some((x) => x.source === 'followingUsers'), JSON.stringify(r.items.map((x) => x.source)))
  const hot = await feed.execute({ source: 'hot', limit: 2 })
  assert.equal(hot.ok, true)
  assert.ok(hot.count >= 1)
})

test('Cookie 导入 + me 探测', async () => {
  const r = await post('/api/zhihu-duty/auth', { text: 'z_c0=abc; d_c0=def; _xsrf=x' })
  assert.equal(r.status, 200)
  assert.equal(r.body.configured, true)
  assert.equal(r.body.hasAuth, true)
  assert.equal(r.body.me.name, '测试号')
  const s = await get('/api/zhihu-duty/status')
  assert.equal(s.body.auth.configured, true)
  assert.equal(s.body.auth.hasAuth, true)
  assert.doesNotMatch(JSON.stringify(s.body), /abc/)
})

test('报告工具落盘、计数、卡片墙', async () => {
  const save = tools.find((t) => t.name === 'zhihu_report_save')
  const r = await save.execute({
    summary: '今天挑了一条',
    items: [{
      title: '一条值得读的回答',
      url: 'https://www.zhihu.com/question/1/answer/2',
      id: '2',
      kind: 'answer',
      author: '张三',
      votes: 1200,
      comments: 30,
      tier: 'must',
      why: '有数据、有一手经历',
      quote: '原文一句',
      related: [{ title: '同问题另一条', url: 'https://www.zhihu.com/question/1/answer/3', author: '李四', votes: 8, why: '补了数据' }],
    }],
  })
  assert.equal(r.ok, true)
  assert.equal(r.saved, true)
  assert.equal(r.picked, 1)
  assert.match(r.file, /out\/大肥鱼带你刷知乎\d{4}年\d{1,2}月\.md$/)

  const s = await get('/api/zhihu-duty/status')
  assert.equal(s.body.today.picked, 1)

  const rep = await get('/api/zhihu-duty/report')
  assert.equal(rep.body.exists, true)
  assert.match(rep.body.text, /# 大肥鱼带你刷知乎/)
  assert.match(rep.body.text, /一条值得读的回答/)
  assert.match(rep.body.text, /为什么值得：有数据/)
  assert.match(rep.body.text, /同问题下还有/)
  assert.match(rep.body.text, /李四的回答/)

  const items = await get('/api/zhihu-duty/items')
  assert.equal(items.body.items.length, 1)
  assert.equal(items.body.items[0].title, '一条值得读的回答')
  assert.equal(items.body.items[0].related.length, 1)

  const days = await get('/api/zhihu-duty/days')
  assert.equal(days.body.days.length, 1)
  assert.equal(days.body.days[0].day, rep.body.day)
})

test('zhihu_status 工具看得到今天和偏好', async () => {
  const st = tools.find((t) => t.name === 'zhihu_status')
  const r = await st.execute({})
  assert.equal(r.ok, true)
  assert.equal(r.picked, 1)
  assert.equal(r.authConfigured, true)
  assert.match(r.domains, /人工智能/)
  assert.match(r.sources, /热榜/)
})

test('手动按钮仍停用；定时只投目标对话', async () => {
  const r = await post('/api/zhihu-duty/run')
  assert.equal(r.status, 400)
  assert.match(r.body.error, /停用/)
  const s = await get('/api/zhihu-duty/status')
  assert.equal(s.body.running, false)
  assert.match(s.body.today.lastError, /停用/)
})

test('定时投递带 role/id，只发到选中的目标对话', async () => {
  const cur = await get('/api/zhihu-duty/config')
  await post('/api/zhihu-duty/config', { ...cur.body.cfg, dutySessionId: 'session-test' })
  const r = await post('/api/zhihu-duty/deliver-test')
  assert.equal(r.status, 200, JSON.stringify(r.body))
  assert.equal(delivered.length, 1)
  assert.equal(delivered[0].role, 'user')
  assert.match(delivered[0].id, /^[0-9a-f-]{36}$/i)
  assert.equal(delivered[0].source.kind, 'user')
  assert.match(delivered[0].content[0].text, /测试/)
  assert.equal(r.body.session, 'session-test')

  const s = await get('/api/zhihu-duty/status')
  assert.equal(s.body.sessions[0].id, 'session-test')
})

test('数据目录可以手动切换，旧数据复制过去', async () => {
  const before = await get('/api/zhihu-duty/status')
  assert.equal(before.body.home, home)
  assert.equal(before.body.homeLocked, false)
  assert.ok(before.body.defaultHome)

  const relative = await post('/api/zhihu-duty/home', { home: 'relative/dir' })
  assert.equal(relative.status, 400)
  assert.match(relative.body.error, /绝对路径/)

  const nested = await post('/api/zhihu-duty/home', { home: join(home, 'nested') })
  assert.equal(nested.status, 400)
  assert.match(nested.body.error, /嵌套/)

  const target = mkdtempSync(join(tmpdir(), 'zhihu-custom-'))
  const r = await post('/api/zhihu-duty/home', { home: target })
  assert.equal(r.status, 200, JSON.stringify(r.body))
  assert.equal(r.body.home, target)
  assert.ok(existsSync(join(target, 'config.json')))
  assert.ok(existsSync(join(target, 'auth.json')))
  const s1 = await get('/api/zhihu-duty/status')
  assert.equal(s1.body.home, target)

  const back = await post('/api/zhihu-duty/home', { home })
  assert.equal(back.status, 200)
  assert.equal(back.body.home, home)
  rmSync(target, { recursive: true, force: true })
})

test('同一来源重复交不会重复计数', async () => {
  const save = tools.find((t) => t.name === 'zhihu_report_save')
  const item = { title: '一条值得读的回答', url: 'https://www.zhihu.com/question/1/answer/2', why: '重复', tier: 'must' }
  const r = await save.execute({ summary: '重复交', items: [item] })
  assert.equal(r.saved, false)
  assert.equal(r.blocked, 'duplicates')
  assert.equal(r.added, 0)
  assert.equal(r.picked, 1)
  assert.equal(r.skipped.length, 1)
})

test('同问题不同回答、同日同作者都会被跳过', async () => {
  const save = tools.find((t) => t.name === 'zhihu_report_save')
  const sameQ = await save.execute({
    summary: '同问题另一条',
    items: [{ title: '同问题另一条回答', url: 'https://www.zhihu.com/question/1/answer/3', why: '重复问题', author: '李四' }],
  })
  assert.equal(sameQ.saved, false)
  assert.equal(sameQ.blocked, 'duplicates')
  assert.ok(sameQ.skipped.some((x) => x.reason === 'question' || x.reason === 'repeat'))

  const sameA = await save.execute({
    summary: '同作者',
    items: [{ title: '同作者另一条', url: 'https://www.zhihu.com/question/2/answer/4', why: '重复作者', author: '张三' }],
  })
  assert.equal(sameA.saved, false)
  assert.ok(sameA.skipped.some((x) => x.reason === 'author'))
})

test('每天额度满了，手动再交仍然增量写进月度文章', async () => {
  const cur = await get('/api/zhihu-duty/config')
  await post('/api/zhihu-duty/config', { ...cur.body.cfg, perDay: 1 })
  const save = tools.find((t) => t.name === 'zhihu_report_save')
  const r = await save.execute({
    summary: '手动补充一条',
    items: [{
      title: '超额的一条',
      url: 'https://www.zhihu.com/question/9/answer/99',
      why: '手动补的',
      tier: 'worth',
    }],
  })
  assert.equal(r.saved, true)
  assert.equal(r.picked, 2)
  assert.equal(r.overQuota, 1)
  const rep = await get('/api/zhihu-duty/report')
  assert.match(rep.body.text, /超额的一条/)
})

test('状态里带精确时间点模式和下一次', async () => {
  const cur = await get('/api/zhihu-duty/config')
  await post('/api/zhihu-duty/config', { ...cur.body.cfg, scheduleTimes: ['08:30', '12:30'] })
  const s = await get('/api/zhihu-duty/status')
  assert.equal(s.body.schedule.mode, 'times')
  assert.deepEqual(s.body.schedule.times, ['08:30', '12:30'])
  assert.ok(s.body.schedule.next)
})
