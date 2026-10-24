import { test } from 'node:test'
import assert from 'node:assert/strict'
import { htmlToText, decodeEntities, plainExcerpt } from '../lib/html.mjs'

test('htmlToText 保留段落、列表和图片占位', () => {
  const html = '<p>第一段 &amp; 一点东西</p><p>第二段<br>换行</p><ul><li>甲</li><li>乙</li></ul><figure><img src="x"></figure><script>alert(1)</script>'
  const text = htmlToText(html)
  assert.match(text, /第一段 & 一点东西/)
  assert.match(text, /第二段\n换行/)
  assert.match(text, /· 甲/)
  assert.match(text, /· 乙/)
  assert.match(text, /\[图\]/)
  assert.doesNotMatch(text, /alert/)
})

test('decodeEntities 认得命名/十进制/十六进制', () => {
  assert.equal(decodeEntities('&lt;a&gt; &amp; &#39;x&#39; &#x4e2d;'), "<a> & 'x' 中")
  assert.equal(decodeEntities('&nbsp;'), ' ')
  assert.equal(decodeEntities('&notareal;'), '&notareal;')
})

test('htmlToText 会截断并标注', () => {
  const text = htmlToText('<p>' + '字'.repeat(50) + '</p>', { maxChars: 10 })
  assert.ok(text.length < 60)
  assert.match(text, /已截断/)
})

test('plainExcerpt 压掉空白', () => {
  assert.equal(plainExcerpt('<p>a\n\n b   c</p>', 100), 'a b c')
})
