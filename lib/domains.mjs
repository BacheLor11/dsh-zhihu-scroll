/**
 * lib/domains.mjs —— 领域目录 + 权重匹配
 * ============================================================================
 * 用户选的是「领域 + 权重」，不是一串裸关键词：
 *   权重 5 = 非常想看，0 = 完全不要；抓候选时按它排序，值班时按它判断。
 * 关键词只用于匹配标题/摘要/正文，不要求用户自己写。
 * ============================================================================
 */

/** 内置领域。id 稳定（配置里存它），label/keywords 可以随版本调整。 */
export const DOMAINS = [
  {
    id: 'ai', label: '人工智能', defaultWeight: 4,
    keywords: ['ai', '人工智能', '大模型', 'llm', '机器学习', '深度学习', 'agent', 'gpt', 'chatgpt', 'deepseek', '生成式', '多模态', '提示词', '训练', '推理', '算力'],
  },
  {
    id: 'tech', label: '科技互联网', defaultWeight: 3,
    keywords: ['互联网', '科技', '编程', '程序员', '开源', '前端', '后端', '算法', '数据库', '操作系统', 'linux', 'github', '产品经理', '创业', 'saas', '芯片'],
  },
  {
    id: 'science', label: '科学', defaultWeight: 3,
    keywords: ['物理', '化学', '生物', '数学', '天文', '宇宙', '量子', '基因', '进化', '科研', '论文', '实验', '科普'],
  },
  {
    id: 'business', label: '商业财经', defaultWeight: 2,
    keywords: ['商业', '财经', '经济', '公司', '行业', '市场', '投资', '股票', '基金', '消费', '品牌', '供应链', '出海', '商业模式'],
  },
  {
    id: 'psychology', label: '心理', defaultWeight: 2,
    keywords: ['心理', '认知', '情绪', '焦虑', '抑郁', '亲密关系', '人格', '行为经济学', '决策', '自洽', '内耗'],
  },
  {
    id: 'history', label: '历史', defaultWeight: 1,
    keywords: ['历史', '古代', '近代', '王朝', '战争', '考古', '史料', '民国', '唐朝', '宋朝', '明朝', '清朝', '三国'],
  },
  {
    id: 'culture', label: '文化', defaultWeight: 1,
    keywords: ['文化', '文学', '读书', '书评', '哲学', '艺术', '音乐', '诗', '写作', '翻译', '人文'],
  },
  {
    id: 'career', label: '职场', defaultWeight: 2,
    keywords: ['职场', '工作', '面试', '简历', '晋升', '管理', '同事', '老板', '跳槽', '副业', '远程办公', '裁员'],
  },
  {
    id: 'life', label: '生活', defaultWeight: 1,
    keywords: ['生活', '租房', '装修', '做饭', '旅行', '城市', '独居', '收纳', '宠物', '习惯'],
  },
  {
    id: 'education', label: '教育', defaultWeight: 1,
    keywords: ['教育', '学习', '高考', '考研', '留学', '英语', '学校', '老师', '孩子', '鸡娃', '自驱'],
  },
  {
    id: 'health', label: '健康', defaultWeight: 1,
    keywords: ['健康', '睡眠', '运动', '健身', '减肥', '饮食', '医疗', '医生', '疾病', '体检', '营养'],
  },
  {
    id: 'game', label: '游戏', defaultWeight: 1,
    keywords: ['游戏', '主机', 'steam', '电竞', '原神', '独立游戏', '任天堂', 'ps5', '手游', '玩家'],
  },
  {
    id: 'film', label: '影视', defaultWeight: 1,
    keywords: ['电影', '电视剧', '影视', '导演', '演员', '综艺', '动画', '纪录片', '剧评', '票房'],
  },
  {
    id: 'sports', label: '体育', defaultWeight: 0,
    keywords: ['体育', '足球', '篮球', 'nba', '奥运', '跑步', '马拉松', '比赛', '球队'],
  },
  {
    id: 'auto', label: '汽车', defaultWeight: 0,
    keywords: ['汽车', '新能源', '电动车', '买车', '驾驶', '特斯拉', '比亚迪', '车型', '智驾'],
  },
  {
    id: 'finance', label: '理财', defaultWeight: 2,
    keywords: ['理财', '存款', '保险', '房贷', '信用卡', '记账', '养老', '财务自由', '资产配置'],
  },
]

export const DOMAIN_MAP = new Map(DOMAINS.map((d) => [d.id, d]))

/** 默认权重表（只存 id → 0..5） */
export function defaultDomainWeights() {
  const out = {}
  for (const d of DOMAINS) out[d.id] = d.defaultWeight
  return out
}

/** 来源权重：抓候选时按比例分配名额 */
export const SOURCES = [
  { id: 'recommend', label: '推荐流', hint: '知乎按你的画像推的，适合发现新东西', defaultWeight: 3 },
  { id: 'hot', label: '热榜', hint: '全站正在热，时效强，但不一定对你的口味', defaultWeight: 2 },
  { id: 'following', label: '关注动态', hint: '你关注的人最近在做什么', defaultWeight: 4 },
  { id: 'followingUsers', label: '关注的人', hint: '主动去翻你关注的人最近发的回答/文章', defaultWeight: 3 },
]

/** 判断权重：交给值班编辑的口径 */
export const QUALITY = [
  { id: 'depth', label: '信息密度', hint: '一手经历、数据、推演，而不是情绪和复读', defaultWeight: 4 },
  { id: 'freshness', label: '时效', hint: '最近发生 / 刚有进展的优先', defaultWeight: 3 },
  { id: 'practical', label: '实操性', hint: '读完能马上用上的，而不是纯谈资', defaultWeight: 3 },
  { id: 'diversity', label: '观点多元', hint: '跟主流说法不一样、但讲得住的', defaultWeight: 2 },
]

export function defaultSourceWeights() {
  const out = {}
  for (const s of SOURCES) out[s.id] = s.defaultWeight
  return out
}

export function defaultQualityWeights() {
  const out = {}
  for (const q of QUALITY) out[q.id] = q.defaultWeight
  return out
}

/** 关键词命中：英文按词边界，中文直接包含（避免 ai 命中 said） */
export function keywordHit(hay, kw) {
  const k = String(kw || '').toLowerCase().trim()
  if (!k) return false
  if (/^[a-z0-9][a-z0-9+#.\- ]*$/i.test(k)) {
    const esc = k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    return new RegExp(`(^|[^a-z0-9])${esc}([^a-z0-9]|$)`, 'i').test(hay)
  }
  return hay.includes(k)
}

/**
 * 一条内容命中了哪些领域、加权多少。
 * @param {string} text 标题+摘要+正文
 * @param {Record<string, number>} weights
 * @returns {{ids: string[], score: number}}
 */
export function matchDomains(text, weights) {
  const hay = String(text || '').toLowerCase()
  const ids = []
  let score = 0
  for (const d of DOMAINS) {
    const w = Number(weights?.[d.id]) || 0
    if (w <= 0) continue
    if (d.keywords.some((k) => keywordHit(hay, k))) {
      ids.push(d.id)
      score += w
    }
  }
  return { ids, score: Math.min(12, score) }
}

/** 从主页链接 / @名字 / 裸 token 里取 url_token */
export function parseUserRef(input) {
  const s = String(input || '').trim()
  if (!s) return ''
  let m = s.match(/zhihu\.com\/people\/([^/?#\s]+)/i)
  if (m) return decodeURIComponent(m[1])
  m = s.match(/^@?([A-Za-z0-9_-]{2,64})$/)
  if (m) return m[1]
  return ''
}

/** 权重表清洗成 0..5 的整数，缺的补默认 */
export function sanitizeWeights(raw, defaults) {
  const out = { ...defaults }
  if (raw && typeof raw === 'object') {
    for (const key of Object.keys(defaults)) {
      if (raw[key] === undefined) continue
      const n = Number(raw[key])
      if (Number.isFinite(n)) out[key] = Math.max(0, Math.min(5, Math.round(n)))
    }
  }
  return out
}

/** 中文标签（报告/提示词用） */
export function labelOfDomain(id) {
  return DOMAIN_MAP.get(id)?.label || id
}

export function labelOfSource(id) {
  return SOURCES.find((s) => s.id === id)?.label || id
}

export function labelOfQuality(id) {
  return QUALITY.find((q) => q.id === id)?.label || id
}
