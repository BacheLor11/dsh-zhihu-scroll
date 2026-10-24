import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defaultHomeDir, homeDir, writeHomeLocation } from '../lib/state.mjs'

test('数据目录指针：默认 → 自定义，环境变量优先', () => {
  const oldDsh = process.env.DSH_HOME
  const oldZhihu = process.env.DSH_ZHIHU_HOME
  const root = mkdtempSync(join(tmpdir(), 'zhihu-loc-'))
  process.env.DSH_HOME = root
  delete process.env.DSH_ZHIHU_HOME
  try {
    assert.equal(defaultHomeDir(), join(root, 'zhihu-duty'))
    assert.equal(homeDir(), join(root, 'zhihu-duty'))
    const custom = join(root, 'my-data')
    assert.equal(writeHomeLocation(custom), true)
    assert.equal(homeDir(), custom)
    assert.equal(defaultHomeDir(), join(root, 'zhihu-duty'))
    process.env.DSH_ZHIHU_HOME = '/tmp/env-fixed'
    assert.equal(homeDir(), '/tmp/env-fixed')
  } finally {
    if (oldDsh === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = oldDsh
    if (oldZhihu === undefined) delete process.env.DSH_ZHIHU_HOME
    else process.env.DSH_ZHIHU_HOME = oldZhihu
    rmSync(root, { recursive: true, force: true })
  }
})
