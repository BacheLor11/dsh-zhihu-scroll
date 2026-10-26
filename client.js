/**
 * dsh-zhihu-scroll —— 浏览器半端（设置里的一页「刷知乎」）
 * ============================================================================
 * 约定（跟 dsh-bili-scroll / dsh-meme 一致）：
 *   · client bundle 不是 ESM，是自注册脚本：window.__ModuleLoader__.load({ id, factory })
 *   · id 必须等于 package.json 的 name
 *   · 进「设置」：slots.inject('settings.section', () => slots.register({...}, () => h(Panel)))
 *
 * 2.0 的页面：
 *   日常   每天几条 / 候选数 / 手动跑说明 / 卡片墙 / 本月文章
 *   偏好   领域权重 + 来源权重 + 判断权重 + 关注的人 + 额外关键词 + 人设 / 文章
 *   账号   浏览器登录 → 复制 cURL → 剪贴板导入 / 手动粘贴 + 测一下
 *   高级   数据目录 / 本月文章 / 章程 / 日志 / 诊断
 * ============================================================================
 */
window.__ModuleLoader__.load({
  id: 'dsh-zhihu-scroll',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useRef, useCallback } = React

    const API = '/api/zhihu-duty'
    const asJson = async (res) => {
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`)
      return body
    }
    const jget = async (p) => asJson(await fetch(API + p, { credentials: 'same-origin' }))
    const jpost = async (p, body) => asJson(await fetch(API + p, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body || {}),
    }))

    const CSS = `
[data-zh-page]{display:flex;flex-direction:column;gap:16px;padding:2px 2px 14px;max-width:820px;box-sizing:border-box;}
[data-zh-head]{display:flex;align-items:center;gap:10px;flex-wrap:wrap;}
[data-zh-title]{font-size:18px;font-weight:650;letter-spacing:-.01em;}
[data-zh-badge]{font-size:10px;padding:2px 7px;border-radius:99px;border:1px solid var(--dsw-alias-bg-layer-3,rgba(128,128,128,.28));color:var(--dsw-alias-label-tertiary,#8a8f98);}
[data-zh-dot]{width:7px;height:7px;border-radius:50%;background:#22c55e;flex:none;box-shadow:0 0 0 3px rgba(34,197,94,.15);}
[data-zh-dot][data-off]{background:#9ca3af;box-shadow:none;}
[data-zh-dot][data-run]{background:#f59e0b;box-shadow:0 0 0 3px rgba(245,158,11,.18);animation:zh-pulse 1.2s infinite;}
@keyframes zh-pulse{50%{opacity:.45}}
[data-zh-tabs]{display:flex;gap:2px;border-bottom:1px solid var(--dsw-alias-bg-layer-3,rgba(128,128,128,.18));}
[data-zh-tab]{appearance:none;border:0;background:transparent;color:var(--dsw-alias-label-tertiary,#8a8f98);font:inherit;font-size:13px;padding:8px 12px;cursor:pointer;border-bottom:2px solid transparent;margin-bottom:-1px;}
[data-zh-tab][data-on]{color:#3b82f6;border-bottom-color:#3b82f6;font-weight:600;}
[data-zh-card]{border:1px solid var(--dsw-alias-bg-layer-3,rgba(128,128,128,.20));border-radius:12px;padding:14px;display:flex;flex-direction:column;gap:10px;background:var(--dsw-alias-bg-layer-1,transparent);}
[data-zh-card-h]{font-size:13px;font-weight:600;display:flex;align-items:center;gap:8px;flex-wrap:wrap;}
[data-zh-row]{display:flex;align-items:center;gap:10px;flex-wrap:wrap;}
[data-zh-grow]{flex:1;min-width:0;}
[data-zh-label]{font-size:13px;}
[data-zh-note]{font-size:11px;line-height:17px;color:var(--dsw-alias-label-tertiary,#8a8f98);}
[data-zh-note] b{color:var(--dsw-alias-label-secondary,#b8bdc6);font-weight:600;}
[data-zh-sw]{flex:none;width:38px;height:22px;border-radius:11px;border:0;cursor:pointer;position:relative;background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.35));transition:background .15s;padding:0;}
[data-zh-sw][data-on]{background:#3b82f6;}
[data-zh-sw] i{position:absolute;top:3px;left:3px;width:16px;height:16px;border-radius:50%;background:#fff;transition:left .15s;display:block;}
[data-zh-sw][data-on] i{left:19px;}
[data-zh-sw][disabled]{opacity:.45;cursor:default;}
[data-zh-sub]{margin-left:14px;padding-left:12px;border-left:2px solid var(--dsw-alias-bg-layer-3,rgba(128,128,128,.15));display:flex;flex-direction:column;gap:9px;}
[data-zh-input]{width:100%;box-sizing:border-box;padding:7px 9px;border-radius:8px;font-size:12px;border:1px solid var(--dsw-alias-bg-layer-3,rgba(128,128,128,.24));background:var(--dsw-alias-bg-layer-2,rgba(128,128,128,.08));color:inherit;font-family:inherit;resize:vertical;}
[data-zh-input]:focus{outline:none;border-color:#3b82f6;}
[data-zh-num]{width:76px;text-align:center;}
[data-zh-btn]{padding:7px 12px;border-radius:8px;font-size:12px;cursor:pointer;font-family:inherit;white-space:nowrap;border:1px solid var(--dsw-alias-bg-layer-3,rgba(128,128,128,.24));background:var(--dsw-alias-bg-layer-2,rgba(128,128,128,.10));color:inherit;}
[data-zh-btn]:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.20));}
[data-zh-btn][data-primary]{background:#3b82f6;border-color:#3b82f6;color:#fff;}
[data-zh-btn][data-danger]{color:#ef4444;border-color:rgba(239,68,68,.35);}
[data-zh-btn][disabled]{opacity:.5;cursor:default;}
[data-zh-msg]{font-size:11px;line-height:17px;padding:8px 10px;border-radius:8px;word-break:break-word;}
[data-zh-msg][data-tone=ok]{background:rgba(34,197,94,.10);border:1px solid rgba(34,197,94,.28);}
[data-zh-msg][data-tone=err]{background:rgba(239,68,68,.10);border:1px solid rgba(239,68,68,.30);}
[data-zh-msg][data-tone=info]{background:rgba(59,130,246,.09);border:1px solid rgba(59,130,246,.24);}
[data-zh-kv]{font-size:11px;line-height:19px;color:var(--dsw-alias-label-secondary,#b8bdc6);word-break:break-all;}
[data-zh-kv] b{color:var(--dsw-alias-label-primary,inherit);font-weight:600;}
[data-zh-list]{display:grid;grid-template-columns:1fr;gap:10px;}
[data-zh-item]{display:flex;flex-direction:column;gap:6px;padding:11px 12px;border-radius:10px;border:1px solid var(--dsw-alias-bg-layer-3,rgba(128,128,128,.18));background:var(--dsw-alias-bg-layer-1,transparent);}
[data-zh-item-h]{display:flex;gap:8px;align-items:flex-start;}
[data-zh-item-t]{font-size:13px;font-weight:600;line-height:19px;flex:1;min-width:0;}
[data-zh-item-t a]{color:inherit;text-decoration:none;}
[data-zh-item-t a:hover{color:#3b82f6;text-decoration:underline;}
[data-zh-why]{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary,#b8bdc6);}
[data-zh-meta]{font-size:10px;color:var(--dsw-alias-label-tertiary,#8a8f98);display:flex;gap:8px;flex-wrap:wrap;}
[data-zh-related]{font-size:11px;line-height:17px;color:var(--dsw-alias-label-tertiary,#8a8f98);display:flex;gap:6px;flex-wrap:wrap;align-items:baseline;}
[data-zh-related] a{color:#3b82f6;text-decoration:none;}
[data-zh-related] a:hover{text-decoration:underline;}
[data-zh-note]{font-size:11px;line-height:17px;color:var(--dsw-alias-label-tertiary,#8a8f98);margin-top:8px;}
[data-zh-tier]{flex:none;font-size:10px;padding:2px 7px;border-radius:99px;font-weight:600;}
[data-zh-tier=must]{background:rgba(239,68,68,.12);color:#ef4444;}
[data-zh-tier=worth]{background:rgba(59,130,246,.12);color:#3b82f6;}
[data-zh-tier=fun]{background:rgba(245,158,11,.14);color:#d97706;}
[data-zh-pre]{margin:0;padding:11px 12px;border-radius:10px;background:var(--dsw-alias-bg-layer-2,rgba(128,128,128,.08));font-size:11.5px;line-height:1.65;white-space:pre-wrap;word-break:break-word;max-height:420px;overflow:auto;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;}
[data-zh-empty]{font-size:12px;color:var(--dsw-alias-label-tertiary,#8a8f98);padding:6px 0;}
[data-zh-test]{display:flex;flex-direction:column;gap:7px;}
[data-zh-test-row]{display:flex;gap:8px;font-size:11.5px;line-height:17px;align-items:flex-start;}
[data-zh-test-ico]{flex:none;width:16px;text-align:center;}
[data-zh-grid2]{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:10px;}
[data-zh-weight]{display:grid;grid-template-columns:88px 1fr 26px;align-items:center;gap:8px;font-size:12px;padding:5px 0;border-bottom:1px dashed var(--dsw-alias-bg-layer-3,rgba(128,128,128,.14));}
[data-zh-weight]:last-child{border-bottom:0;}
[data-zh-weight] label{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
[data-zh-weight] output{text-align:right;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-tertiary,#8a8f98);font-size:11px;}
[data-zh-range]{width:100%;accent-color:#3b82f6;height:18px;margin:0;}
[data-zh-step]{font-size:11px;line-height:18px;color:var(--dsw-alias-label-secondary,#b8bdc6);}
[data-zh-details]{border:1px solid var(--dsw-alias-bg-layer-3,rgba(128,128,128,.18));border-radius:10px;padding:9px 11px;font-size:12px;}
[data-zh-details summary{cursor:pointer;color:var(--dsw-alias-label-secondary,#b8bdc6);}
`

    const fmtTime = (iso) => {
      if (!iso) return '—'
      const d = new Date(iso)
      if (Number.isNaN(d.getTime())) return String(iso)
      return d.toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
    }

    const Tier = ({ tier }) => {
      const label = tier === 'must' ? '必读' : tier === 'fun' ? '一乐' : '值得'
      return h('span', { 'data-zh-tier': tier || 'worth' }, label)
    }

    const Switch = ({ on, onChange, disabled }) => h('button', {
      type: 'button',
      'data-zh-sw': '',
      'data-on': on ? '' : undefined,
      disabled: Boolean(disabled),
      role: 'switch',
      'aria-checked': Boolean(on),
      onClick: () => { if (!disabled) onChange(!on) },
    }, h('i'))

    const Section = ({ title, extra, children }) => h('div', { 'data-zh-card': '' },
      h('div', { 'data-zh-card-h': '' }, title, extra || null),
      children)

    const Note = ({ children }) => h('div', { 'data-zh-note': '' }, children)

    /** 0..5 权重行；labels 可选（0/3/5 的文字） */
    const WeightRow = ({ label, hint, value, onChange }) => h('div', { 'data-zh-weight': '', title: hint || '' },
      h('label', null, label),
      h('input', {
        'data-zh-range': '', type: 'range', min: 0, max: 5, step: 1,
        value: Number(value) || 0,
        onChange: (e) => onChange(Number(e.target.value)),
      }),
      h('output', null, String(Number(value) || 0)))

    function Panel() {
      const [st, setSt] = useState(null)
      const [loadError, setLoadError] = useState('')
      const [tab, setTab] = useState('daily')
      const [busy, setBusy] = useState('')
      const [toast, setToast] = useState(null)
      const [items, setItems] = useState(null)
      const [report, setReport] = useState(null)
      const [logs, setLogs] = useState(null)
      const [tests, setTests] = useState(null)
      const [cookieText, setCookieText] = useState('')
      const [dailyDraft, setDailyDraft] = useState({ perDay: 3, candidates: 30, scheduleTimes: '' })
      const [prefsDraft, setPrefsDraft] = useState(null)
      const [homeDraft, setHomeDraft] = useState('')
      const [draftReady, setDraftReady] = useState(false)
      const homeInit = useRef(false)
      const alive = useRef(true)

      const say = (tone, text) => setToast({ tone, text, at: Date.now() })

      const initPrefs = (cfg) => ({
        domains: { ...(cfg.domains || {}) },
        sources: { ...(cfg.sources || {}) },
        quality: { ...(cfg.quality || {}) },
        followingUsers: (cfg.followingUsers || []).join('\n'),
        keywords: (cfg.keywords || []).join('\n'),
        persona: cfg.persona || '',
        reportLevel: cfg.reportLevel || 'full',
      })

      const loadStatus = useCallback(async () => {
        try {
          const s = await jget('/status')
          if (!alive.current) return
          setLoadError('')
          setSt(s)
          if (!draftReady) {
            setDailyDraft({ perDay: s.cfg.perDay, candidates: s.cfg.candidates, scheduleTimes: (s.cfg.scheduleTimes || []).join(', ') })
            setPrefsDraft(initPrefs(s.cfg))
            setDraftReady(true)
          }
        } catch (e) {
          if (!alive.current) return
          setLoadError(String(e?.message ?? e))
          setToast({ tone: 'err', text: `读不到插件状态：${e.message}` })
        }
      }, [draftReady])

      const loadItems = useCallback(async () => {
        try { const r = await jget('/items?limit=30'); if (alive.current) setItems(r.items || []) } catch { /* 忽略 */ }
      }, [])

      useEffect(() => {
        alive.current = true
        loadStatus()
        loadItems()
        return () => { alive.current = false }
      }, [loadStatus, loadItems])

      useEffect(() => {
        const t = setInterval(() => { loadStatus() }, 3000)
        return () => clearInterval(t)
      }, [loadStatus])

      // 跑完一轮后刷新卡片墙 + 本月文章
      const wasRunning = useRef(false)
      useEffect(() => {
        if (st?.running) { wasRunning.current = true; return }
        if (wasRunning.current) {
          wasRunning.current = false
          loadItems()
          if (report !== null) loadReport()
        }
      }, [st?.running])

      // 数据目录输入框只在第一次拿到状态时初始化，之后不覆盖用户正在输入的内容
      useEffect(() => {
        if (st?.home && !homeInit.current) {
          homeInit.current = true
          setHomeDraft(st.home)
        }
      }, [st?.home])

      const patchCfg = async (patch, quiet) => {
        try {
          setBusy('cfg')
          const r = await jpost('/config', { cfg: { ...(st?.cfg || {}), ...patch } })
          if (alive.current) {
            setSt((prev) => (prev ? { ...prev, cfg: r.cfg } : prev))
            if (!quiet) say('ok', '设置已保存')
          }
          return r.cfg
        } catch (e) {
          say('err', `保存失败：${e.message}`)
          throw e
        } finally { if (alive.current) setBusy('') }
      }

      const run = async () => {
        if (!st?.auth?.configured) {
          setTab('account')
          return say('err', '先登录知乎：账号页把浏览器复制的 cURL 粘进来')
        }
        try {
          setBusy('run')
          await jpost('/run')
          say('info', '这一轮已经开跑。它读正文要一会儿，页面会自动刷新。')
          await loadStatus()
        } catch (e) {
          say('err', `起不来：${e.message}`)
        } finally { if (alive.current) setBusy('') }
      }

      const deliverTest = async () => {
        if (!st?.cfg?.dutySessionId) return say('err', '先在「自动值班 → 定时投到」里选一个对话')
        try {
          setBusy('deliver')
          const r = await jpost('/deliver-test')
          say('ok', `已投递到「${r.title || r.session}」，去那边看它能不能回 OK。`)
        } catch (e) {
          say('err', `投递失败：${e.message}`)
        } finally { if (alive.current) setBusy('') }
      }

      const saveScheduleTimes = async () => {
        const arr = String(dailyDraft.scheduleTimes || '').split(/[\s,，;；]+/).map((x) => x.trim()).filter(Boolean)
        try {
          const next = await patchCfg({ scheduleTimes: arr }, true)
          if (alive.current) setDailyDraft((d) => ({ ...d, scheduleTimes: (next.scheduleTimes || []).join(', ') }))
          say('ok', `时间点：${(next.scheduleTimes || []).join('、') || '无（用午间/夜间窗口）'}`)
        } catch { /* patchCfg 已经提示 */ }
      }

      const setMidnight = async () => {
        try {
          await patchCfg({ scheduleTimes: ['00:00'], auto: true, noon: false, night: false }, true)
          if (alive.current) setDailyDraft((d) => ({ ...d, scheduleTimes: '00:00' }))
          say('ok', '已设为每天 00:00 一次；目标对话要开着')
        } catch { /* patchCfg 已提示 */ }
      }

      const cancel = async () => {
        try {
          setBusy('cancel')
          await jpost('/cancel')
          say('info', '已请求取消（当前这一步会停下来）')
        } catch (e) {
          say('err', e.message)
        } finally { if (alive.current) setBusy('') }
      }

      const loadReport = async () => {
        try {
          setBusy('report')
          const r = await jget('/report')
          if (alive.current) setReport(r)
        } catch (e) { say('err', e.message) } finally { if (alive.current) setBusy('') }
      }

      const importCookie = async (text) => {
        if (!String(text || '').trim()) return say('err', '先把 cURL 或 Cookie 粘进来')
        try {
          setBusy('auth')
          const r = await jpost('/auth', { text })
          setCookieText('')
          say('ok', `Cookie 已保存（${r.fields || '已写入'}${r.hasAuth ? '，带登录态' : '，但没看到 z_c0，可能没登录'}${r.me?.name ? ` · ${r.me.name}` : ''}）`)
          await loadStatus()
        } catch (e) {
          say('err', `Cookie 没存上：${e.message}`)
        } finally { if (alive.current) setBusy('') }
      }

      const importClipboard = async () => {
        let text = ''
        try {
          text = await navigator.clipboard.readText()
        } catch {
          return say('err', '浏览器没给剪贴板权限。展开下面的「手动粘贴」把 cURL 粘进来，或允许剪贴板权限后重试。')
        }
        if (!text.trim()) return say('err', '剪贴板是空的：先在 www.zhihu.com 的 DevTools 里 Copy as cURL（必须选 www.zhihu.com 的请求）')
        await importCookie(text)
      }

      const clearAuth = async () => {
        if (!window.confirm('确定退出（清空本机保存的知乎 Cookie）？')) return
        try {
          setBusy('auth')
          await jpost('/auth/clear')
          say('ok', '已退出')
          await loadStatus()
        } catch (e) { say('err', e.message) } finally { if (alive.current) setBusy('') }
      }

      const testConnection = async () => {
        try {
          setBusy('test')
          const r = await jpost('/test')
          setTests(r.items || [])
          const bad = (r.items || []).filter((x) => !x.ok).length
          say(bad ? 'err' : 'ok', bad ? `有 ${bad} 项没通，看下面每一条的说明` : '能测的链路都通了')
        } catch (e) { say('err', e.message) } finally { if (alive.current) setBusy('') }
      }

      const loadLogs = async () => {
        try {
          setBusy('logs')
          const r = await jget('/logs?lines=160')
          setLogs(r.text || '')
        } catch (e) { say('err', e.message) } finally { if (alive.current) setBusy('') }
      }

      const copy = async (text, what) => {
        try {
          await navigator.clipboard.writeText(String(text || ''))
          say('ok', `${what || '内容'}已复制`)
        } catch {
          say('err', '复制失败：浏览器没给剪贴板权限')
        }
      }

      const pickFolder = async () => {
        if (st?.homeLocked) return say('err', '当前数据目录由 DSH_ZHIHU_HOME 固定')
        const api = typeof window !== 'undefined' ? window.__DSH_DIRECTORY_PICKER__ : undefined
        if (!api?.pick) return say('err', '当前界面没有系统选文件夹，直接在输入框里填绝对路径')
        try {
          const picked = await api.pick()
          const path = typeof picked === 'string' ? picked : (picked?.path || '')
          if (path) setHomeDraft(path)
        } catch (e) { say('err', `选择文件夹失败：${e.message}`) }
      }

      const saveHome = async () => {
        if (st?.homeLocked) return say('err', '当前数据目录由 DSH_ZHIHU_HOME 固定，改不了')
        if (!String(homeDraft || '').trim()) return say('err', '先填一个目录')
        try {
          setBusy('home')
          const r = await jpost('/home', { home: homeDraft })
          setHomeDraft(r.home)
          await loadStatus()
          await loadItems()
          say('ok', r.reused
            ? '目标目录已有数据，已直接使用；旧目录保留'
            : `已切换，复制了 ${r.copied?.length || 0} 项旧数据；旧目录保留`)
        } catch (e) {
          say('err', `切换目录失败：${e.message}`)
        } finally { if (alive.current) setBusy('') }
      }

      const savePrefs = async () => {
        if (!prefsDraft) return
        const split = (s) => String(s || '').split(/[\n,，]+/).map((x) => x.trim()).filter(Boolean)
        try {
          setBusy('cfg')
          const cfg = await patchCfg({
            domains: prefsDraft.domains,
            sources: prefsDraft.sources,
            quality: prefsDraft.quality,
            followingUsers: split(prefsDraft.followingUsers),
            keywords: split(prefsDraft.keywords),
            persona: prefsDraft.persona,
            reportLevel: prefsDraft.reportLevel,
            perDay: Number(dailyDraft.perDay) || 0,
            candidates: Number(dailyDraft.candidates) || 30,
          }, true)
          setPrefsDraft(initPrefs(cfg))
          say('ok', '偏好已保存，下一轮生效')
        } catch { /* patchCfg 已经提示 */ } finally { if (alive.current) setBusy('') }
      }

      if (!st) {
        return h('div', { 'data-zh-page': '' },
          h('div', { 'data-zh-head': '' }, h('span', { 'data-zh-title': '' }, '刷知乎')),
          loadError
            ? h('div', { 'data-zh-msg': '', 'data-tone': 'err' },
              `读不到插件状态：${loadError}`,
              h('div', { 'data-zh-row': '', style: { marginTop: '8px' } },
                h('button', { 'data-zh-btn': '', onClick: () => loadStatus() }, '重试')))
            : h('div', { 'data-zh-msg': '', 'data-tone': 'info' }, '正在读取插件状态…（第一次加载可能要多等两秒）'))
      }

      const cfg = st.cfg
      const sessions = Array.isArray(st.sessions) ? st.sessions : []
      const targetMissing = Boolean(cfg.dutySessionId) && !sessions.some((x) => x.id === cfg.dutySessionId)
      const authOk = Boolean(st.auth?.configured)
      const loggedIn = Boolean(st.auth?.configured && st.auth?.hasAuth)
      const todayCount = st.today?.picked || 0
      const quota = cfg.perDay > 0 ? `${todayCount}/${cfg.perDay}` : `${todayCount}（只手动）`

      const tabs = [
        ['daily', '日常'],
        ['prefs', '偏好'],
        ['account', '账号'],
        ['advanced', '高级'],
      ]

      const header = h('div', { 'data-zh-head': '' },
        h('span', { 'data-zh-dot': '', 'data-run': st.running ? '' : undefined, 'data-off': !st.running && !loggedIn ? '' : undefined }),
        h('span', { 'data-zh-title': '' }, '刷知乎'),
        h('span', { 'data-zh-badge': '' }, `v${st.version}`),
        h('span', { 'data-zh-badge': '' }, st.running ? '正在跑' : loggedIn
          ? `${st.auth.name || '已登录'} · 今天 ${quota}`
          : authOk ? 'Cookie 已配，但没有登录态' : '未登录'),
        h('span', { 'data-zh-grow': '' }),
        h('button', {
          'data-zh-btn': '', disabled: true,
          title: '手动跑请在对话里说「刷一轮知乎」；定时在自动值班里选目标对话',
        }, '手动请对话里说'),
        st.running ? h('button', { 'data-zh-btn': '', 'data-danger': '', disabled: busy === 'cancel', onClick: cancel }, '停下') : null,
      )

      const toastEl = toast && (Date.now() - toast.at < 12000)
        ? h('div', { 'data-zh-msg': '', 'data-tone': toast.tone || 'info' }, toast.text)
        : null

      const tabsEl = h('div', { 'data-zh-tabs': '' },
        tabs.map(([id, label]) => h('button', {
          key: id, 'data-zh-tab': '', 'data-on': tab === id ? '' : undefined, onClick: () => setTab(id),
        }, label)))

      /* ── 日常 ── */
      const daily = h(React.Fragment, null,
        h(Note, null, '定时任务只投到你选的「刷知乎」对话，不碰当前聊天；可以设精确到分钟的时间点。目标对话要开着。手动跑直接在对话里说「刷一轮知乎」。'),
        h(Section, { title: '自动值班' },
          h('div', { 'data-zh-row': '' },
            h('span', { 'data-zh-label': '' }, '定时投到'),
            h('span', { 'data-zh-grow': '' }),
            h('select', {
              'data-zh-input': '', style: { maxWidth: '260px' },
              value: cfg.dutySessionId || '',
              onChange: (e) => patchCfg({ dutySessionId: e.target.value }).catch(() => {}),
            },
              h('option', { value: '' }, sessions.length ? '（未选）' : '没有打开的主对话'),
              sessions.map((x) => h('option', { key: x.id, value: x.id }, x.title || x.id.slice(-12))),
              targetMissing ? h('option', { value: cfg.dutySessionId }, '（目标对话没开着）') : null)),
          h('div', { 'data-zh-row': '' },
            h('button', { 'data-zh-btn': '', disabled: busy === 'deliver' || !cfg.dutySessionId, onClick: deliverTest }, '测试投递'),
            h('span', { 'data-zh-grow': '' }),
            h(Note, null, '会在目标对话里发一条“请回复 OK”，确认定时通道不会弄坏对话。')),
          targetMissing ? h(Note, null, '当前选的目标对话没开着；先把那个「刷知乎」对话打开。') : null,
          h('div', { 'data-zh-row': '' },
            h('span', { 'data-zh-label': '' }, '精确时间点'),
            h('span', { 'data-zh-grow': '' }),
            h('input', {
              'data-zh-input': '', style: { maxWidth: '220px' },
              placeholder: '08:30, 12:30, 21:00', value: dailyDraft.scheduleTimes,
              onChange: (e) => setDailyDraft((d) => ({ ...d, scheduleTimes: e.target.value })),
              onBlur: saveScheduleTimes,
              onKeyDown: (e) => { if (e.key === 'Enter') { e.preventDefault(); saveScheduleTimes() } },
            }),
            h('button', { 'data-zh-btn': '', onClick: saveScheduleTimes }, '保存时间'),
            h('button', { 'data-zh-btn': '', onClick: setMidnight }, '每天 00:00')),
          h(Note, null, '逗号/换行分隔，HH:mm；每个点每天一次，错过 10 分钟内补跑。半夜 00:00（24:00 也认）。留空则用午间/夜间窗口。'),
          h('div', { 'data-zh-row': '' },
            h('span', { 'data-zh-label': '' }, '每天到点自动刷'),
            h('span', { 'data-zh-grow': '' }),
            h(Switch, { on: cfg.auto, onChange: (v) => patchCfg({ auto: v }).catch(() => {}) })),
          st.schedule?.next ? h(Note, null, `下次：${fmtTime(st.schedule.next)}${st.schedule.mode === 'times' ? '' : '（窗口）'}`) : null,
          cfg.scheduleTimes?.length
            ? h(Note, null, '已使用精确时间点；下面的午间/夜间窗口在这份配置里不生效。')
            : (cfg.auto ? h('div', { 'data-zh-sub': '' },
              h('div', { 'data-zh-row': '' },
                h('span', { 'data-zh-grow': '', 'data-zh-label': '' }, '午间窗口 12:00–14:00'),
                h(Switch, { on: cfg.noon, onChange: (v) => patchCfg({ noon: v }).catch(() => {}) })),
              h('div', { 'data-zh-row': '' },
                h('span', { 'data-zh-grow': '', 'data-zh-label': '' }, '夜间窗口 18:00–24:00'),
                h(Switch, { on: cfg.night, onChange: (v) => patchCfg({ night: v }).catch(() => {}) })),
              h(Note, null, '一个窗口一天只跑一次；到点投到上面选中的对话，目标没开着就跳过，打开后会重试。'),
            ) : h(Note, null, '自动开关关着；手动在对话里说「刷一轮知乎」即可。'))),
        h(Section, { title: '这一轮怎么捞' },
          h('div', { 'data-zh-grid2': '' },
            h('div', null,
              h(Note, null, '每天最多挑几条'),
              h('input', {
                'data-zh-input': '', 'data-zh-num': '', type: 'number', min: 0, max: 20,
                value: dailyDraft.perDay,
                onChange: (e) => setDailyDraft((d) => ({ ...d, perDay: e.target.value })),
                onBlur: () => patchCfg({ perDay: Number(dailyDraft.perDay) || 0 }, true).catch(() => {}),
              }),
              h(Note, null, '0 = 只手动，不自动跑')),
            h('div', null,
              h(Note, null, '每轮先捞多少条候选'),
              h('input', {
                'data-zh-input': '', 'data-zh-num': '', type: 'number', min: 4, max: 200,
                value: dailyDraft.candidates,
                onChange: (e) => setDailyDraft((d) => ({ ...d, candidates: e.target.value })),
                onBlur: () => patchCfg({ candidates: Number(dailyDraft.candidates) || 30 }, true).catch(() => {}),
              }),
              h(Note, null, '实际至少 10×每天条数（perDay 10 → 100），上限 200；候选越多读得越久')),
            h('div', null,
              h(Note, null, '今天'),
              h('div', { 'data-zh-kv': '' }, h('b', null, `${todayCount} 条`), ` / 目标 ${cfg.perDay > 0 ? cfg.perDay : '不限（手动）'}`),
              h(Note, null, st.today?.lastRunAt ? `上次：${fmtTime(st.today.lastRunAt)}（${st.today.lastWhy || '—'}）` : '今天还没跑过'))),
          h('div', { 'data-zh-row': '' },
            h('button', { 'data-zh-btn': '', disabled: busy === 'report', onClick: () => { if (report !== null) setReport(null); else loadReport() } },
              report !== null ? '收起本月文章' : '看本月文章'),
            h('button', { 'data-zh-btn': '', onClick: () => copy(st.report?.path || '', '文章路径') }, '复制文章路径')),
          report !== null
            ? h('pre', { 'data-zh-pre': '' }, report.text || '这个月还没有文章。在对话里说「刷一轮知乎」即可。')
            : null),
        h(Section, { title: '最近挑出来的', extra: h('span', { 'data-zh-grow': '' }) },
          items === null
            ? h('div', { 'data-zh-empty': '' }, '正在读取…')
            : items.length === 0
              ? h('div', { 'data-zh-empty': '' }, '还没有挑过。第一次跑完之后，这里会出现卡片。')
              : h('div', { 'data-zh-list': '' }, items.map((it, i) => h('div', { 'data-zh-item': '', key: `${it.day}-${it.id || i}` },
                h('div', { 'data-zh-item-h': '' },
                  h('span', { 'data-zh-item-t': '' }, /^https?:\/\//i.test(it.url || '')
                    ? h('a', { href: it.url, target: '_blank', rel: 'noreferrer' }, it.title)
                    : it.title),
                  h(Tier, { tier: it.tier })),
                it.why ? h('div', { 'data-zh-why': '' }, it.why) : null,
                it.quote ? h('div', { 'data-zh-why': '', style: { fontStyle: 'italic' } }, `“${it.quote}”`) : null,
                Array.isArray(it.related) && it.related.length
                  ? h('div', { 'data-zh-related': '' },
                    h('span', null, '同问题：'),
                    it.related.map((r, j) => h('span', { key: j },
                      j ? ' · ' : '',
                      /^https?:\/\//i.test(r.url || '')
                        ? h('a', { href: r.url, target: '_blank', rel: 'noreferrer', title: r.title }, r.author ? `${r.author}的回答` : r.title)
                        : r.title)))
                  : null,
                h('div', { 'data-zh-meta': '' },
                  h('span', null, it.day || ''),
                  it.author ? h('span', null, it.author) : null,
                  it.votes ? h('span', null, `赞同 ${it.votes}`) : null,
                  it.comments ? h('span', null, `评论 ${it.comments}`) : null)))))
      )

      /* ── 偏好 ── */
      const prefs = !prefsDraft ? h('div', { 'data-zh-empty': '' }, '正在读取偏好…') : h(React.Fragment, null,
        h(Section, { title: '领域权重' },
          h(Note, null, '5 = 非常想看，0 = 不关心。权重影响候选排序和值班判断，不是硬过滤；选几个你最在意的就够。'),
          h('div', { 'data-zh-grid2': '' },
            (st.domainCatalog || []).map((d) => h(WeightRow, {
              key: d.id,
              label: d.label,
              hint: d.label,
              value: prefsDraft.domains[d.id] || 0,
              onChange: (v) => setPrefsDraft((prev) => ({ ...prev, domains: { ...prev.domains, [d.id]: v } })),
            })))),
        h(Section, { title: '来源权重' },
          h(Note, null, '按比例分配每轮候选名额；0 = 这个来源不抓。'),
          (st.sourceCatalog || []).map((s) => h(WeightRow, {
            key: s.id,
            label: s.label,
            hint: s.hint,
            value: prefsDraft.sources[s.id] || 0,
            onChange: (v) => setPrefsDraft((prev) => ({ ...prev, sources: { ...prev.sources, [s.id]: v } })),
          }))),
        h(Section, { title: '判断权重' },
          h(Note, null, '交给值班编辑的打分口径：哪项高，它写「为什么值得」时就要重点说明哪项。'),
          (st.qualityCatalog || []).map((q) => h(WeightRow, {
            key: q.id,
            label: q.label,
            hint: q.hint,
            value: prefsDraft.quality[q.id] || 0,
            onChange: (v) => setPrefsDraft((prev) => ({ ...prev, quality: { ...prev.quality, [q.id]: v } })),
          }))),
        h(Section, { title: '关注的人' },
          h(Note, null, '一行一个：主页链接（zhihu.com/people/xxx）或 url_token。留空 = 用你的关注列表自动取；最多 30 个。'),
          h('textarea', {
            'data-zh-input': '', rows: 4, placeholder: 'https://www.zhihu.com/people/xxx\nhttps://www.zhihu.com/people/yyy',
            value: prefsDraft.followingUsers,
            onChange: (e) => setPrefsDraft((prev) => ({ ...prev, followingUsers: e.target.value })),
          })),
        h(Section, { title: '额外关键词' },
          h(Note, null, '一行一个，会跟领域关键词一起参与匹配；留空就只用领域。'),
          h('textarea', {
            'data-zh-input': '', rows: 3, placeholder: '例如：\n独立开发\n行为经济学',
            value: prefsDraft.keywords,
            onChange: (e) => setPrefsDraft((prev) => ({ ...prev, keywords: e.target.value })),
          })),
        h(Section, { title: '说话与文章' },
          h(Note, null, '人设提示词：想让它像谁就写在这儿。留空 = 中性、克制的编辑口吻。只借语气，不借事实。'),
          h('textarea', {
            'data-zh-input': '', rows: 3, placeholder: '例如：像一个做过十年产品、说话直但不刻薄的人；少用形容词，多给判断依据。',
            value: prefsDraft.persona,
            onChange: (e) => setPrefsDraft((prev) => ({ ...prev, persona: e.target.value })),
          }),
          h('select', {
            'data-zh-input': '', value: prefsDraft.reportLevel,
            onChange: (e) => setPrefsDraft((prev) => ({ ...prev, reportLevel: e.target.value })),
          },
          h('option', { value: 'full' }, '完整文章（每条：为什么值得 + 原文摘录）'),
          h('option', { value: 'brief' }, '薄版（每条一两行）'),
          h('option', { value: 'off' }, '不写 md（条目仍会存下来，设置页还能看到）'))),
        h('div', { 'data-zh-row': '' },
          h('button', { 'data-zh-btn': '', 'data-primary': '', disabled: busy === 'cfg', onClick: savePrefs },
            busy === 'cfg' ? '保存中…' : '保存偏好')),
        h(Note, null, '保存后下一轮生效，不用重启。'),
      )

      /* ── 账号（传统方式：浏览器登录 → 复制 cURL → 粘贴） ── */
      const authLine = authOk
        ? [
          '已配置：',
          h('b', { key: 'n' }, st.auth.name || st.auth.fields || '知乎账号'),
          st.auth.hasAuth ? ' · 带登录态' : ' · 没看到 z_c0（可能没登录）',
          st.auth.savedAt ? ` · ${fmtTime(st.auth.savedAt)}` : '',
          st.auth.source && st.auth.source !== 'paste' ? ' · 旧版登录' : '',
        ]
        : '还没登录。用下面的「从剪贴板导入」：浏览器登录 www.zhihu.com → 选一条 www.zhihu.com 的请求 Copy as cURL → 粘进来。'

      const accountCard = h(Section, { title: '知乎账号' },
        h('div', { 'data-zh-kv': '' }, authLine),
        h('div', { 'data-zh-row': '' },
          h('button', { 'data-zh-btn': '', 'data-primary': '', onClick: importClipboard }, '从剪贴板导入'),
          h('button', { 'data-zh-btn': '', onClick: () => window.open('https://www.zhihu.com/signin', '_blank', 'noopener') }, '打开知乎登录页'),
          authOk ? h('button', { 'data-zh-btn': '', 'data-danger': '', onClick: clearAuth }, '退出') : null),
        h(Note, null, '登录态只存本机 auth.json（0600）；插件不碰你的账号密码，也没有扫码/短信流程。'))

      const clipboardCard = h(Section, { title: '从剪贴板导入（传统方式）' },
        h('div', { 'data-zh-step': '' },
          '1. 在浏览器里打开知乎（确保已登录）→ F12 → Network；',
          h('br'),
          '2. 随便点一条 zhihu.com/api/... 请求，右键 → Copy → Copy as cURL；',
          h('br'),
          '3. 回到这里点「从剪贴板导入」；没给剪贴板权限就展开下面手动粘贴。'),
        h('div', { 'data-zh-row': '' },
          h('button', { 'data-zh-btn': '', 'data-primary': '', onClick: importClipboard }, '从剪贴板导入'),
          h('button', { 'data-zh-btn': '', onClick: testConnection, disabled: busy === 'test' },
            busy === 'test' ? '测试中…' : '测一下')),
        h('details', { 'data-zh-details': '' },
          h('summary', null, '手动粘贴 cURL / Cookie'),
          h('div', { style: { marginTop: '8px', display: 'flex', flexDirection: 'column', gap: '8px' } },
            h('textarea', {
              'data-zh-input': '', rows: 5,
              placeholder: "curl 'https://www.zhihu.com/api/v3/...' \\\n  -H 'cookie: z_c0=...; d_c0=...' \\\n  -H 'user-agent: Mozilla/5.0 ...'",
              value: cookieText,
              onChange: (e) => setCookieText(e.target.value),
            }),
            h('div', { 'data-zh-row': '' },
              h('button', {
                'data-zh-btn': '', 'data-primary': '', disabled: busy === 'auth',
                onClick: () => importCookie(cookieText),
              }, '保存 Cookie')))),
        tests
          ? h('div', { 'data-zh-test': '' }, tests.map((t, i) => h('div', { 'data-zh-test-row': '', key: i },
            h('span', { 'data-zh-test-ico': '' }, t.ok ? '✓' : '✗'),
            h('div', null,
              h('div', null, `${t.name}：${t.ok ? '通' : '没通'}${t.detail ? `（${t.detail}）` : ''}`),
              t.hint ? h('div', { 'data-zh-note': '' }, t.hint) : null))))
          : null)

      const account = h(React.Fragment, null, accountCard, clipboardCard)

      /* ── 高级 ── */
      const advanced = h(React.Fragment, null,
        h(Section, { title: '数据目录' },
          h('div', { 'data-zh-kv': '' },
            '当前：', h('b', null, st.home), h('br'),
            '默认：', h('b', null, st.defaultHome || ''),
            st.defaultHomeExists === false ? '（不存在）' : '',
            st.homeLocked ? '（由 DSH_ZHIHU_HOME 固定，改不了）' : '', h('br'),
            '本月文章：', h('b', null, st.report?.path || ''), h('br'),
            '值班章程：', h('b', null, st.charter?.file || ''),
            st.charter?.hasNew ? h('span', null, '（有新版 duty.md.new，自己合一下）') : null),
          h('div', { 'data-zh-row': '' },
            h('input', {
              'data-zh-input': '', value: homeDraft, disabled: Boolean(st.homeLocked),
              style: { flex: '1', minWidth: '260px' },
              placeholder: '/Users/你/zhihu-duty',
              onChange: (e) => setHomeDraft(e.target.value),
            }),
            h('button', { 'data-zh-btn': '', disabled: Boolean(st.homeLocked), onClick: pickFolder }, '选文件夹'),
            h('button', {
              'data-zh-btn': '', 'data-primary': '', disabled: busy === 'home' || Boolean(st.homeLocked),
              onClick: saveHome,
            }, busy === 'home' ? '切换中…' : '使用此目录'),
            h('button', {
              'data-zh-btn': '', disabled: Boolean(st.homeLocked) || st.defaultHomeExists === false,
              title: st.defaultHomeExists === false ? '默认目录不存在，切过去会是空数据' : '',
              onClick: () => setHomeDraft(st.defaultHome || ''),
            }, '恢复默认')),
          h(Note, null, '换目录会把配置、登录态、月度文章、缓存复制过去（不覆盖目标已有文件），旧目录保留。auth.json 里有登录态，别选网盘同步或公开目录。'),
          h('div', { 'data-zh-row': '' },
            h('button', { 'data-zh-btn': '', onClick: () => copy(st.home, '数据目录') }, '复制数据目录'),
            h('button', { 'data-zh-btn': '', onClick: () => copy(st.report?.path || '', '文章路径') }, '复制文章路径'),
            h('button', { 'data-zh-btn': '', disabled: busy === 'logs', onClick: loadLogs }, logs === null ? '看日志' : '刷新日志')),
          logs !== null ? h('pre', { 'data-zh-pre': '' }, logs || '（日志还是空的）') : null),
        h(Section, { title: '排查' },
          h('div', { 'data-zh-row': '' },
            h('button', {
              'data-zh-btn': '', onClick: async () => {
                try {
                  const r = await jget('/diagnose')
                  await copy(r.text, '诊断信息')
                } catch (e) { say('err', e.message) }
              },
            }, '复制诊断信息'),
            h('span', { 'data-zh-note': '' }, '把这段发给帮你装插件的人，里面没有 Cookie 原文。')),
          st.today?.lastError ? h('div', { 'data-zh-msg': '', 'data-tone': 'err' }, `上一轮出错：${st.today.lastError}`) : null,
          h('div', { 'data-zh-note': '' }, `运行环境：${st.dsh} · 数据只在本机`)),
      )

      return h('div', { 'data-zh-page': '' },
        header,
        toastEl,
        tabsEl,
        tab === 'daily' ? daily : tab === 'prefs' ? prefs : tab === 'account' ? account : advanced,
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        const style = document.createElement('style')
        style.setAttribute('data-plugin-css', 'dsh-zhihu-scroll')
        style.textContent = CSS
        document.head.appendChild(style)
        ctx.effect(() => () => style.remove(), 'dsh-zhihu-scroll: 设置页样式')

        const slots = (typeof ctx.get === 'function' ? ctx.get('slots') : undefined) || ctx.slots
        if (!slots) return
        slots.inject('settings.section', () => slots.register(
          { name: 'settings.section', id: 'zhihu-scroll', order: 31, label: '刷知乎' },
          () => h(Panel),
        ))
      },
    }
  },
})
