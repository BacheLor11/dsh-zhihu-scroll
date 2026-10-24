import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseCookieInput } from '../lib/zhihu.mjs'

test('cURL 里抽 Cookie 和 UA', () => {
  const curl = `curl 'https://www.zhihu.com/api/v3/feed/topstory/recommend?limit=10' \\
  -H 'accept: application/json' \\
  -H 'cookie: z_c0=abc%3D%3D; d_c0=xyz; _xsrf=token123' \\
  -H 'user-agent: Mozilla/5.0 Test'`
  const r = parseCookieInput(curl)
  assert.equal(r.cookie, 'z_c0=abc%3D%3D; d_c0=xyz; _xsrf=token123')
  assert.equal(r.userAgent, 'Mozilla/5.0 Test')
  assert.equal(r.hasAuth, true)
  assert.equal(r.xsrf, 'token123')
  assert.equal(r.source, 'curl')
})

test('Cookie: 头也能吃', () => {
  const r = parseCookieInput('Cookie: z_c0=1; d_c0=2')
  assert.equal(r.cookie, 'z_c0=1; d_c0=2')
  assert.equal(r.hasAuth, true)
})

test('裸 Cookie 串也能吃', () => {
  const r = parseCookieInput('z_c0=1; d_c0=2; _xsrf=abc')
  assert.equal(r.source, 'raw')
  assert.equal(r.hasAuth, true)
})

test('没有 z_c0 时如实标记', () => {
  const r = parseCookieInput('d_c0=2')
  assert.equal(r.hasAuth, false)
})

test('明显不是 Cookie 的输入要报错', () => {
  assert.throws(() => parseCookieInput('https://www.zhihu.com/question/1'), /网址/)
  assert.throws(() => parseCookieInput('hello world'), /name=value/)
  assert.throws(() => parseCookieInput(''), /空的/)
})
