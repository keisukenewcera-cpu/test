import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import './App.css'
import { supabase } from './lib/supabaseClient'

const gradeRates = {
  G1: 0.05,
  G2: 0.6,
  G3: 1,
  G4: 1.5,
  G5: 1.8,
  G6: 2.5,
  G1J: 0.05,
  G2J: 0.4,
  G3J: 0.75,
  G4J: 1.24,
  G5J: 1.65,
  G6J: 2.25,
  P3: 0.25,
}

const gradeAliasMap = {
  G1: 'G1',
  G2: 'G2',
  G3: 'G3',
  G4: 'G4',
  G5: 'G5',
  G6: 'G6',
  P3: 'P3',
  G1準社員: 'G1J',
  G2準社員: 'G2J',
  G3準社員: 'G3J',
  G4準社員: 'G4J',
  G5準社員: 'G5J',
  G6準社員: 'G6J',
  G1J: 'G1J',
  G2J: 'G2J',
  G3J: 'G3J',
  G4J: 'G4J',
  G5J: 'G5J',
  G6J: 'G6J',
}

const teamAliasMap = {
  デンチャー: 'denture',
  denture: 'denture',
  DENTURE: 'denture',
  CK: 'ck',
  ck: 'ck',
}

const getGradeRowClass = (grade) => {
  if (grade === 'G1' || grade === 'G2' || grade === 'G1J' || grade === 'G2J') return 'gradeToneBlue'
  if (grade === 'G3' || grade === 'G4' || grade === 'G3J' || grade === 'G4J' || grade === 'P3') {
    return 'gradeToneGreen'
  }
  if (grade === 'G5' || grade === 'G6' || grade === 'G5J' || grade === 'G6J') return 'gradeToneAmber'
  return ''
}

const sanitizeIntegerInput = (value) => value.replace(/\D/g, '').replace(/^0+(?=\d)/, '')

const sanitizeDecimalInput = (value) => {
  const cleaned = value.replace(/[^\d.]/g, '')
  const [integerPart = '', ...decimalParts] = cleaned.split('.')
  const normalizedInteger = integerPart.replace(/^0+(?=\d)/, '')
  const decimalPart = decimalParts.join('')

  if (cleaned.includes('.')) {
    return `${normalizedInteger || '0'}.${decimalPart}`
  }

  return normalizedInteger
}

const sanitizePercentInput = (value) => {
  const cleaned = value.replace(/[^\d.]/g, '')
  const [integerPart = '', ...decimalParts] = cleaned.split('.')
  const normalizedInteger = integerPart.replace(/^0+(?=\d)/, '')
  const decimalPart = decimalParts.join('').slice(0, 1)

  if (cleaned.includes('.')) {
    return `${normalizedInteger || '0'}.${decimalPart}`
  }

  return normalizedInteger
}

const createRow = (index) => ({
  id: Date.now() + index,
  employeeNo: '',
  employeeName: '',
  photoDataUrl: '',
  team: 'denture',
  grade: 'G3',
  score: '',
  specialAllowance: '',
  note: '',
})

const STORAGE_KEY = 'performanceAllowanceAppData'
const CLOUD_STATE_ID = 'default'
const getCurrentPeriod = () => new Date().toISOString().slice(0, 7)

const formatQuarterLabel = (d = new Date()) => {
  const y = d.getFullYear()
  const q = Math.floor(d.getMonth() / 3) + 1
  return `${y}-Q${q}`
}

const loadSavedData = () => {
  if (typeof window === 'undefined') return null

  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    return JSON.parse(raw)
  } catch {
    return null
  }
}

const defaultEmployeeDirectoryRows = [
  {
    id: 'e1',
    name: '田中 太郎',
    dept: '製造',
    grade: 'G1',
    score: '3.5点',
    role: '一般従業員',
    password: '',
    joinDate: '2026-04-01',
  },
  { id: 'e2', name: '佐藤 花子', dept: '営業', grade: 'G2', score: '9.0点', role: '上司', password: '', joinDate: '' },
  { id: 'e3', name: '鈴木 一郎', dept: '品質', grade: 'G3', score: '19.1点', role: '上司', password: '', joinDate: '' },
  { id: 'e4', name: '山田 次郎', dept: '製造', grade: 'G1', score: '1.5点', role: '一般従業員', password: '', joinDate: '' },
]

const calcEmployeeSkillStars = (allSkills, employeeProgress) =>
  (allSkills ?? []).reduce((total, skill) => {
    const currentLevel = Math.max(0, Number(employeeProgress?.[skill.id] ?? 0))
    if (!Number.isFinite(currentLevel) || currentLevel <= 0) return total
    const levelStars = Math.max(0, Number(skill.levelStars) || 0)
    const stages = Math.max(0, Number(skill.stages) || 0)
    const maxStars = Math.max(0, Number(skill.maxStars) || levelStars * stages)
    const gainedStars = maxStars > 0 ? Math.min(currentLevel * levelStars, maxStars) : currentLevel * levelStars
    return total + gainedStars
  }, 0)

const escapeCsvField = (value) => `"${String(value ?? '').replace(/"/g, '""')}"`

function parseCsvLine(line) {
  const result = []
  let current = ''
  let inQuotes = false
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (inQuotes) {
      if (c === '"') {
        if (line[i + 1] === '"') {
          current += '"'
          i++
        } else {
          inQuotes = false
        }
      } else {
        current += c
      }
    } else if (c === '"') {
      inQuotes = true
    } else if (c === ',') {
      result.push(current.trim())
      current = ''
    } else {
      current += c
    }
  }
  result.push(current.trim())
  return result
}

function findHeaderIndex(headers, candidates) {
  const normalized = headers.map((h) => String(h ?? '').trim())
  for (const name of candidates) {
    const idx = normalized.findIndex((h) => h === name)
    if (idx >= 0) return idx
  }
  return -1
}

function normalizeEmployeeDirectoryScore(value) {
  const s = String(value ?? '').trim()
  if (!s) return '0.0点'
  if (s.endsWith('点')) return s
  const n = Number(s.replace(/,/g, ''))
  if (Number.isFinite(n)) return `${n}点`
  return '0.0点'
}

const EMPLOYEE_DEPT_OPTIONS = ['製造', '営業', '品質']
const EMPLOYEE_ROLE_OPTIONS = ['一般従業員', '上司', '管理者']

function normalizeEmployeeDept(value) {
  const v = String(value ?? '').trim()
  return EMPLOYEE_DEPT_OPTIONS.includes(v) ? v : '製造'
}

function normalizeEmployeeRole(value) {
  const v = String(value ?? '').trim()
  return EMPLOYEE_ROLE_OPTIONS.includes(v) ? v : '一般従業員'
}

function normalizeEmployeeGrade(value) {
  const v = String(value ?? '').trim()
  if (/^G[1-6]$/.test(v)) return v
  return 'G1'
}

function stripSensitiveEmployeeFields(rows) {
  if (!Array.isArray(rows)) return []
  return rows.map((row) => ({ ...row, password: '' }))
}

function mergeEmployeeDirectoryRows(prev, imported) {
  const mapImport = new Map(imported.map((r) => [String(r.id), r]))
  const seen = new Set()
  const merged = []
  for (const row of prev) {
    const imp = mapImport.get(String(row.id))
    if (imp) {
      merged.push(imp)
      seen.add(String(row.id))
    } else {
      merged.push(row)
    }
  }
  for (const imp of imported) {
    if (!seen.has(String(imp.id))) {
      merged.push(imp)
      seen.add(String(imp.id))
    }
  }
  return merged
}

const defaultSkillSections = [
  { id: 'basic', label: '基礎編' },
  { id: 'applied', label: '応用編' },
]

const defaultSkillGrades = [
  { id: 'G1', label: 'G1' },
  { id: 'G2', label: 'G2' },
  { id: 'G3', label: 'G3' },
  { id: 'G4', label: 'G4' },
  { id: 'G5', label: 'G5' },
  { id: 'G6', label: 'G6' },
]

const defaultSkillSettings = [
  {
    id: 'skill-5s',
    gradeId: 'G1',
    sectionId: 'basic',
    title: '5S活動の理解と実践',
    description:
      '作業場の整理・整頓・清掃・清潔・しつけを習慣化し、安全でムダの少ない職場づくりに取り組むための基礎を身につけます。',
    stages: 3,
    levelStars: 5,
    maxStars: 15,
    required: true,
    departments: ['all'],
    levelCriteria: ['', '', ''],
  },
  {
    id: 'skill-safety',
    gradeId: 'G1',
    sectionId: 'basic',
    title: '安全作業の基礎',
    description:
      '危険予知と保護具の正しい使用、作業手順の遵守を通じて、ヒヤリハットを減らしケガのない職場を維持する力を養います。',
    stages: 3,
    levelStars: 10,
    maxStars: 30,
    required: true,
    departments: ['製造', '品質'],
    levelCriteria: ['', '', ''],
  },
  {
    id: 'skill-pc-basic',
    gradeId: 'G1',
    sectionId: 'basic',
    title: '基本的なPC操作',
    description: 'メール・表計算・ファイル管理など、業務に必要なPC操作の基礎を身につけます。',
    stages: 3,
    levelStars: 8,
    maxStars: 24,
    required: true,
    departments: ['all'],
    levelCriteria: ['', '', ''],
  },
  {
    id: 'skill-quality-inspect',
    gradeId: 'G1',
    sectionId: 'applied',
    title: '品質検査技術',
    description:
      '検査基準に基づく測定・判定・記録、不良の未然防止とトレーサビリティ確保に必要な検査技術を習得します。',
    stages: 5,
    levelStars: 15,
    maxStars: 75,
    required: true,
    departments: ['品質', '製造'],
    levelCriteria: ['', '', '', '', ''],
  },
]

const defaultSkillEmployeeProgress = {
  e1: { 'skill-5s': 2, 'skill-safety': 2, 'skill-pc-basic': 1 },
  e2: {},
  e3: {},
  e4: {},
}

const SELF_EVAL_CATEGORIES = [
  {
    id: 'cat-exec',
    title: '業務遂行能力',
    items: [
      {
        id: 'se-exec-1',
        title: '日常業務について自己完結できる計画を立てられる',
        weightPct: 20,
        criteria: `5点：計画を立案し期限・品質を自己管理し、ほぼ自力で完遂している。
4点：計画に沿って進め、迷いがあっても自力で軌道修正できる。
3点：指示を受けながら計画どおりに進められることが多い。
2点：計画は立てるが実行が不安定で、支援を要することがある。
1点：計画立案や進捗管理が困難で、日常的に手戻りが多い。`,
      },
      {
        id: 'se-exec-2',
        title: '業務の優先順位を判断できる',
        weightPct: 15,
        criteria: `5点：目的に照らし緊急度・重要度を瞬時に整理し、関係者にも説明できる。
4点：優先順位を説明可能な形で判断し、概ね適切に配分できる。
3点：多くの場面で優先付けができ、不明点は確認して決められる。
2点：判断に時間がかかり、時に後手に回る。
1点：優先付けができず、作業が停滞しやすい。`,
      },
    ],
  },
  {
    id: 'cat-comm',
    title: 'コミュニケーション能力',
    items: [
      {
        id: 'se-comm-1',
        title: '関係者と適切なタイミングで情報共有できる',
        weightPct: 20,
        criteria: `5点：先回りして共有し、認識齟齬を未然に防いでいる。
4点：必要な相手・タイミングを選び、内容も具体的に伝えられる。
3点：指示された範囲で適切に共有できている。
2点：共有が遅れたり、要点が抜けることがある。
1点：連絡不足により業務に支障が出ることがある。`,
      },
      {
        id: 'se-comm-2',
        title: '指摘・フィードバックを前向きに受け止め改善に活かせる',
        weightPct: 15,
        criteria: `5点：フィードバックを自ら求め、具体的な改善行動に結びつけている。
4点：受け止め方が前向きで、再発防止策を自分で考えられる。
3点：内容を理解し、次回に反映しようとしている。
2点：感情的になりやすく、改善までに時間がかかる。
1点：受け止めが難しく、同様の指摘が繰り返される。`,
      },
    ],
  },
  {
    id: 'cat-growth',
    title: '成長意欲',
    items: [
      {
        id: 'se-gr-1',
        title: '新しい業務・スキル習得に積極的に取り組む',
        weightPct: 15,
        criteria: `5点：自発的に学習テーマを設定し、成果を周囲に還元している。
4点：新規案件にも前向きに参加し、習得スピードが速い。
3点：与えられた範囲で着実にスキルを伸ばしている。
2点：チャレンジはするが継続が弱いことがある。
1点：新しい取り組みを避けがちで、成長が見えにくい。`,
      },
      {
        id: 'se-gr-2',
        title: '振り返りを通じて自己成長のテーマを設定できる',
        weightPct: 15,
        criteria: `5点：定期的に振り返り、次の具体的目標と行動計画を自分で立てている。
4点：振り返りから学びを言語化し、次に活かせる。
3点：振り返りの機会を活かして改善している。
2点：振り返りはするが行動に結びつきにくい。
1点：振り返りが形骸化している、または不足している。`,
      },
    ],
  },
]

function newEvaluationId(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

function criteriaBlobToFiveScores(text) {
  const out = ['', '', '', '', '']
  String(text ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .forEach((line) => {
      const m = /^(\d)点[：:]\s*(.+)$/.exec(line)
      if (m) {
        const i = Number(m[1]) - 1
        if (i >= 0 && i < 5) out[i] = m[2].trim()
      }
    })
  return out
}

function normalizeEvaluationMinor(m) {
  const sc = Array.isArray(m?.scoreCriteria) ? [...m.scoreCriteria] : []
  while (sc.length < 5) sc.push('')
  while (sc.length > 5) sc.pop()
  return {
    id: typeof m?.id === 'string' && m.id ? m.id : newEvaluationId('min'),
    title: String(m?.title ?? '').trim(),
    weightPct: Math.min(100, Math.max(0, Number(m?.weightPct) || 0)),
    scoreCriteria: sc.map((s) => String(s ?? '')),
  }
}

function normalizeEvaluationMajor(m) {
  return {
    id: typeof m?.id === 'string' && m.id ? m.id : newEvaluationId('maj'),
    title: String(m?.title ?? '').trim(),
    minors: Array.isArray(m?.minors) ? m.minors.map(normalizeEvaluationMinor) : [],
  }
}

function normalizeEvaluationCriteriaStore(raw, gradeList) {
  const grades = gradeList?.length ? gradeList : defaultSkillGrades
  const next = {}
  for (const g of grades) {
    const majors = Array.isArray(raw?.[g.id]) ? raw[g.id] : []
    next[g.id] = majors.map(normalizeEvaluationMajor).filter((x) => x.id && x.title)
  }
  return next
}

function buildDefaultEvaluationCriteriaFromSelfEval(gradeList) {
  const grades = gradeList?.length ? gradeList : defaultSkillGrades
  const base = Object.fromEntries(grades.map((g) => [g.id, []]))
  if (!('G1' in base)) return base
  base.G1 = SELF_EVAL_CATEGORIES.map((cat) => ({
    id: `maj-seed-${cat.id}`,
    title: cat.title,
    minors: cat.items.map((it) => ({
      id: `min-seed-${it.id}`,
      title: it.title,
      weightPct: Number(it.weightPct) || 0,
      scoreCriteria: criteriaBlobToFiveScores(it.criteria),
    })),
  }))
  return base
}

const MENU_ROLE_IPPAN = 'ippan'
const MENU_ROLE_JOUSHI = 'joushi'
const MENU_ROLE_ADMIN = 'admin'

const MENU_DISPLAY_META = {
  gyoseki: { tabLabel: '業績手当', description: '業績手当の入力・自動計算を行います。' },
  skillup: { tabLabel: 'スキルアップ', description: 'スキル習得状況の確認と管理を行います。' },
  selfeval: { tabLabel: '自己評価', description: '自己評価の実施と確認を行います。' },
  goals: { tabLabel: '目標設定・管理', description: '個人の目標設定と進捗管理を行います。' },
  bossEval: { tabLabel: '上司評価', description: '部下の評価を実施します。' },
  execEval: { tabLabel: '経営層評価', description: '従業員を100点満点で評価します。' },
  admin: { tabLabel: '管理者ダッシュボード', description: '全従業員の状況を一覧管理します。' },
  settings: { tabLabel: '設定', description: 'スキル設定・評価基準設定・表示設定を行います。' },
  skill: { tabLabel: 'スキル設定', description: 'スキル項目の作成と編集を行います。' },
  evalcriteria: { tabLabel: '評価基準設定', description: '評価項目と基準を設定します。' },
  menusettings: { tabLabel: '表示設定', description: '役割ごとのメニュー表示をカスタマイズします。' },
  employee: { tabLabel: '従業員管理', description: '従業員アカウントの登録・編集・削除を行います。' },
}

const MAIN_WORKSPACE_TAB_ORDER = [
  { key: 'gyoseki', label: '業績手当' },
  { key: 'admin', label: MENU_DISPLAY_META.admin.tabLabel },
  { key: 'employee', label: MENU_DISPLAY_META.employee.tabLabel },
  { key: 'settings', label: MENU_DISPLAY_META.settings.tabLabel },
  { key: 'skillup', label: MENU_DISPLAY_META.skillup.tabLabel },
  { key: 'selfeval', label: MENU_DISPLAY_META.selfeval.tabLabel },
  { key: 'goals', label: MENU_DISPLAY_META.goals.tabLabel },
  { key: 'bossEval', label: MENU_DISPLAY_META.bossEval.tabLabel },
  { key: 'execEval', label: MENU_DISPLAY_META.execEval.tabLabel },
]

const MAIN_WORKSPACE_TAB_ICONS = {
  gyoseki: '💹',
  admin: '📊',
  employee: '👥',
  settings: '⚙️',
  skillup: '🚀',
  selfeval: '📝',
  goals: '🎯',
  bossEval: '🧑‍💼',
  execEval: '🏛️',
}

/** 管理者の表示設定対象タブ（業績手当含む） */
const ADMIN_ROLE_MENU_KEYS = MAIN_WORKSPACE_TAB_ORDER.map((t) => t.key)

const MENU_KEYS_BY_ROLE_CARD = {
  [MENU_ROLE_IPPAN]: ['skillup', 'selfeval', 'goals', 'bossEval'],
  [MENU_ROLE_JOUSHI]: ['admin', 'skillup', 'selfeval', 'goals', 'bossEval'],
  [MENU_ROLE_ADMIN]: [...ADMIN_ROLE_MENU_KEYS],
}

const DEFAULT_MENU_VISIBILITY_BY_ROLE = {
  [MENU_ROLE_IPPAN]: ['skillup', 'selfeval', 'goals'],
  [MENU_ROLE_JOUSHI]: ['skillup', 'selfeval', 'goals', 'bossEval'],
  [MENU_ROLE_ADMIN]: [...ADMIN_ROLE_MENU_KEYS],
}

function normalizeMenuVisibilityByRole(raw) {
  const out = {}
  for (const role of Object.keys(MENU_KEYS_BY_ROLE_CARD)) {
    const allowed = new Set(MENU_KEYS_BY_ROLE_CARD[role])
    const incoming = Array.isArray(raw?.[role]) ? raw[role].map(String) : []
    let list = incoming.filter((k) => allowed.has(k))
    if (list.length === 0) list = [...DEFAULT_MENU_VISIBILITY_BY_ROLE[role]]
    if (role === MENU_ROLE_ADMIN) {
      // 旧保存データ（skill/evalcriteria/menusettings）から settings を補完
      if (
        !list.includes('settings') &&
        (incoming.includes('skill') || incoming.includes('evalcriteria') || incoming.includes('menusettings'))
      ) {
        list = [...list, 'settings']
      }
      for (const k of ['skillup', 'selfeval', 'goals']) {
        if (allowed.has(k) && !list.includes(k)) list = [...list, k]
      }
      if (!list.includes('settings')) list = [...list, 'settings']
    }
    out[role] = list
  }
  return out
}

function resolveMenuRoleKey(normalizedEmail, employees) {
  if (normalizedEmail === 'admin@example.com') return MENU_ROLE_ADMIN
  const emp = employees.find((row) => {
    const emailMatch = String(row.email ?? '').trim().toLowerCase() === normalizedEmail
    const idMatch = String(row.id ?? '').trim().toLowerCase() === normalizedEmail
    return emailMatch || idMatch
  })
  if (emp?.role === '上司') return MENU_ROLE_JOUSHI
  if (emp) return MENU_ROLE_IPPAN
  return MENU_ROLE_ADMIN
}

function isWorkspaceVisibleForRole(workspaceKey, roleKey, menuVisibilityByRole) {
  const normalizedWorkspaceKey =
    workspaceKey === 'skill' || workspaceKey === 'evalcriteria' || workspaceKey === 'menusettings'
      ? 'settings'
      : workspaceKey
  if (normalizedWorkspaceKey === 'gyoseki') {
    if (roleKey !== MENU_ROLE_ADMIN) return false
    const list = menuVisibilityByRole[roleKey] ?? []
    return list.includes('gyoseki')
  }
  if (roleKey === MENU_ROLE_ADMIN && normalizedWorkspaceKey === 'settings') return true
  const keys = MENU_KEYS_BY_ROLE_CARD[roleKey] ?? []
  if (!keys.includes(normalizedWorkspaceKey)) return false
  const list = menuVisibilityByRole[roleKey] ?? []
  return list.includes(normalizedWorkspaceKey)
}

function normalizeEvalByEmployeeMap(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out = {}
  for (const [empId, entry] of Object.entries(raw)) {
    if (typeof empId !== 'string' || !empId) continue
    const scores = entry?.scores && typeof entry.scores === 'object' && !Array.isArray(entry.scores) ? { ...entry.scores } : {}
    const comments = entry?.comments && typeof entry.comments === 'object' && !Array.isArray(entry.comments) ? { ...entry.comments } : {}
    out[empId] = { scores, comments }
  }
  return out
}

function normalizeExecutiveEvalByEmployeeMap(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out = {}
  for (const [empId, entry] of Object.entries(raw)) {
    if (typeof empId !== 'string' || !empId) continue
    const baseScoreRaw = Number(entry?.baseScore)
    const baseScore = Number.isFinite(baseScoreRaw) ? Math.max(0, Math.min(100, Math.round(baseScoreRaw))) : 0
    const commentHistory = Array.isArray(entry?.commentHistory)
      ? entry.commentHistory
          .map((h, idx) => {
            const deltaRaw = Number(h?.delta)
            const delta = Number.isFinite(deltaRaw) ? Math.max(-20, Math.min(20, Math.round(deltaRaw))) : 0
            const comment = String(h?.comment ?? '').trim()
            if (!comment) return null
            return {
              id: typeof h?.id === 'string' && h.id ? h.id : `exec-comment-${empId}-${idx}`,
              delta,
              comment,
              createdAt: String(h?.createdAt ?? '').trim() || new Date().toISOString(),
            }
          })
          .filter(Boolean)
      : []
    out[empId] = { baseScore, commentHistory }
  }
  return out
}

function resizeLevelCriteriaArray(prev, newLen) {
  const next = [...(prev || [])]
  while (next.length < newLen) next.push('')
  while (next.length > newLen) next.pop()
  return next
}

function App() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [loginMode, setLoginMode] = useState('employee')
  const [loginError, setLoginError] = useState('')
  const [isLoggedIn, setIsLoggedIn] = useState(false)
  const [loggedInEmployeeId, setLoggedInEmployeeId] = useState(null)
  const [adminPassword, setAdminPassword] = useState(() => (loadSavedData()?.adminPassword ?? 'test'))
  const [rememberLogin, setRememberLogin] = useState(false)
  const [resetModalOpen, setResetModalOpen] = useState(false)
  const [resetId, setResetId] = useState('')
  const [resetPrevPassword, setResetPrevPassword] = useState('')
  const [resetNextPassword, setResetNextPassword] = useState('')
  const savedData = loadSavedData()
  const [rows, setRows] = useState(() => {
    const savedRows = savedData?.rows
    return Array.isArray(savedRows) && savedRows.length > 0 ? savedRows : [createRow(0), createRow(1)]
  })
  const [departmentSalesDenture, setDepartmentSalesDenture] = useState(
    () => savedData?.departmentSalesDenture ?? '',
  )
  const [departmentSalesCk, setDepartmentSalesCk] = useState(() => savedData?.departmentSalesCk ?? '')
  const [performanceRatePercentDenture, setPerformanceRatePercentDenture] = useState(
    () => savedData?.performanceRatePercentDenture ?? '',
  )
  const [performanceRatePercentCk, setPerformanceRatePercentCk] = useState(
    () => savedData?.performanceRatePercentCk ?? '',
  )
  const [targetSpecialDentureTotal, setTargetSpecialDentureTotal] = useState(
    () => savedData?.targetSpecialDentureTotal ?? '',
  )
  const [targetSpecialCkTotal, setTargetSpecialCkTotal] = useState(
    () => savedData?.targetSpecialCkTotal ?? '',
  )
  const [csvMessage, setCsvMessage] = useState('')
  const [sortKey, setSortKey] = useState(() => savedData?.sortKey ?? 'employeeNo')
  const [sortOrder, setSortOrder] = useState(() => savedData?.sortOrder ?? 'asc')
  const [workspaceView, setWorkspaceView] = useState(() => savedData?.workspaceView ?? 'gyoseki')
  const [settingsTab, setSettingsTab] = useState(() => savedData?.settingsTab ?? 'skill')
  const [activePage, setActivePage] = useState(() => savedData?.activePage ?? 'input')
  const [employeeDirectoryRows, setEmployeeDirectoryRows] = useState(() => {
    const saved = savedData?.employeeDirectoryRows
    return Array.isArray(saved) && saved.length > 0 ? saved : defaultEmployeeDirectoryRows
  })
  const [skillSettings, setSkillSettings] = useState(() => {
    const saved = savedData?.skillSettings
    const base = Array.isArray(saved) && saved.length > 0 ? saved : defaultSkillSettings
    return base.map((s) => {
      const st = Math.min(20, Math.max(1, Number(s.stages) || 3))
      const lc = resizeLevelCriteriaArray(Array.isArray(s.levelCriteria) ? s.levelCriteria : [], st)
      return {
        ...s,
        gradeId: typeof s.gradeId === 'string' && s.gradeId ? s.gradeId : 'G1',
        stages: st,
        levelCriteria: lc,
      }
    })
  })
  const [skillSections, setSkillSections] = useState(() => {
    const saved = savedData?.skillSections
    if (!Array.isArray(saved) || saved.length === 0) return defaultSkillSections
    const cleaned = saved.filter((s) => s && typeof s.id === 'string' && typeof s.label === 'string')
    return cleaned.length > 0 ? cleaned : defaultSkillSections
  })
  const [skillGrades, setSkillGrades] = useState(() => {
    const saved = savedData?.skillGrades
    if (!Array.isArray(saved) || saved.length === 0) return defaultSkillGrades
    const cleaned = saved.filter((g) => g && typeof g.id === 'string' && typeof g.label === 'string')
    return cleaned.length > 0 ? cleaned : defaultSkillGrades
  })
  const [skillActiveGradeId, setSkillActiveGradeId] = useState(() => {
    const g = savedData?.skillActiveGradeId
    return typeof g === 'string' && g ? g : 'G1'
  })
  const [skillEmployeeProgress, setSkillEmployeeProgress] = useState(() => {
    const s = savedData?.skillEmployeeProgress
    if (s && typeof s === 'object' && !Array.isArray(s)) {
      return { ...defaultSkillEmployeeProgress, ...s }
    }
    return { ...defaultSkillEmployeeProgress }
  })
  const [skillProgressUpdatedAtByEmployee, setSkillProgressUpdatedAtByEmployee] = useState(() => {
    const raw = savedData?.skillProgressUpdatedAtByEmployee
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) return { ...raw }
    const nowIso = new Date().toISOString()
    const sourceProgress =
      savedData?.skillEmployeeProgress && typeof savedData.skillEmployeeProgress === 'object' && !Array.isArray(savedData.skillEmployeeProgress)
        ? savedData.skillEmployeeProgress
        : defaultSkillEmployeeProgress
    const init = {}
    for (const [empId, prog] of Object.entries(sourceProgress)) {
      const hasAny = prog && typeof prog === 'object' ? Object.values(prog).some((v) => Number(v) > 0) : false
      if (hasAny) init[empId] = nowIso
    }
    return init
  })
  const [goalsByEmployee, setGoalsByEmployee] = useState(() => {
    const raw = savedData?.goalsByEmployee
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
    const out = {}
    for (const [empId, list] of Object.entries(raw)) {
      if (!Array.isArray(list)) continue
      out[empId] = list
        .map((g, idx) => ({
          id: typeof g?.id === 'string' && g.id ? g.id : `goal-${empId}-${idx}`,
          title: String(g?.title ?? '').trim(),
          detail: String(g?.detail ?? g?.description ?? '').trim(),
          deadline: String(g?.deadline ?? '').trim(),
          achieved: Boolean(g?.achieved),
        }))
        .filter((g) => g.title && g.deadline)
    }
    return out
  })
  const [evaluationCriteria, setEvaluationCriteria] = useState(() => {
    const raw = savedData?.evaluationCriteria
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      return normalizeEvaluationCriteriaStore(raw, defaultSkillGrades)
    }
    return buildDefaultEvaluationCriteriaFromSelfEval(defaultSkillGrades)
  })
  const [menuVisibilityByRole, setMenuVisibilityByRole] = useState(() => {
    const raw = savedData?.menuVisibilityByRole
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      return normalizeMenuVisibilityByRole(raw)
    }
    return normalizeMenuVisibilityByRole(null)
  })
  const [selfEvalByEmployee, setSelfEvalByEmployee] = useState(() => normalizeEvalByEmployeeMap(savedData?.selfEvalByEmployee))
  const [supervisorEvalByEmployee, setSupervisorEvalByEmployee] = useState(() =>
    normalizeEvalByEmployeeMap(savedData?.supervisorEvalByEmployee),
  )
  const [executiveEvalByEmployee, setExecutiveEvalByEmployee] = useState(() =>
    normalizeExecutiveEvalByEmployeeMap(savedData?.executiveEvalByEmployee),
  )
  const [selectedEvalEmployeeId, setSelectedEvalEmployeeId] = useState(null)
  const [adminSelectedMemberId, setAdminSelectedMemberId] = useState(null)
  const [adminDetailTab, setAdminDetailTab] = useState('skill')
  const [isCloudReady, setIsCloudReady] = useState(false)
  const [snapshotPeriod, setSnapshotPeriod] = useState(() => savedData?.snapshotPeriod ?? getCurrentPeriod())
  const [snapshotHistory, setSnapshotHistory] = useState([])
  const [snapshotMessage, setSnapshotMessage] = useState('')
  const [syncMessage, setSyncMessage] = useState(
    supabase ? 'Supabase同期を確認中...' : 'Supabase未設定（ローカル保存のみ）',
  )
  const [syncError, setSyncError] = useState('')

  useEffect(() => {
    setEvaluationCriteria((prev) => {
      const ids = new Set(skillGrades.map((g) => g.id))
      const next = {}
      let changed = false
      for (const id of ids) {
        next[id] = Array.isArray(prev[id]) ? prev[id] : []
        if (prev[id] === undefined) changed = true
      }
      for (const k of Object.keys(prev)) {
        if (!ids.has(k)) changed = true
      }
      return changed ? next : prev
    })
  }, [skillGrades])

  const prevSkillProgressRef = useRef(skillEmployeeProgress)
  useEffect(() => {
    const prev = prevSkillProgressRef.current ?? {}
    const next = skillEmployeeProgress ?? {}
    const changedEmpIds = new Set()
    for (const empId of new Set([...Object.keys(prev), ...Object.keys(next)])) {
      const a = JSON.stringify(prev[empId] ?? {})
      const b = JSON.stringify(next[empId] ?? {})
      if (a !== b) changedEmpIds.add(empId)
    }
    if (changedEmpIds.size > 0) {
      const nowIso = new Date().toISOString()
      setSkillProgressUpdatedAtByEmployee((prevMap) => {
        const out = { ...prevMap }
        for (const empId of changedEmpIds) out[empId] = nowIso
        return out
      })
    }
    prevSkillProgressRef.current = skillEmployeeProgress
  }, [skillEmployeeProgress])

  const updateRow = (id, key, value) => {
    setRows((prev) => prev.map((row) => (row.id === id ? { ...row, [key]: value } : row)))
  }

  const addRow = () => {
    setRows((prev) => [...prev, createRow(prev.length)])
  }

  const removeRow = (id) => {
    setRows((prev) => {
      if (prev.length <= 1) return prev
      return prev.filter((row) => row.id !== id)
    })
  }

  const handlePhotoUpload = (id, file) => {
    if (!file) return

    const reader = new FileReader()
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : ''
      updateRow(id, 'photoDataUrl', result)
    }
    reader.readAsDataURL(file)
  }

  const handleImportCsv = async (event) => {
    const file = event.target.files?.[0]
    if (!file) return

    try {
      const content = await file.text()
      const lines = content
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line !== '')

      if (lines.length < 2) {
        setCsvMessage('CSVにデータ行がありません。')
        return
      }

      const parseLine = (line) =>
        line
          .split(',')
          .map((value) => value.trim().replace(/^"|"$/g, ''))

      const headers = parseLine(lines[0])
      const headerIndex = (candidates) => {
        for (const name of candidates) {
          const idx = headers.findIndex((header) => header === name)
          if (idx >= 0) return idx
        }
        return -1
      }

      const employeeNoIdx = headerIndex(['社員C', '社員番号', 'ID', 'id'])
      const employeeNameIdx = headerIndex(['社員名', '名前'])
      const gradeIdx = headerIndex(['等級', 'グレード'])
      const teamIdx = headerIndex(['区分'])
      const scoreIdx = headerIndex(['評価スコア', '総合得点'])
      const specialIdx = headerIndex(['特別手当'])
      const noteIdx = headerIndex(['備考欄'])

      if (employeeNoIdx < 0 && employeeNameIdx < 0) {
        setCsvMessage('CSVヘッダーを確認してください（社員番号 or 社員名は必須）。')
        return
      }

      const importedRows = lines
        .slice(1)
        .map((line, index) => {
          const cols = parseLine(line)
          const inputGrade = gradeIdx >= 0 ? cols[gradeIdx] || '' : ''
          const normalizedGrade = gradeAliasMap[inputGrade] ?? 'G3'
          const inputTeam = teamIdx >= 0 ? cols[teamIdx] || '' : ''
          const normalizedTeam = teamAliasMap[inputTeam] ?? 'denture'

          return {
            id: Date.now() + index,
            employeeNo: employeeNoIdx >= 0 ? cols[employeeNoIdx] || '' : '',
            employeeName: employeeNameIdx >= 0 ? cols[employeeNameIdx] || '' : '',
            photoDataUrl: '',
            team: normalizedTeam,
            grade: normalizedGrade,
            score: scoreIdx >= 0 ? sanitizeDecimalInput(cols[scoreIdx] || '') : '',
            specialAllowance:
              specialIdx >= 0 ? sanitizeIntegerInput(cols[specialIdx] || '') : '',
            note: noteIdx >= 0 ? cols[noteIdx] || '' : '',
          }
        })
        .filter((row) => row.employeeNo !== '' || row.employeeName !== '')

      if (importedRows.length === 0) {
        setCsvMessage('取り込める社員データがありませんでした。')
        return
      }

      let replacedCount = 0
      let appendedCount = 0
      setRows((prev) => {
        const next = [...prev]
        const indexByEmployeeNo = new Map()
        next.forEach((row, idx) => {
          const key = String(row.employeeNo ?? '').trim()
          if (key) indexByEmployeeNo.set(key, idx)
        })

        for (const imported of importedRows) {
          const key = String(imported.employeeNo ?? '').trim()
          if (key && indexByEmployeeNo.has(key)) {
            const targetIdx = indexByEmployeeNo.get(key)
            const current = next[targetIdx]
            next[targetIdx] = {
              ...current,
              ...imported,
              id: current.id,
              photoDataUrl: current.photoDataUrl,
            }
            replacedCount += 1
          } else {
            next.push(imported)
            const newIdx = next.length - 1
            if (key) indexByEmployeeNo.set(key, newIdx)
            appendedCount += 1
          }
        }

        return next
      })
      setCsvMessage(
        `${importedRows.length}件を取り込みました（上書き: ${replacedCount}件 / 追加: ${appendedCount}件）。`,
      )
    } catch {
      setCsvMessage('CSVの読み込みに失敗しました。形式を確認してください。')
    } finally {
      event.target.value = ''
    }
  }

  const handleExportCsv = () => {
    const csvContent = buildCsvContent()
    downloadCsvFile(csvContent)
  }

  const buildCsvContent = () => {
    const headers = [
      '社員番号',
      '社員名',
      '顔写真',
      '区分',
      '等級',
      '評価スコア',
      '業績手当',
      '特別手当',
      '第3回目賞与',
      '備考欄',
    ]
    const escapeCsvValue = (value) => `"${String(value ?? '').replace(/"/g, '""')}"`
    const rowsForExport = sortedRows.map((row) => [
      row.employeeNo,
      row.employeeName,
      row.photoDataUrl ? '登録済み' : '',
      row.team === 'ck' ? 'CK' : 'デンチャー',
      row.grade,
      row.score,
      row.performanceAllowance,
      row.specialAllowance,
      row.thirdBonus,
      row.note,
    ])
    return [headers, ...rowsForExport]
      .map((line) => line.map(escapeCsvValue).join(','))
      .join('\r\n')
  }

  const downloadCsvFile = (csvContent) => {
    const bom = '\uFEFF'
    const blob = new Blob([bom + csvContent], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    const date = new Date().toISOString().slice(0, 10)

    link.href = url
    link.download = `performance_allowance_${date}.csv`
    link.click()

    URL.revokeObjectURL(url)
  }

  const computedRows = useMemo(() => {
    const salesDentureValue = Number(departmentSalesDenture === '' ? 0 : departmentSalesDenture) || 0
    const salesCkValue = Number(departmentSalesCk === '' ? 0 : departmentSalesCk) || 0
    const rateDentureValue =
      Number(performanceRatePercentDenture === '' ? 0 : performanceRatePercentDenture) || 0
    const rateCkValue = Number(performanceRatePercentCk === '' ? 0 : performanceRatePercentCk) || 0
    const targetDentureTotal = Math.round(salesDentureValue * (rateDentureValue / 100))
    const targetCkTotal = Math.round(salesCkValue * (rateCkValue / 100))
    const targetSpecialDenture =
      Number(targetSpecialDentureTotal === '' ? 0 : targetSpecialDentureTotal) || 0
    const targetSpecialCk = Number(targetSpecialCkTotal === '' ? 0 : targetSpecialCkTotal) || 0

    const weightedRows = rows.map((row) => {
      const score = Number(row.score === '' ? 0 : row.score) || 0
      const specialAllowance = Number(row.specialAllowance === '' ? 0 : row.specialAllowance) || 0
      const gradeRate = gradeRates[row.grade] ?? 0
      const weightedScore = score * gradeRate
      const team = row.team === 'ck' ? 'ck' : 'denture'

      return {
        ...row,
        team,
        score,
        specialAllowance,
        weightedScore,
      }
    })

    const dentureWeightedTotal = weightedRows
      .filter((row) => row.team === 'denture')
      .reduce((sum, row) => sum + row.weightedScore, 0)
    const ckWeightedTotal = weightedRows
      .filter((row) => row.team === 'ck')
      .reduce((sum, row) => sum + row.weightedScore, 0)

    return weightedRows.map((row) => {
      const performanceTeamWeightedTotal = row.team === 'ck' ? ckWeightedTotal : dentureWeightedTotal
      const performanceTeamTargetTotal = row.team === 'ck' ? targetCkTotal : targetDentureTotal
      const performanceAllocationRate =
        performanceTeamWeightedTotal > 0 ? row.weightedScore / performanceTeamWeightedTotal : 0
      const performanceAllowance = Math.round(performanceAllocationRate * performanceTeamTargetTotal)
      const teamWeightedTotal = row.team === 'ck' ? ckWeightedTotal : dentureWeightedTotal
      const teamTargetTotal = row.team === 'ck' ? targetSpecialCk : targetSpecialDenture
      const teamAllocationRate = teamWeightedTotal > 0 ? row.weightedScore / teamWeightedTotal : 0
      const thirdBonus = Math.round(teamAllocationRate * teamTargetTotal)

      return {
        ...row,
        performanceAllowance,
        thirdBonus,
      }
    })
  }, [
    rows,
    departmentSalesDenture,
    departmentSalesCk,
    performanceRatePercentDenture,
    performanceRatePercentCk,
    targetSpecialDentureTotal,
    targetSpecialCkTotal,
  ])

  const totals = useMemo(
    () =>
      computedRows.reduce(
        (acc, row) => {
          acc.performanceAllowance += row.performanceAllowance
          acc.specialAllowance += row.specialAllowance
          acc.thirdBonus += row.thirdBonus
          return acc
        },
        { performanceAllowance: 0, specialAllowance: 0, thirdBonus: 0 },
      ),
    [computedRows],
  )

  const sortedRows = useMemo(() => {
    const direction = sortOrder === 'asc' ? 1 : -1
    const toString = (value) => String(value ?? '').toLowerCase()

    return [...computedRows].sort((a, b) => {
      if (sortKey === 'score') return (a.score - b.score) * direction
      if (sortKey === 'employeeNo') {
        const aNo = Number(a.employeeNo)
        const bNo = Number(b.employeeNo)
        const aIsNumeric = Number.isFinite(aNo) && a.employeeNo !== ''
        const bIsNumeric = Number.isFinite(bNo) && b.employeeNo !== ''

        if (aIsNumeric && bIsNumeric) return (aNo - bNo) * direction
        if (aIsNumeric) return -1 * direction
        if (bIsNumeric) return 1 * direction
        return toString(a.employeeNo).localeCompare(toString(b.employeeNo), 'ja') * direction
      }
      if (sortKey === 'performanceAllowance')
        return (a.performanceAllowance - b.performanceAllowance) * direction
      if (sortKey === 'thirdBonus') return (a.thirdBonus - b.thirdBonus) * direction
      if (sortKey === 'grade') return (gradeRates[a.grade] - gradeRates[b.grade]) * direction
      if (sortKey === 'team') return toString(a.team).localeCompare(toString(b.team), 'ja') * direction

      return toString(a[sortKey]).localeCompare(toString(b[sortKey]), 'ja') * direction
    })
  }, [computedRows, sortKey, sortOrder])

  const salesDentureValue = Number(departmentSalesDenture === '' ? 0 : departmentSalesDenture) || 0
  const salesCkValue = Number(departmentSalesCk === '' ? 0 : departmentSalesCk) || 0
  const rateDentureValue =
    Number(performanceRatePercentDenture === '' ? 0 : performanceRatePercentDenture) || 0
  const rateCkValue = Number(performanceRatePercentCk === '' ? 0 : performanceRatePercentCk) || 0
  const targetTotalDentureValue = Math.round(salesDentureValue * (rateDentureValue / 100))
  const targetTotalCkValue = Math.round(salesCkValue * (rateCkValue / 100))
  const targetTotalValue = targetTotalDentureValue + targetTotalCkValue
  const targetSpecialDentureValue =
    Number(targetSpecialDentureTotal === '' ? 0 : targetSpecialDentureTotal) || 0
  const targetSpecialCkValue = Number(targetSpecialCkTotal === '' ? 0 : targetSpecialCkTotal) || 0
  const targetSpecialTotalValue = targetSpecialDentureValue + targetSpecialCkValue
  const totalGap = targetTotalValue - totals.performanceAllowance
  const specialTotalGap = targetSpecialTotalValue - totals.thirdBonus
  const denturePerformanceTotal = computedRows
    .filter((row) => row.team === 'denture')
    .reduce((sum, row) => sum + row.performanceAllowance, 0)
  const ckPerformanceTotal = computedRows
    .filter((row) => row.team === 'ck')
    .reduce((sum, row) => sum + row.performanceAllowance, 0)
  const denturePerformanceGap = targetTotalDentureValue - denturePerformanceTotal
  const ckPerformanceGap = targetTotalCkValue - ckPerformanceTotal
  const dentureThirdBonusTotal = computedRows
    .filter((row) => row.team === 'denture')
    .reduce((sum, row) => sum + row.thirdBonus, 0)
  const ckThirdBonusTotal = computedRows
    .filter((row) => row.team === 'ck')
    .reduce((sum, row) => sum + row.thirdBonus, 0)
  const dentureGap = targetSpecialDentureValue - dentureThirdBonusTotal
  const ckGap = targetSpecialCkValue - ckThirdBonusTotal

  const formatJPY = (value) =>
    new Intl.NumberFormat('ja-JP', {
      style: 'currency',
      currency: 'JPY',
      maximumFractionDigits: 0,
    }).format(value)

  const loggedInEmployee = useMemo(() => {
    if (loggedInEmployeeId) {
      const own = employeeDirectoryRows.find((row) => row.id === loggedInEmployeeId)
      if (own) return own
    }
    return employeeDirectoryRows[0] ?? null
  }, [employeeDirectoryRows, loggedInEmployeeId])
  const loggedInAccountLabel = loginMode === 'admin' ? '管理者' : loggedInEmployee?.name ?? '従業員'

  const goalMgmtEmployee = loggedInEmployee
  const goalMgmtGoals = useMemo(
    () => (goalMgmtEmployee ? goalsByEmployee[goalMgmtEmployee.id] ?? [] : []),
    [goalMgmtEmployee, goalsByEmployee],
  )

  const setGoalMgmtGoals = useCallback(
    (updater) => {
      setGoalsByEmployee((prev) => {
        const emp = goalMgmtEmployee
        if (!emp) return prev
        const cur = prev[emp.id] ?? []
        const next = typeof updater === 'function' ? updater(cur) : updater
        return { ...prev, [emp.id]: Array.isArray(next) ? next : cur }
      })
    },
    [goalMgmtEmployee],
  )

  const evalSubjectEmployee = useMemo(() => {
    if (!employeeDirectoryRows.length) return null
    if (loggedInEmployeeId && loginMode !== 'admin') {
      const own = employeeDirectoryRows.find((row) => row.id === loggedInEmployeeId)
      if (own) return own
    }
    if (selectedEvalEmployeeId) {
      const found = employeeDirectoryRows.find((row) => row.id === selectedEvalEmployeeId)
      if (found) return found
    }
    return employeeDirectoryRows[0] ?? null
  }, [employeeDirectoryRows, selectedEvalEmployeeId, loggedInEmployeeId, loginMode])

  const updateSelfEvalForSubject = useCallback(
    (updater) => {
      if (!evalSubjectEmployee) return
      setSelfEvalByEmployee((prev) => {
        const cur = prev[evalSubjectEmployee.id] ?? { scores: {}, comments: {} }
        const next = typeof updater === 'function' ? updater(cur) : updater
        return { ...prev, [evalSubjectEmployee.id]: next }
      })
    },
    [evalSubjectEmployee],
  )

  const updateSupervisorEvalForSubject = useCallback(
    (updater) => {
      if (!evalSubjectEmployee) return
      setSupervisorEvalByEmployee((prev) => {
        const cur = prev[evalSubjectEmployee.id] ?? { scores: {}, comments: {} }
        const next = typeof updater === 'function' ? updater(cur) : updater
        return { ...prev, [evalSubjectEmployee.id]: next }
      })
    },
    [evalSubjectEmployee],
  )

  const updateExecutiveEvalForSubject = useCallback(
    (updater) => {
      if (!evalSubjectEmployee) return
      setExecutiveEvalByEmployee((prev) => {
        const cur = prev[evalSubjectEmployee.id] ?? { baseScore: 0, commentHistory: [] }
        const next = typeof updater === 'function' ? updater(cur) : updater
        return { ...prev, [evalSubjectEmployee.id]: next }
      })
    },
    [evalSubjectEmployee],
  )

  const menuRoleKey = useMemo(
    () => resolveMenuRoleKey(email.trim().toLowerCase(), employeeDirectoryRows),
    [email, employeeDirectoryRows],
  )

  const isWorkspaceMenuVisible = useCallback(
    (key) => isWorkspaceVisibleForRole(key, menuRoleKey, menuVisibilityByRole),
    [menuRoleKey, menuVisibilityByRole],
  )

  useEffect(() => {
    if (!isLoggedIn) return
    if (isWorkspaceMenuVisible(workspaceView)) return
    const order = [
      'gyoseki',
      'settings',
      'admin',
      'employee',
      'skillup',
      'selfeval',
      'goals',
      'bossEval',
      'execEval',
    ]
    const next = order.find((k) => isWorkspaceMenuVisible(k)) ?? 'gyoseki'
    setWorkspaceView(next)
  }, [isLoggedIn, workspaceView, menuVisibilityByRole, menuRoleKey, isWorkspaceMenuVisible])

  const handleLogin = (event) => {
    event.preventDefault()

    const normalizedLoginId = email.trim().toLowerCase()
    if (loginMode === 'admin') {
      if (normalizedLoginId === 'admin@example.com' && password === adminPassword) {
        setIsLoggedIn(true)
        setLoggedInEmployeeId(null)
        setLoginError('')
        return
      }
      setLoginError('管理者IDまたはパスワードが違います。')
      return
    }

    const matchedEmployee = employeeDirectoryRows.find(
      (row) =>
        String(row.id ?? '')
          .trim()
          .toLowerCase() === normalizedLoginId && String(row.password ?? '') === password,
    )
    if (matchedEmployee) {
      setIsLoggedIn(true)
      setLoggedInEmployeeId(matchedEmployee.id)
      setLoginError('')
      return
    }
    setLoginError('社員Noまたはパスワードが違います。')
  }

  const handlePasswordReset = (event) => {
    event.preventDefault()
    const id = resetId.trim().toLowerCase()
    if (!id || !resetPrevPassword || !resetNextPassword) {
      window.alert('すべての項目を入力してください。')
      return
    }
    if (id === 'admin@example.com') {
      if (resetPrevPassword !== adminPassword) {
        window.alert('IDまたは以前のパスワードが違います。')
        return
      }
      setAdminPassword(resetNextPassword)
      window.alert('管理者パスワードを更新しました。')
      setPassword('')
      setEmail('admin@example.com')
      setLoginMode('admin')
      setResetModalOpen(false)
      setResetId('')
      setResetPrevPassword('')
      setResetNextPassword('')
      return
    }

    let updated = false
    setEmployeeDirectoryRows((prev) =>
      prev.map((row) => {
        const idMatch =
          String(row.id ?? '')
            .trim()
            .toLowerCase() === id
        const passMatch = String(row.password ?? '') === resetPrevPassword
        if (idMatch && passMatch) {
          updated = true
          return { ...row, password: resetNextPassword }
        }
        return row
      }),
    )
    if (!updated) {
      window.alert('IDまたは以前のパスワードが違います。')
      return
    }
    window.alert('パスワードを更新しました。')
    setResetModalOpen(false)
    setResetId('')
    setResetPrevPassword('')
    setResetNextPassword('')
  }

  const handleLogout = () => {
    setIsLoggedIn(false)
    setLoggedInEmployeeId(null)
  }

  const saveCloudState = useCallback(async (payload) => {
    if (!supabase) {
      setSyncMessage('Supabase未設定（ローカル保存のみ）')
      setSyncError('Supabaseが未設定です。.env.local の設定を確認してください。')
      return false
    }
    setSyncMessage('Supabaseに保存中...')
    const { error } = await supabase
      .from('app_state')
      .upsert({ id: CLOUD_STATE_ID, payload }, { onConflict: 'id' })
    if (error) {
      setSyncMessage('Supabase保存失敗（ローカル保存は有効）')
      setSyncError('クラウド保存に失敗しました。ネットワークまたはSupabase設定を確認して再試行してください。')
      return false
    }
    setSyncMessage('Supabaseに保存済み')
    setSyncError('')
    return true
  }, [])

  const handleRetryCloudSync = async () => {
    const payload = buildPersistPayload()
    await saveCloudState(payload)
  }

  const buildPersistPayload = (includeSensitive = true) => {
    const payload = {
      rows,
      employeeDirectoryRows: includeSensitive ? employeeDirectoryRows : stripSensitiveEmployeeFields(employeeDirectoryRows),
      skillSettings,
      skillSections,
      skillGrades,
      skillActiveGradeId,
      skillEmployeeProgress,
      skillProgressUpdatedAtByEmployee,
      goalsByEmployee,
      evaluationCriteria,
      menuVisibilityByRole,
      selfEvalByEmployee,
      supervisorEvalByEmployee,
      executiveEvalByEmployee,
      departmentSalesDenture,
      departmentSalesCk,
      performanceRatePercentDenture,
      performanceRatePercentCk,
      targetSpecialDentureTotal,
      targetSpecialCkTotal,
      sortKey,
      sortOrder,
      workspaceView,
      settingsTab,
      activePage,
      snapshotPeriod,
    }
    if (includeSensitive) payload.adminPassword = adminPassword
    return payload
  }

  const applyPersistPayload = (payload) => {
    const cloudRows = Array.isArray(payload.rows) && payload.rows.length > 0 ? payload.rows : null
    if (cloudRows) setRows(cloudRows)
    if (Array.isArray(payload.employeeDirectoryRows) && payload.employeeDirectoryRows.length > 0) {
      setEmployeeDirectoryRows(payload.employeeDirectoryRows)
    }
    if (Array.isArray(payload.skillSettings)) {
      setSkillSettings(
        payload.skillSettings.map((s) => {
          const st = Math.min(20, Math.max(1, Number(s.stages) || 3))
          const lc = resizeLevelCriteriaArray(Array.isArray(s.levelCriteria) ? s.levelCriteria : [], st)
          return {
            ...s,
            gradeId: typeof s.gradeId === 'string' && s.gradeId ? s.gradeId : 'G1',
            stages: st,
            levelCriteria: lc,
          }
        }),
      )
    }
    if (Array.isArray(payload.skillGrades) && payload.skillGrades.length > 0) {
      const cleaned = payload.skillGrades.filter(
        (g) => g && typeof g.id === 'string' && typeof g.label === 'string',
      )
      if (cleaned.length > 0) setSkillGrades(cleaned)
    }
    if (typeof payload.skillActiveGradeId === 'string' && payload.skillActiveGradeId) {
      setSkillActiveGradeId(payload.skillActiveGradeId)
    }
    if (payload.skillEmployeeProgress && typeof payload.skillEmployeeProgress === 'object' && !Array.isArray(payload.skillEmployeeProgress)) {
      setSkillEmployeeProgress({ ...defaultSkillEmployeeProgress, ...payload.skillEmployeeProgress })
    }
    if (
      payload.skillProgressUpdatedAtByEmployee &&
      typeof payload.skillProgressUpdatedAtByEmployee === 'object' &&
      !Array.isArray(payload.skillProgressUpdatedAtByEmployee)
    ) {
      setSkillProgressUpdatedAtByEmployee({ ...payload.skillProgressUpdatedAtByEmployee })
    }
    if (payload.goalsByEmployee && typeof payload.goalsByEmployee === 'object' && !Array.isArray(payload.goalsByEmployee)) {
      setGoalsByEmployee((prev) => {
        const merged = { ...prev }
        for (const [empId, list] of Object.entries(payload.goalsByEmployee)) {
          if (!Array.isArray(list)) continue
          merged[empId] = list
            .map((g, idx) => ({
              id: typeof g?.id === 'string' && g.id ? g.id : `goal-${empId}-${idx}`,
              title: String(g?.title ?? '').trim(),
              detail: String(g?.detail ?? g?.description ?? '').trim(),
              deadline: String(g?.deadline ?? '').trim(),
              achieved: Boolean(g?.achieved),
            }))
            .filter((g) => g.title && g.deadline)
        }
        return merged
      })
    }
    if (payload.evaluationCriteria && typeof payload.evaluationCriteria === 'object' && !Array.isArray(payload.evaluationCriteria)) {
      const gradeList =
        Array.isArray(payload.skillGrades) && payload.skillGrades.length > 0
          ? payload.skillGrades.filter((g) => g && typeof g.id === 'string' && typeof g.label === 'string')
          : defaultSkillGrades
      setEvaluationCriteria(normalizeEvaluationCriteriaStore(payload.evaluationCriteria, gradeList))
    }
    if (payload.menuVisibilityByRole && typeof payload.menuVisibilityByRole === 'object' && !Array.isArray(payload.menuVisibilityByRole)) {
      setMenuVisibilityByRole(normalizeMenuVisibilityByRole(payload.menuVisibilityByRole))
    }
    if (payload.selfEvalByEmployee && typeof payload.selfEvalByEmployee === 'object' && !Array.isArray(payload.selfEvalByEmployee)) {
      setSelfEvalByEmployee(normalizeEvalByEmployeeMap(payload.selfEvalByEmployee))
    }
    if (
      payload.supervisorEvalByEmployee &&
      typeof payload.supervisorEvalByEmployee === 'object' &&
      !Array.isArray(payload.supervisorEvalByEmployee)
    ) {
      setSupervisorEvalByEmployee(normalizeEvalByEmployeeMap(payload.supervisorEvalByEmployee))
    }
    if (
      payload.executiveEvalByEmployee &&
      typeof payload.executiveEvalByEmployee === 'object' &&
      !Array.isArray(payload.executiveEvalByEmployee)
    ) {
      setExecutiveEvalByEmployee(normalizeExecutiveEvalByEmployeeMap(payload.executiveEvalByEmployee))
    }
    if (typeof payload.adminPassword === 'string' && payload.adminPassword) {
      setAdminPassword(payload.adminPassword)
    }
    if (Array.isArray(payload.skillSections) && payload.skillSections.length > 0) {
      const cleaned = payload.skillSections.filter(
        (s) => s && typeof s.id === 'string' && typeof s.label === 'string',
      )
      if (cleaned.length > 0) setSkillSections(cleaned)
    }
    if (typeof payload.departmentSalesDenture === 'string') {
      setDepartmentSalesDenture(payload.departmentSalesDenture)
    }
    if (typeof payload.departmentSalesCk === 'string') setDepartmentSalesCk(payload.departmentSalesCk)
    if (typeof payload.performanceRatePercentDenture === 'string') {
      setPerformanceRatePercentDenture(payload.performanceRatePercentDenture)
    }
    if (typeof payload.performanceRatePercentCk === 'string') {
      setPerformanceRatePercentCk(payload.performanceRatePercentCk)
    }
    if (typeof payload.targetSpecialDentureTotal === 'string') {
      setTargetSpecialDentureTotal(payload.targetSpecialDentureTotal)
    }
    if (typeof payload.targetSpecialCkTotal === 'string') {
      setTargetSpecialCkTotal(payload.targetSpecialCkTotal)
    }
    if (
      typeof payload.departmentSales === 'string' &&
      typeof payload.departmentSalesDenture !== 'string' &&
      typeof payload.departmentSalesCk !== 'string'
    ) {
      setDepartmentSalesDenture(payload.departmentSales)
    }
    if (
      typeof payload.performanceRatePercent === 'string' &&
      typeof payload.performanceRatePercentDenture !== 'string' &&
      typeof payload.performanceRatePercentCk !== 'string'
    ) {
      setPerformanceRatePercentDenture(payload.performanceRatePercent)
    }
    if (
      typeof payload.targetSpecialBonusTotal === 'string' &&
      typeof payload.targetSpecialDentureTotal !== 'string' &&
      typeof payload.targetSpecialCkTotal !== 'string'
    ) {
      setTargetSpecialDentureTotal(payload.targetSpecialBonusTotal)
    }
    if (typeof payload.sortKey === 'string') setSortKey(payload.sortKey)
    if (payload.sortOrder === 'asc' || payload.sortOrder === 'desc') setSortOrder(payload.sortOrder)
    if (
      payload.workspaceView === 'gyoseki' ||
      payload.workspaceView === 'admin' ||
      payload.workspaceView === 'employee' ||
      payload.workspaceView === 'skill' ||
      payload.workspaceView === 'settings' ||
      payload.workspaceView === 'skillup' ||
      payload.workspaceView === 'selfeval' ||
      payload.workspaceView === 'goals' ||
      payload.workspaceView === 'evalcriteria' ||
      payload.workspaceView === 'menusettings' ||
      payload.workspaceView === 'bossEval' ||
      payload.workspaceView === 'execEval'
    ) {
      if (
        payload.workspaceView === 'skill' ||
        payload.workspaceView === 'evalcriteria' ||
        payload.workspaceView === 'menusettings'
      ) {
        setWorkspaceView('settings')
      } else {
        setWorkspaceView(payload.workspaceView)
      }
    }
    if (
      payload.settingsTab === 'skill' ||
      payload.settingsTab === 'evalcriteria' ||
      payload.settingsTab === 'menusettings'
    ) {
      setSettingsTab(payload.settingsTab)
    }
    if (payload.activePage === 'input' || payload.activePage === 'calc') setActivePage(payload.activePage)
    if (typeof payload.snapshotPeriod === 'string' && payload.snapshotPeriod) {
      setSnapshotPeriod(payload.snapshotPeriod)
    }
  }

  const fetchSnapshotHistory = async () => {
    if (!supabase) return
    const { data, error } = await supabase
      .from('app_snapshots')
      .select('period,created_at')
      .order('period', { ascending: false })
      .limit(24)

    if (error) {
      setSnapshotMessage('履歴取得に失敗しました')
      return
    }
    setSnapshotHistory(data ?? [])
  }

  const handleSaveSnapshot = async () => {
    if (!supabase) {
      setSnapshotMessage('Supabase設定後に利用できます')
      return
    }
    if (!snapshotPeriod) {
      setSnapshotMessage('対象年月を入力してください')
      return
    }
    const payload = buildPersistPayload()
    const { error } = await supabase
      .from('app_snapshots')
      .upsert({ period: snapshotPeriod, payload }, { onConflict: 'period' })

    if (error) {
      setSnapshotMessage('確定保存に失敗しました')
      return
    }
    setSnapshotMessage(`${snapshotPeriod} を確定保存しました`)
    fetchSnapshotHistory()
  }

  const handleLoadSnapshot = async (period) => {
    if (!supabase) {
      setSnapshotMessage('Supabase設定後に利用できます')
      return
    }
    const { data, error } = await supabase
      .from('app_snapshots')
      .select('payload')
      .eq('period', period)
      .maybeSingle()

    if (error || !data?.payload) {
      setSnapshotMessage('履歴読込に失敗しました')
      return
    }
    applyPersistPayload(data.payload)
    setSnapshotMessage(`${period} の履歴を読み込みました`)
  }

  useEffect(() => {
    let isActive = true

    const loadCloudState = async () => {
      if (!supabase) {
        if (isActive) setIsCloudReady(true)
        return
      }

      const { data, error } = await supabase
        .from('app_state')
        .select('payload')
        .eq('id', CLOUD_STATE_ID)
        .maybeSingle()

      if (!isActive) return

      if (error) {
        setSyncMessage('Supabase読込失敗（ローカル保存は有効）')
        setIsCloudReady(true)
        return
      }

      const payload = data?.payload
      if (payload && typeof payload === 'object') {
        applyPersistPayload(payload)
        setSyncMessage('Supabaseから復元済み')
      } else {
        setSyncMessage('Supabase同期待機中（初回保存で作成）')
      }

      setIsCloudReady(true)
    }

    loadCloudState()

    return () => {
      isActive = false
    }
  }, [])

  useEffect(() => {
    if (typeof window === 'undefined') return

    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify(buildPersistPayload(false)),
    )
  }, [
    rows,
    employeeDirectoryRows,
    skillSettings,
    skillSections,
    skillGrades,
    skillActiveGradeId,
    skillEmployeeProgress,
    skillProgressUpdatedAtByEmployee,
    goalsByEmployee,
    evaluationCriteria,
    menuVisibilityByRole,
    selfEvalByEmployee,
    supervisorEvalByEmployee,
    executiveEvalByEmployee,
    adminPassword,
    departmentSalesDenture,
    departmentSalesCk,
    performanceRatePercentDenture,
    performanceRatePercentCk,
    targetSpecialDentureTotal,
    targetSpecialCkTotal,
    sortKey,
    sortOrder,
    workspaceView,
    settingsTab,
    activePage,
    snapshotPeriod,
  ])

  useEffect(() => {
    if (!supabase || !isCloudReady) return

    const payload = buildPersistPayload()

    const timer = window.setTimeout(async () => {
      await saveCloudState(payload)
    }, 600)

    return () => window.clearTimeout(timer)
  }, [
    rows,
    employeeDirectoryRows,
    skillSettings,
    skillSections,
    skillGrades,
    skillActiveGradeId,
    skillEmployeeProgress,
    skillProgressUpdatedAtByEmployee,
    goalsByEmployee,
    evaluationCriteria,
    menuVisibilityByRole,
    selfEvalByEmployee,
    supervisorEvalByEmployee,
    executiveEvalByEmployee,
    adminPassword,
    departmentSalesDenture,
    departmentSalesCk,
    performanceRatePercentDenture,
    performanceRatePercentCk,
    targetSpecialDentureTotal,
    targetSpecialCkTotal,
    sortKey,
    sortOrder,
    workspaceView,
    settingsTab,
    activePage,
    snapshotPeriod,
    isCloudReady,
    saveCloudState,
  ])

  useEffect(() => {
    if (!supabase || !isCloudReady) return
    fetchSnapshotHistory()
  }, [isCloudReady])

  return (
    <main className={`app ${!isLoggedIn ? 'appLogin' : ''}`}>
      <section className={`card ${!isLoggedIn ? 'cardLogin' : ''}`}>
        {!isLoggedIn ? (
          <div className="loginScreen">
            <section className="loginPanel adminLoginPanel">
              <div className="loginBrandMark" aria-hidden>
                🛡️
              </div>
              <h1 className={`loginBrandTitle${loginMode === 'admin' ? ' isAdmin' : ''}`}>
                {loginMode === 'admin' ? '管理者ログイン' : 'WorkVision'}
              </h1>
              <p className="loginBrandSub">{loginMode === 'admin' ? 'システム管理・人材育成統括' : '成長が見える、次がわかる'}</p>

              <form className="loginForm" onSubmit={handleLogin}>
                <label>
                  {loginMode === 'admin' ? '管理者ID' : '社員No'}
                  <input
                    type="text"
                    value={email}
                    onChange={(event) => setEmail(event.target.value)}
                    placeholder={loginMode === 'admin' ? 'admin@example.com' : '社員Noを入力してください'}
                    required
                    autoComplete="username"
                  />
                </label>

                <label>
                  パスワード
                  <input
                    type="password"
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    placeholder="パスワードを入力してください"
                    required
                    autoComplete="current-password"
                  />
                </label>

                <div className="loginAuxRow">
                  <label className="rememberLoginCheck">
                    <input
                      type="checkbox"
                      checked={rememberLogin}
                      onChange={(event) => setRememberLogin(event.target.checked)}
                    />
                    ログイン状態を保持
                  </label>
                  <button
                    type="button"
                    className="linkButton"
                    onClick={() => {
                      setResetId(email || (loginMode === 'admin' ? 'admin@example.com' : ''))
                      setResetModalOpen(true)
                    }}
                  >
                    パスワードをお忘れですか？
                  </button>
                </div>

                {loginError ? <p className="errorMessage">{loginError}</p> : null}

                <button type="submit" className="primaryButton loginSubmitBtn">
                  {loginMode === 'admin' ? '🛡️ 管理者としてログイン' : 'ログイン'}
                </button>
              </form>

              <button
                type="button"
                className="linkButton adminLink"
                onClick={() => {
                  const nextMode = loginMode === 'admin' ? 'employee' : 'admin'
                  setLoginMode(nextMode)
                  setLoginError('')
                  setEmail(nextMode === 'admin' ? 'admin@example.com' : '')
                  setPassword('')
                }}
              >
                {loginMode === 'admin' ? '← 従業員ログインはこちら' : '← 管理者ログインはこちら'}
              </button>
            </section>

            <section className="loginInfoPanel" aria-label="ログイン案内">
              <article className="loginInfoCard">
                <span aria-hidden>{loginMode === 'admin' ? '👥' : '📊'}</span>
                <div>
                  <h3>{loginMode === 'admin' ? '全従業員を管理' : 'スキルの可視化'}</h3>
                  <p>
                    {loginMode === 'admin'
                      ? 'スキル習得状況の一元管理と分析'
                      : '何を身につければいいかが見える化され、成長の方向性と評価につながります'}
                  </p>
                </div>
              </article>
              <article className="loginInfoCard">
                <span aria-hidden>{loginMode === 'admin' ? '⚙️' : '🎯'}</span>
                <div>
                  <h3>{loginMode === 'admin' ? 'スキル設定' : '働き方'}</h3>
                  <p>
                    {loginMode === 'admin'
                      ? '部署別必須スキルと難易度の設定'
                      : '作業数を見える化することで、時間厳守と無駄を減らす実現する職場づくりを支えます'}
                  </p>
                </div>
              </article>
              <article className="loginInfoCard">
                <span aria-hidden>{loginMode === 'admin' ? '📊' : '📈'}</span>
                <div>
                  <h3>{loginMode === 'admin' ? 'データ分析' : '成長をサポート'}</h3>
                  <p>
                    {loginMode === 'admin'
                      ? '停滞アラートと成長トレンド可視化'
                      : '上司からのフィードバックと自身の目標をもとに、次に何をすべきかを明確にし成長を後押しします'}
                  </p>
                </div>
              </article>
            </section>

            {resetModalOpen ? (
              <div className="employeeModalOverlay" onClick={() => setResetModalOpen(false)}>
                <div className="employeeModal loginResetModal" onClick={(event) => event.stopPropagation()}>
                  <button className="modalClose" type="button" onClick={() => setResetModalOpen(false)}>
                    ×
                  </button>
                  <h3>パスワードの再設定</h3>
                  <p>ID、以前のパスワード、新しいパスワードを入力してください</p>
                  <form className="loginResetForm" onSubmit={handlePasswordReset}>
                    <label>
                      ID
                      <input
                        type="text"
                        value={resetId}
                        onChange={(event) => setResetId(event.target.value)}
                        placeholder="IDを入力してください"
                        required
                      />
                    </label>
                    <label>
                      以前のパスワード
                      <input
                        type="password"
                        value={resetPrevPassword}
                        onChange={(event) => setResetPrevPassword(event.target.value)}
                        placeholder="以前のパスワードを入力してください"
                        required
                      />
                    </label>
                    <label>
                      新しいパスワード
                      <input
                        type="password"
                        value={resetNextPassword}
                        onChange={(event) => setResetNextPassword(event.target.value)}
                        placeholder="新しいパスワードを入力してください"
                        required
                      />
                    </label>
                    <button type="submit" className="primaryButton loginResetSubmit">
                      確認
                    </button>
                  </form>
                </div>
              </div>
            ) : null}
          </div>
        ) : (
          <>
            <div className="sessionTopRight">
              <span className="sessionUserChip" title="現在ログイン中のアカウント">
                {loggedInAccountLabel}
              </span>
              <button type="button" className="secondaryButton logoutTopRight" onClick={handleLogout}>
                ログアウト
              </button>
            </div>
            <div className="cardHeader">
              <div />
            </div>
            <div className="pageTabs pageTabsMain">
              {MAIN_WORKSPACE_TAB_ORDER.filter((t) => isWorkspaceMenuVisible(t.key)).map((t) => (
                <button
                  key={t.key}
                  type="button"
                  className={`tabButton tabButtonMain ${workspaceView === t.key ? 'isActive' : ''}`}
                  onClick={() => setWorkspaceView(t.key)}
                >
                  <span className="tabButtonMainIcon" aria-hidden>
                    {MAIN_WORKSPACE_TAB_ICONS[t.key] ?? '•'}
                  </span>
                  <span className="tabButtonMainLabel">{t.label}</span>
                </button>
              ))}
            </div>

            <div style={{ display: workspaceView === 'gyoseki' ? 'block' : 'none' }}>
              <div className="pageTabs pageTabsSub">
              <button
                type="button"
                className={`tabButton ${activePage === 'input' ? 'isActive' : ''}`}
                onClick={() => setActivePage('input')}
              >
                入力ページ
              </button>
              <button
                type="button"
                className={`tabButton ${activePage === 'calc' ? 'isActive' : ''}`}
                onClick={() => setActivePage('calc')}
              >
                自動計算ページ
              </button>
            </div>

            {activePage === 'input' ? (
              <>
                <div className="actionRow">
                  <div className="sortControls">
                    <label className="sortLabel">
                      並び替え
                      <select value={sortKey} onChange={(event) => setSortKey(event.target.value)}>
                        <option value="employeeNo">社員番号</option>
                        <option value="employeeName">社員名</option>
                        <option value="team">区分</option>
                        <option value="grade">等級</option>
                        <option value="score">評価スコア</option>
                        <option value="performanceAllowance">業績手当</option>
                        <option value="thirdBonus">第3回目賞与</option>
                      </select>
                    </label>
                    <button
                      type="button"
                      className="secondaryButton"
                      onClick={() => setSortOrder((prev) => (prev === 'asc' ? 'desc' : 'asc'))}
                    >
                      {sortOrder === 'asc' ? '昇順' : '降順'}
                    </button>
                  </div>
                  <button type="button" className="primaryButton" onClick={addRow}>
                    + 社員行を追加
                  </button>
                  <label className="csvImportButton">
                    CSVインポート
                    <input type="file" accept=".csv" onChange={handleImportCsv} />
                  </label>
                  <button type="button" className="csvExportButton" onClick={handleExportCsv}>
                    CSVエクスポート
                  </button>
                  <button
                    type="button"
                    className="csvMailButton"
                    onClick={() => {
                      const csvContent = buildCsvContent()
                      downloadCsvFile(csvContent)
                      const subject = encodeURIComponent('業績手当CSV送付')
                      const body = encodeURIComponent(
                        'CSVを作成しました。ダウンロードしたファイルを添付して送信してください。',
                      )
                      window.location.href = `mailto:keisuke.newcera@gmail.com?subject=${subject}&body=${body}`
                    }}
                  >
                    CSVをメール送信
                  </button>
                </div>
                <p className="syncMessage">{syncMessage}</p>
                {syncError ? (
                  <div className="syncErrorBanner" role="alert">
                    <p>{syncError}</p>
                    <button type="button" className="syncRetryButton" onClick={handleRetryCloudSync}>
                      再試行
                    </button>
                  </div>
                ) : null}
                {csvMessage ? <p className="csvMessage">{csvMessage}</p> : null}

                <div className="tableWrap">
                  <table className="allowanceTable">
                    <colgroup>
                      <col className="colPhoto" />
                      <col className="colEmployeeInfo" />
                      <col className="colAllowanceInfo" />
                      <col className="colAction" />
                    </colgroup>
                    <thead>
                      <tr>
                        <th>顔写真 / 評価スコア</th>
                        <th>社員情報</th>
                        <th>手当情報</th>
                        <th>操作</th>
                      </tr>
                    </thead>
                    <tbody>
                      {sortedRows.map((row) => (
                        <tr key={row.id} className={getGradeRowClass(row.grade)}>
                          <td>
                            <div className="photoCell">
                              <label className="photoUploadArea">
                                {row.photoDataUrl ? (
                                  <img src={row.photoDataUrl} alt="社員顔写真" className="photoThumb" />
                                ) : (
                                  <div className="photoPlaceholder">未登録</div>
                                )}
                                <input
                                  type="file"
                                  accept="image/*"
                                  onChange={(event) => {
                                    const file = event.target.files?.[0]
                                    handlePhotoUpload(row.id, file)
                                    event.target.value = ''
                                  }}
                                />
                              </label>
                              <label className="scoreUnderPhoto">
                                スコア
                                <input
                                  type="text"
                                  inputMode="numeric"
                                  value={row.score}
                                  onChange={(event) =>
                                    updateRow(
                                      row.id,
                                      'score',
                                      sanitizeDecimalInput(event.target.value),
                                    )
                                  }
                                />
                              </label>
                              <label className="noteUnderPhoto">
                                備考
                                <input
                                  type="text"
                                  value={row.note}
                                  onChange={(event) => updateRow(row.id, 'note', event.target.value)}
                                  placeholder="備考"
                                />
                              </label>
                            </div>
                          </td>
                          <td>
                            <div className="employeeInfoCell">
                              <label>
                                社員番号
                                <input
                                  type="text"
                                  value={row.employeeNo}
                                  onChange={(event) => updateRow(row.id, 'employeeNo', event.target.value)}
                                  placeholder="1001"
                                />
                              </label>
                              <label>
                                社員名
                                <input
                                  type="text"
                                  value={row.employeeName}
                                  onChange={(event) => updateRow(row.id, 'employeeName', event.target.value)}
                                  placeholder="山田 太郎"
                                />
                              </label>
                              <label>
                                区分
                                <select
                                  value={row.team ?? 'denture'}
                                  onChange={(event) => updateRow(row.id, 'team', event.target.value)}
                                >
                                  <option value="denture">デンチャー</option>
                                  <option value="ck">CK</option>
                                </select>
                              </label>
                              <label>
                                等級
                                <select
                                  value={row.grade}
                                  onChange={(event) => updateRow(row.id, 'grade', event.target.value)}
                                >
                                  <option value="G1">G1</option>
                                  <option value="G2">G2</option>
                                  <option value="G3">G3</option>
                                  <option value="G4">G4</option>
                                  <option value="G5">G5</option>
                                  <option value="G6">G6</option>
                                  <option value="P3">P3</option>
                                  <option value="G1J">G1準社員</option>
                                  <option value="G2J">G2準社員</option>
                                  <option value="G3J">G3準社員</option>
                                  <option value="G4J">G4準社員</option>
                                  <option value="G5J">G5準社員</option>
                                  <option value="G6J">G6準社員</option>
                                </select>
                              </label>
                            </div>
                          </td>
                          <td>
                            <div className="allowanceInfoCell">
                              <div className="allowanceRow">
                                <span>業績手当</span>
                                <strong className="moneyCell">{formatJPY(row.performanceAllowance)}</strong>
                              </div>
                              <div className="allowanceRow">
                                <span>特別手当</span>
                                <input
                                  type="text"
                                  inputMode="numeric"
                                  value={row.specialAllowance}
                                  onChange={(event) =>
                                    updateRow(
                                      row.id,
                                      'specialAllowance',
                                      sanitizeIntegerInput(event.target.value),
                                    )
                                  }
                                />
                              </div>
                              <div className="allowanceRow">
                                <span>第3回目賞与</span>
                                <strong className="moneyCell">{formatJPY(row.thirdBonus)}</strong>
                              </div>
                            </div>
                          </td>
                          <td>
                            <button
                              type="button"
                              className="dangerButton"
                              onClick={() => removeRow(row.id)}
                              disabled={computedRows.length === 1}
                              aria-label="この行を削除"
                            >
                              ×
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            ) : (
              <div className="calcPage">
                <div className="snapshotBar">
                  <label>
                    対象年月
                    <input
                      type="month"
                      value={snapshotPeriod}
                      onChange={(event) => setSnapshotPeriod(event.target.value)}
                    />
                  </label>
                  <button type="button" className="primaryButton" onClick={handleSaveSnapshot}>
                    確定保存
                  </button>
                  <label>
                    履歴読込
                    <select
                      value=""
                      onChange={(event) => {
                        if (event.target.value) handleLoadSnapshot(event.target.value)
                      }}
                    >
                      <option value="">年月を選択</option>
                      {snapshotHistory.map((item) => (
                        <option key={item.period} value={item.period}>
                          {item.period}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
                {snapshotMessage ? <p className="snapshotMessage">{snapshotMessage}</p> : null}
                <div className="targetPanel">
                  <div className="targetFields">
                    <label className="targetLabel">
                      部門売上(デンチャー)
                      <input
                        type="text"
                        inputMode="numeric"
                        value={
                          departmentSalesDenture === '' ? '' : formatJPY(Number(departmentSalesDenture))
                        }
                        onChange={(event) =>
                          setDepartmentSalesDenture(
                            sanitizeIntegerInput(event.target.value),
                          )
                        }
                        placeholder="売上を入力"
                      />
                    </label>
                    <label className="targetLabel">
                      部門売上(CK)
                      <input
                        type="text"
                        inputMode="numeric"
                        value={departmentSalesCk === '' ? '' : formatJPY(Number(departmentSalesCk))}
                        onChange={(event) =>
                          setDepartmentSalesCk(
                            sanitizeIntegerInput(event.target.value),
                          )
                        }
                        placeholder="売上を入力"
                      />
                    </label>
                    <label className="targetLabel">
                      業績手当率(デンチャー %)
                      <input
                        type="text"
                        inputMode="numeric"
                        value={performanceRatePercentDenture}
                        onChange={(event) =>
                          setPerformanceRatePercentDenture(
                            sanitizePercentInput(event.target.value),
                          )
                        }
                        placeholder="例: 2.8"
                      />
                    </label>
                    <label className="targetLabel">
                      業績手当率(CK %)
                      <input
                        type="text"
                        inputMode="numeric"
                        value={performanceRatePercentCk}
                        onChange={(event) =>
                          setPerformanceRatePercentCk(
                            sanitizePercentInput(event.target.value),
                          )
                        }
                        placeholder="例: 2.8"
                      />
                    </label>
                    <label className="targetLabel">
                      業績手当総額(デンチャー)
                      <input type="text" value={formatJPY(targetTotalDentureValue)} readOnly />
                    </label>
                    <label className="targetLabel">
                      業績手当総額(CK)
                      <input type="text" value={formatJPY(targetTotalCkValue)} readOnly />
                    </label>
                    <label className="targetLabel">
                      業績手当総額(合計)
                      <input type="text" value={formatJPY(targetTotalValue)} readOnly />
                    </label>
                    <label className="targetLabel">
                      特別賞与総額(デンチャー)
                      <input
                        type="text"
                        inputMode="numeric"
                        value={targetSpecialDentureTotal === '' ? '' : formatJPY(Number(targetSpecialDentureTotal))}
                        onChange={(event) =>
                          setTargetSpecialDentureTotal(
                            sanitizeIntegerInput(event.target.value),
                          )
                        }
                        placeholder="総額を入力"
                      />
                    </label>
                    <label className="targetLabel">
                      特別賞与総額(CK)
                      <input
                        type="text"
                        inputMode="numeric"
                        value={targetSpecialCkTotal === '' ? '' : formatJPY(Number(targetSpecialCkTotal))}
                        onChange={(event) =>
                          setTargetSpecialCkTotal(
                            sanitizeIntegerInput(event.target.value),
                          )
                        }
                        placeholder="総額を入力"
                      />
                    </label>
                    <label className="targetLabel">
                      特別賞与総額(合計)
                      <input type="text" value={formatJPY(targetSpecialTotalValue)} readOnly />
                    </label>
                  </div>
                </div>
                <p className="targetBreakdown">
                  業績手当差額: デンチャー {formatJPY(Math.abs(denturePerformanceGap))}
                  {denturePerformanceGap > 0 ? ' 不足' : denturePerformanceGap < 0 ? ' 超過' : ' 一致'} / CK{' '}
                  {formatJPY(Math.abs(ckPerformanceGap))}
                  {ckPerformanceGap > 0 ? ' 不足' : ckPerformanceGap < 0 ? ' 超過' : ' 一致'}
                </p>
                <p className="targetBreakdown">
                  内訳差額: デンチャー {formatJPY(Math.abs(dentureGap))}
                  {dentureGap > 0 ? ' 不足' : dentureGap < 0 ? ' 超過' : ' 一致'} / CK{' '}
                  {formatJPY(Math.abs(ckGap))}
                  {ckGap > 0 ? ' 不足' : ckGap < 0 ? ' 超過' : ' 一致'}
                </p>
                <p className={`targetGap ${totalGap < 0 ? 'isOver' : ''}`}>
                  業績手当差額: {formatJPY(Math.abs(totalGap))}
                  {totalGap > 0 ? ' 不足' : totalGap < 0 ? ' 超過' : ' 一致'}
                </p>
                <p className={`targetGap ${specialTotalGap < 0 ? 'isOver' : ''}`}>
                  第3回目賞与差額: {formatJPY(Math.abs(specialTotalGap))}
                  {specialTotalGap > 0
                    ? ' 不足'
                    : specialTotalGap < 0
                      ? ' 超過'
                      : ' 一致'}
                </p>

                <div className="result">
                  <div className="resultRow">
                    <span>業績手当 合計</span>
                    <strong>{formatJPY(totals.performanceAllowance)}</strong>
                  </div>
                  <div className="resultRow">
                    <span>特別手当 合計</span>
                    <strong>{formatJPY(totals.specialAllowance)}</strong>
                  </div>
                  <div className="resultRow total">
                    <span>第3回目賞与 合計</span>
                    <strong>{formatJPY(totals.thirdBonus)}</strong>
                  </div>
                </div>

                <p className="formula">
                  計算式: 業績手当 = (個人のスコア×等級係数) ÷ 各区分の(スコア×係数合計) × 区分別業績手当総額,
                  第3回目賞与 = (個人のスコア×等級係数) ÷ 各区分の(スコア×係数合計) × 区分別特別賞与総額
                </p>
              </div>
            )}
            </div>
            {workspaceView === 'admin' ? (
              <AdminMockPage
                directoryRows={employeeDirectoryRows}
                skills={skillSettings}
                skillProgress={skillEmployeeProgress}
                skillProgressUpdatedAtByEmployee={skillProgressUpdatedAtByEmployee}
                selfEvalByEmployee={selfEvalByEmployee}
                supervisorEvalByEmployee={supervisorEvalByEmployee}
                executiveEvalByEmployee={executiveEvalByEmployee}
                goalsByEmployee={goalsByEmployee}
                forcedSelectedMemberId={adminSelectedMemberId}
                forcedDetailTab={adminDetailTab}
                onSelectMember={(employeeId) => setAdminSelectedMemberId(employeeId)}
                onChangeDetailTab={(tabId) => setAdminDetailTab(tabId)}
                onStartSupervisorEval={(employeeId) => {
                  setAdminSelectedMemberId(employeeId)
                  setAdminDetailTab('boss')
                  setSelectedEvalEmployeeId(employeeId)
                  setWorkspaceView('bossEval')
                }}
                onStartExecutiveEval={(employeeId) => {
                  if (menuRoleKey !== MENU_ROLE_ADMIN) {
                    window.alert('権限がありません。')
                    return
                  }
                  setAdminSelectedMemberId(employeeId)
                  setSelectedEvalEmployeeId(employeeId)
                  setWorkspaceView('execEval')
                }}
              />
            ) : null}
            {workspaceView === 'employee' ? (
              <EmployeeManagePage
                rows={employeeDirectoryRows}
                setRows={setEmployeeDirectoryRows}
                skills={skillSettings}
                skillProgress={skillEmployeeProgress}
                selfEvalByEmployee={selfEvalByEmployee}
                supervisorEvalByEmployee={supervisorEvalByEmployee}
                executiveEvalByEmployee={executiveEvalByEmployee}
              />
            ) : null}
            {workspaceView === 'settings' ? (
              <section className="settingsHub">
                <nav className="settingsHubTabs" aria-label="設定機能の切り替え">
                  <button
                    type="button"
                    className={`settingsHubTab ${settingsTab === 'skill' ? 'isActive' : ''}`}
                    onClick={() => setSettingsTab('skill')}
                  >
                    スキル設定
                  </button>
                  <button
                    type="button"
                    className={`settingsHubTab ${settingsTab === 'evalcriteria' ? 'isActive' : ''}`}
                    onClick={() => setSettingsTab('evalcriteria')}
                  >
                    評価基準設定
                  </button>
                  <button
                    type="button"
                    className={`settingsHubTab ${settingsTab === 'menusettings' ? 'isActive' : ''}`}
                    onClick={() => setSettingsTab('menusettings')}
                  >
                    表示設定
                  </button>
                </nav>
                {settingsTab === 'skill' ? (
                  <SkillSettingsPage
                    skills={skillSettings}
                    setSkills={setSkillSettings}
                    sections={skillSections}
                    setSections={setSkillSections}
                    grades={skillGrades}
                    setGrades={setSkillGrades}
                    activeGradeId={skillActiveGradeId}
                    setActiveGradeId={setSkillActiveGradeId}
                  />
                ) : null}
                {settingsTab === 'evalcriteria' ? (
                  <EvaluationCriteriaPage grades={skillGrades} criteria={evaluationCriteria} setCriteria={setEvaluationCriteria} />
                ) : null}
                {settingsTab === 'menusettings' ? (
                  <MenuDisplaySettingsPage menuVisibilityByRole={menuVisibilityByRole} setMenuVisibilityByRole={setMenuVisibilityByRole} />
                ) : null}
              </section>
            ) : null}
            {workspaceView === 'skillup' ? (
              <SkillUpPage
                employees={loggedInEmployee ? [loggedInEmployee] : employeeDirectoryRows}
                skills={skillSettings}
                sections={skillSections}
                progress={skillEmployeeProgress}
              />
            ) : null}
            {workspaceView === 'selfeval' ? (
              <SelfEvaluationPage
                employees={evalSubjectEmployee ? [evalSubjectEmployee] : []}
                evalState={evalSubjectEmployee ? selfEvalByEmployee[evalSubjectEmployee.id] : undefined}
                setEvalState={updateSelfEvalForSubject}
              />
            ) : null}
            {workspaceView === 'goals' ? (
              <GoalManagementPage employee={goalMgmtEmployee} goals={goalMgmtGoals} setGoals={setGoalMgmtGoals} />
            ) : null}
            
            {workspaceView === 'bossEval' ? (
              <SupervisorEvaluationPage
                employees={employeeDirectoryRows}
                evalState={evalSubjectEmployee ? supervisorEvalByEmployee[evalSubjectEmployee.id] : undefined}
                setEvalState={updateSupervisorEvalForSubject}
                peerSelfEval={evalSubjectEmployee ? selfEvalByEmployee[evalSubjectEmployee.id] : undefined}
              />
            ) : null}
            {workspaceView === 'execEval' ? (
              <ExecutiveEvaluationPage
                employee={evalSubjectEmployee}
                evalState={evalSubjectEmployee ? executiveEvalByEmployee[evalSubjectEmployee.id] : undefined}
                setEvalState={updateExecutiveEvalForSubject}
              />
            ) : null}
          </>
        )}
      </section>
    </main>
  )
}

function StubWorkspacePage({ title, description }) {
  return (
    <section className="stubWorkspacePage">
      <h2>{title}</h2>
      <p>{description}</p>
    </section>
  )
}

const MENU_DISPLAY_ROLE_CARDS = [
  { key: MENU_ROLE_IPPAN, badge: '一般', title: '一般従業員', cardClass: 'menuDispCardIppan' },
  { key: MENU_ROLE_JOUSHI, badge: '上司', title: '上司', cardClass: 'menuDispCardJoushi' },
  { key: MENU_ROLE_ADMIN, badge: '管理', title: '管理者', cardClass: 'menuDispCardAdmin' },
]

function MenuDisplaySettingsPage({ menuVisibilityByRole, setMenuVisibilityByRole }) {
  const toggleKey = (role, itemKey) => {
    if (role === MENU_ROLE_ADMIN && itemKey === 'menusettings') return
    setMenuVisibilityByRole((prev) => {
      const cur = [...(prev[role] ?? [])]
      const has = cur.includes(itemKey)
      const next = has ? cur.filter((k) => k !== itemKey) : [...cur, itemKey]
      return { ...prev, [role]: next }
    })
  }

  const resetDefaults = () => {
    if (!window.confirm('すべての役割のメニュー表示を初期設定に戻しますか？')) return
    setMenuVisibilityByRole(normalizeMenuVisibilityByRole(null))
  }

  return (
    <section className="menuDispPage">
      <header className="menuDispHeader">
        <h2>メニュー表示設定</h2>
        <p className="menuDispLead">各役割で表示するメニュー項目を設定します</p>
      </header>

      <div className="menuDispGuide">
        <p className="menuDispGuideTitle">
          <span className="menuDispGuideIcon" aria-hidden>
            ⓘ
          </span>
          使い方
        </p>
        <p className="menuDispGuideBody">
          各役割のカードで、表示したいメニューにチェックを入れてください。変更内容は自動で保存されます。
        </p>
      </div>

      <div className="menuDispGrid">
        {MENU_DISPLAY_ROLE_CARDS.map((card) => {
          const keys = MENU_KEYS_BY_ROLE_CARD[card.key]
          const checked = menuVisibilityByRole[card.key] ?? []
          return (
            <article key={card.key} className={`menuDispCard ${card.cardClass}`}>
              <div className="menuDispCardHead">
                <span className="menuDispBadge">{card.badge}</span>
                <div>
                  <h3 className="menuDispCardTitle">{card.title}</h3>
                  <p className="menuDispCardCount">{checked.length} 項目表示中</p>
                </div>
              </div>
              <ul className="menuDispItemList">
                {keys.map((itemKey) => {
                  const meta = MENU_DISPLAY_META[itemKey]
                  const lockAdminMenuTab = card.key === MENU_ROLE_ADMIN && itemKey === 'menusettings'
                  const isOn = checked.includes(itemKey) || lockAdminMenuTab
                  return (
                    <li key={itemKey} className="menuDispItem">
                      <label className={`menuDispCheckLabel${lockAdminMenuTab ? ' isLocked' : ''}`}>
                        <input
                          type="checkbox"
                          checked={isOn}
                          disabled={lockAdminMenuTab}
                          onChange={() => toggleKey(card.key, itemKey)}
                        />
                        <span className="menuDispItemText">
                          <span className="menuDispItemTitle">{meta.tabLabel}</span>
                          <span className="menuDispItemDesc">{meta.description}</span>
                        </span>
                      </label>
                    </li>
                  )
                })}
              </ul>
            </article>
          )
        })}
      </div>

      <div className="menuDispFooter">
        <button type="button" className="menuDispBtnReset" onClick={resetDefaults}>
          デフォルトに戻す
        </button>
      </div>
    </section>
  )
}

function EvaluationCriteriaPage({ grades, criteria, setCriteria }) {
  const firstGradeId = grades[0]?.id ?? 'G1'
  const [activeGradeId, setActiveGradeId] = useState(firstGradeId)
  const [openMajors, setOpenMajors] = useState({})
  const [majorModal, setMajorModal] = useState(null)
  const [majorDraftTitle, setMajorDraftTitle] = useState('')
  const [minorModal, setMinorModal] = useState(null)
  const [minorDraft, setMinorDraft] = useState({
    title: '',
    weightPct: 20,
    scores: ['', '', '', '', ''],
  })

  useEffect(() => {
    if (!grades.some((g) => g.id === activeGradeId)) {
      setActiveGradeId(grades[0]?.id ?? 'G1')
    }
  }, [grades, activeGradeId])

  const majors = criteria[activeGradeId] ?? []

  const updateMajors = (updater) => {
    setCriteria((prev) => ({
      ...prev,
      [activeGradeId]: typeof updater === 'function' ? updater(prev[activeGradeId] ?? []) : updater,
    }))
  }

  const openAddMajor = () => {
    setMajorModal({ mode: 'add' })
    setMajorDraftTitle('')
  }

  const openEditMajor = (major) => {
    setMajorModal({ mode: 'edit', majorId: major.id })
    setMajorDraftTitle(major.title)
  }

  const closeMajorModal = () => setMajorModal(null)

  const saveMajorModal = () => {
    const t = majorDraftTitle.trim()
    if (!t) {
      window.alert('大項目名を入力してください。')
      return
    }
    if (majorModal.mode === 'add') {
      updateMajors((prev) => [...prev, { id: newEvaluationId('maj'), title: t, minors: [] }])
    } else {
      updateMajors((prev) => prev.map((m) => (m.id === majorModal.majorId ? { ...m, title: t } : m)))
    }
    closeMajorModal()
  }

  const deleteMajor = (majorId) => {
    if (!window.confirm('この大項目と配下の小項目をすべて削除しますか？')) return
    updateMajors((prev) => prev.filter((m) => m.id !== majorId))
    setOpenMajors((prev) => {
      const next = { ...prev }
      delete next[majorId]
      return next
    })
  }

  const openAddMinor = (majorId) => {
    setMinorModal({ mode: 'add', majorId })
    setMinorDraft({ title: '', weightPct: 20, scores: ['', '', '', '', ''] })
  }

  const openEditMinor = (majorId, minor) => {
    setMinorModal({ mode: 'edit', majorId, minorId: minor.id })
    setMinorDraft({
      title: minor.title,
      weightPct: minor.weightPct ?? 0,
      scores: [...(minor.scoreCriteria ?? []), '', '', '', '', ''].slice(0, 5),
    })
  }

  const closeMinorModal = () => setMinorModal(null)

  const saveMinorModal = () => {
    const t = minorDraft.title.trim()
    if (!t) {
      window.alert('小項目名を入力してください。')
      return
    }
    const scores = minorDraft.scores.map((s) => String(s ?? '').trim())
    if (scores.some((s) => !s)) {
      window.alert('評価基準（1～5点）のすべての欄に入力してください。')
      return
    }
    const weightPct = Math.min(100, Math.max(0, Number(minorDraft.weightPct === '' ? 0 : minorDraft.weightPct) || 0))
    if (minorModal.mode === 'add') {
      updateMajors((prev) =>
        prev.map((m) => {
          if (m.id !== minorModal.majorId) return m
          return {
            ...m,
            minors: [...m.minors, { id: newEvaluationId('min'), title: t, weightPct, scoreCriteria: scores }],
          }
        }),
      )
    } else {
      updateMajors((prev) =>
        prev.map((m) => {
          if (m.id !== minorModal.majorId) return m
          return {
            ...m,
            minors: m.minors.map((mi) =>
              mi.id === minorModal.minorId ? { ...mi, title: t, weightPct, scoreCriteria: scores } : mi,
            ),
          }
        }),
      )
    }
    closeMinorModal()
  }

  const deleteMinor = (majorId, minorId) => {
    if (!window.confirm('この小項目を削除しますか？')) return
    updateMajors((prev) =>
      prev.map((m) => {
        if (m.id !== majorId) return m
        return { ...m, minors: m.minors.filter((mi) => mi.id !== minorId) }
      }),
    )
  }

  const toggleMajorOpen = (majorId) => {
    setOpenMajors((prev) => ({ ...prev, [majorId]: !prev[majorId] }))
  }

  return (
    <section className="evalCritPage">
      <header className="evalCritHeader">
        <h2>評価基準設定</h2>
        <p className="evalCritLead">等級別の評価項目と基準を設定します</p>
      </header>

      <div className="evalCritToolbar">
        <label className="evalCritGradeSelect">
          等級選択
          <select value={activeGradeId} onChange={(event) => setActiveGradeId(event.target.value)}>
            {grades.map((g) => (
              <option key={g.id} value={g.id}>
                {g.label ?? g.id}
              </option>
            ))}
          </select>
        </label>
        <button type="button" className="evalCritAddMajorBtn" onClick={openAddMajor}>
          + 大項目を追加
        </button>
      </div>

      <div className="evalCritBoard">
        {majors.length === 0 ? (
          <p className="evalCritEmpty">この等級にはまだ大項目がありません。「+ 大項目を追加」から追加してください。</p>
        ) : (
          <div className="evalCritMajorList">
            {majors.map((maj) => {
              const open = !!openMajors[maj.id]
              return (
                <article key={maj.id} className="evalCritMajorCard">
                  <button type="button" className="evalCritMajorHead" onClick={() => toggleMajorOpen(maj.id)} aria-expanded={open}>
                    <span className="evalCritChevron" aria-hidden>
                      {open ? '▼' : '▶'}
                    </span>
                    <span className="evalCritMajorTitle">
                      {maj.title}
                      <span className="evalCritMajorCount">（{maj.minors.length}項目）</span>
                    </span>
                  </button>
                  {open ? (
                    <div className="evalCritMajorBody">
                      {maj.minors.length === 0 ? (
                        <p className="evalCritMinorEmpty">小項目がありません。</p>
                      ) : (
                        <ul className="evalCritMinorList">
                          {maj.minors.map((mi) => (
                            <li key={mi.id} className="evalCritMinorRow">
                              <span className="evalCritMinorTitle">{mi.title}</span>
                              <span className="evalCritMinorWeight">ウェイト: {mi.weightPct}%</span>
                              <div className="evalCritMinorActions">
                                <button type="button" className="evalCritMiniBtn" onClick={() => openEditMinor(maj.id, mi)}>
                                  編集
                                </button>
                                <button type="button" className="evalCritMiniBtn danger" onClick={() => deleteMinor(maj.id, mi.id)}>
                                  削除
                                </button>
                              </div>
                            </li>
                          ))}
                        </ul>
                      )}
                      <div className="evalCritMajorFoot">
                        <button type="button" className="evalCritAddMinorBtn" onClick={() => openAddMinor(maj.id)}>
                          + 小項目追加
                        </button>
                        <button type="button" className="evalCritIconTool evalCritIconEdit" onClick={() => openEditMajor(maj)} title="大項目を編集">
                          ✎
                        </button>
                        <button
                          type="button"
                          className="evalCritIconTool evalCritIconDel"
                          onClick={() => deleteMajor(maj.id)}
                          title="大項目を削除"
                        >
                          🗑
                        </button>
                      </div>
                    </div>
                  ) : null}
                </article>
              )
            })}
          </div>
        )}
      </div>

      {majorModal ? (
        <div className="employeeModalOverlay" onClick={closeMajorModal}>
          <div className="employeeModal evalCritModal evalCritModalSm" onClick={(event) => event.stopPropagation()}>
            <button type="button" className="modalClose" onClick={closeMajorModal}>
              ×
            </button>
            <h3>{majorModal.mode === 'add' ? '大項目を追加' : '大項目を編集'}</h3>
            <p className="evalCritModalSub">評価カテゴリの大項目を設定します。</p>
            <label className="evalCritFormLabel">
              大項目名
              <input
                type="text"
                value={majorDraftTitle}
                onChange={(event) => setMajorDraftTitle(event.target.value)}
                placeholder="例：業務遂行能力"
              />
            </label>
            <div className="evalCritModalFooter">
              <button type="button" className="evalCritBtnGhost" onClick={closeMajorModal}>
                キャンセル
              </button>
              <button type="button" className="evalCritBtnPrimary" onClick={saveMajorModal}>
                保存
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {minorModal ? (
        <div className="employeeModalOverlay" onClick={closeMinorModal}>
          <div className="employeeModal evalCritModal evalCritModalLg" onClick={(event) => event.stopPropagation()}>
            <button type="button" className="modalClose" onClick={closeMinorModal}>
              ×
            </button>
            <h3>{minorModal.mode === 'add' ? '小項目を追加' : '小項目を編集'}</h3>
            <p className="evalCritModalSub">評価項目の詳細と評価基準を設定します。</p>
            <div className="evalCritFormStack">
              <label className="evalCritFormLabel">
                小項目名 <span className="evalCritReq">*</span>
                <input
                  type="text"
                  value={minorDraft.title}
                  onChange={(event) => setMinorDraft((d) => ({ ...d, title: event.target.value }))}
                  placeholder="例：日常業務について自己完結できる計画を立てられる"
                />
              </label>
              <label className="evalCritFormLabel">
                ウエイト（%） <span className="evalCritReq">*</span>
                <input
                  type="number"
                  min={0}
                  max={100}
                  value={minorDraft.weightPct === '' ? '' : minorDraft.weightPct}
                  onChange={(event) =>
                    setMinorDraft((d) => ({
                      ...d,
                      weightPct: event.target.value === '' ? '' : Number(event.target.value),
                    }))
                  }
                />
              </label>
              <div className="evalCritScoreBlock">
                <p className="evalCritScoreBlockTitle">
                  評価基準（1～5点） <span className="evalCritReq">*</span>
                </p>
                <div className="evalCritScoreGrid">
                  {[1, 2, 3, 4, 5].map((pt, idx) => (
                    <label key={pt} className="evalCritScoreCol">
                      <span className="evalCritScorePt">{pt}点</span>
                      <input
                        type="text"
                        value={minorDraft.scores[idx] ?? ''}
                        onChange={(event) =>
                          setMinorDraft((d) => {
                            const scores = [...d.scores]
                            scores[idx] = event.target.value
                            return { ...d, scores }
                          })
                        }
                        placeholder={`${pt}点の基準`}
                      />
                    </label>
                  ))}
                </div>
              </div>
            </div>
            <div className="evalCritModalFooter">
              <button type="button" className="evalCritBtnGhost" onClick={closeMinorModal}>
                キャンセル
              </button>
              <button type="button" className="evalCritBtnPrimary" onClick={saveMinorModal}>
                保存
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  )
}

function SkillUpPage({ employees, skills, sections, progress }) {
  const [skillListFilter, setSkillListFilter] = useState('all')
  const [criteriaModalSkill, setCriteriaModalSkill] = useState(null)

  const employee = useMemo(() => (employees.length ? employees[0] : null), [employees])

  const grade = useMemo(() => {
    if (!employee) return 'G1'
    const g = String(employee.grade ?? 'G1').trim()
    return /^G[1-6]$/.test(g) ? g : 'G1'
  }, [employee])

  const empProg = useMemo(() => (employee ? progress[employee.id] ?? {} : {}), [employee, progress])

  const gradeSkills = useMemo(() => skills.filter((s) => s.gradeId === grade), [skills, grade])

  const stars = useMemo(() => {
    if (!employee) return 0
    return calcEmployeeSkillStars(skills, empProg)
  }, [employee, skills, empProg])

  const acquiredCount = useMemo(
    () => gradeSkills.filter((s) => (empProg[s.id] ?? 0) > 0).length,
    [gradeSkills, empProg],
  )

  const filteredSkills = useMemo(() => {
    if (skillListFilter === 'all') return gradeSkills
    if (skillListFilter === 'required') return gradeSkills.filter((s) => s.required)
    return gradeSkills.filter((s) => s.sectionId === skillListFilter)
  }, [gradeSkills, skillListFilter])

  const sectionLabel = (id) => sections.find((x) => x.id === id)?.label ?? id

  const joinDisplay =
    employee?.joinDate && String(employee.joinDate).trim()
      ? new Date(`${String(employee.joinDate).trim()}T12:00:00`).toLocaleDateString('ja-JP')
      : '―'

  if (!employee) {
    return (
      <section className="skillUpPage">
        <p className="skillUpEmpty">従業員が登録されていません。従業員管理から登録してください。</p>
      </section>
    )
  }

  return (
    <section className="skillUpPage">
      <header className="skillUpPageHeader">
        <div>
          <h2>スキルアップ</h2>
          <p className="skillUpLead">等級に応じたスキル習得状況を確認できます。</p>
        </div>
      </header>

      <div className="skillUpTopGrid">
        <article className="skillUpProfileCard">
          <h3>{employee.name}</h3>
          <span className="skillUpDeptBadge">{employee.dept}</span>
          <p className="skillUpJoin">入社日: {joinDisplay}</p>
          <div className="skillUpInlineStats">
            <div className="skillUpInlineStat">
              <span className="skillUpInlineStatLabel">等級</span>
              <strong className="skillUpInlineStatValue">{grade}</strong>
            </div>
            <div className="skillUpInlineStat">
              <span className="skillUpInlineStatLabel">獲得★</span>
              <strong className="skillUpInlineStatValue">{stars}</strong>
            </div>
            <div className="skillUpInlineStat">
              <span className="skillUpInlineStatLabel">習得</span>
              <strong className="skillUpInlineStatValue">{acquiredCount}</strong>
            </div>
          </div>
        </article>
      </div>

      <nav className="skillUpFilterTabs" aria-label="スキル表示の絞り込み">
        <button
          type="button"
          className={`skillUpFilterTab ${skillListFilter === 'all' ? 'isActive' : ''}`}
          onClick={() => setSkillListFilter('all')}
        >
          全て
        </button>
        <button
          type="button"
          className={`skillUpFilterTab ${skillListFilter === 'required' ? 'isActive' : ''}`}
          onClick={() => setSkillListFilter('required')}
        >
          必須
        </button>
        {sections.map((sec) => (
          <button
            key={sec.id}
            type="button"
            className={`skillUpFilterTab ${skillListFilter === sec.id ? 'isActive' : ''}`}
            onClick={() => setSkillListFilter(sec.id)}
          >
            {sec.label}
          </button>
        ))}
      </nav>

      <div className="skillUpSkillCards">
        {filteredSkills.length === 0 ? (
          <p className="skillUpEmpty">該当するスキルがありません。</p>
        ) : (
          filteredSkills.map((s) => {
            const cur = empProg[s.id] ?? 0
            const max = s.stages || 1
            const barPct = max > 0 ? Math.min(100, Math.round((cur / max) * 100)) : 0
            return (
              <article key={s.id} className="skillUpSkillCard">
                <div className="skillUpSkillCardHead">
                  <h4>{s.title}</h4>
                  <button
                    type="button"
                    className="skillUpInfoIcon"
                    aria-label={`${s.title}のレベル別達成基準を表示`}
                    title="レベル別達成基準"
                    onClick={() => setCriteriaModalSkill(s)}
                  >
                    i
                  </button>
                </div>
                <div className="skillUpSkillTags">
                  {s.required ? <span className="skillUpTag skillUpTagReq">必須</span> : null}
                  <span className="skillUpTag skillUpTagSec">{sectionLabel(s.sectionId)}</span>
                </div>
                <p className="skillUpSkillProgressText">
                  進捗: Lv.{cur}/{max}
                </p>
                <div className="skillUpSkillBarTrack">
                  <div className="skillUpSkillBarFill" style={{ width: `${barPct}%` }} />
                </div>
              </article>
            )
          })
        )}
      </div>

      {criteriaModalSkill ? (
        <div className="employeeModalOverlay" onClick={() => setCriteriaModalSkill(null)}>
          <div className="employeeModal skillUpCriteriaModal" onClick={(event) => event.stopPropagation()}>
            <button className="modalClose" type="button" onClick={() => setCriteriaModalSkill(null)}>
              ×
            </button>
            <h3>{criteriaModalSkill.title}</h3>
            <div className="skillUpCriteriaPanel">
              {criteriaModalSkill.description ? (
                <p className="skillUpCriteriaIntro">{criteriaModalSkill.description}</p>
              ) : null}
              <h4 className="skillUpCriteriaHeading">レベル別達成基準</h4>
              <ul className="skillUpCriteriaLevels">
                {Array.from({ length: Math.max(1, Number(criteriaModalSkill.stages) || 1) }, (_, index) => {
                  const lines = Array.isArray(criteriaModalSkill.levelCriteria) ? criteriaModalSkill.levelCriteria : []
                  const text = (lines[index] ?? '').trim()
                  return (
                    <li key={index} className="skillUpCriteriaLevelItem">
                      <span className="skillUpCriteriaLvLabel">Lv.{index + 1}</span>
                      <p className="skillUpCriteriaLvText">{text || '（未設定）'}</p>
                    </li>
                  )
                })}
              </ul>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  )
}

function EvalQuestionnairePage({ variant, employees, evalState, setEvalState, peerSelfEval }) {
  const isBoss = variant === 'boss'
  const employee = useMemo(() => (employees.length ? employees[0] : null), [employees])

  const scores = evalState?.scores ?? {}
  const comments = evalState?.comments ?? {}
  const peerScores = peerSelfEval?.scores ?? {}

  const patchScore = (itemId, value) => {
    setEvalState((prev) => ({
      scores: { ...(prev.scores ?? {}), [itemId]: value },
      comments: { ...(prev.comments ?? {}) },
    }))
  }

  const patchComment = (itemId, value) => {
    setEvalState((prev) => ({
      scores: { ...(prev.scores ?? {}) },
      comments: { ...(prev.comments ?? {}), [itemId]: value },
    }))
  }

  const allItems = useMemo(() => SELF_EVAL_CATEGORIES.flatMap((c) => c.items), [])
  const totalCount = allItems.length

  const [openCats, setOpenCats] = useState(() =>
    Object.fromEntries(SELF_EVAL_CATEGORIES.map((c, i) => [c.id, i === 0])),
  )
  const [detailItem, setDetailItem] = useState(null)

  const evaluatedCount = useMemo(
    () => allItems.filter((it) => String(scores[it.id] ?? '').trim() !== '').length,
    [allItems, scores],
  )

  const categoryDoneCount = (cat) =>
    cat.items.filter((it) => String(scores[it.id] ?? '').trim() !== '').length

  const allComplete = evaluatedCount >= totalCount

  if (!employee) {
    return (
      <section className={`selfEvalPage${isBoss ? ' bossEvalPage' : ''}`}>
        <p className="skillUpEmpty">従業員が登録されていません。従業員管理から登録してください。</p>
      </section>
    )
  }

  const guideLinesSelf = [
    '各項目について、1～5点で自己評価してください',
    '点数の基準は「詳細を表示」ボタンで確認できます',
    '入力内容は自動で保存されます',
  ]

  const guideLinesBoss = [
    '各項目について、1～5点で評価してください',
    '被評価者の自己評価点数は各項目に参考として表示されます（自己評価タブで入力）',
    '評価の根拠やコメントを入力してください',
    '入力内容は自動で保存されます',
  ]

  const guideLines = isBoss ? guideLinesBoss : guideLinesSelf

  return (
    <section className={`selfEvalPage${isBoss ? ' bossEvalPage' : ''}`}>
      <header className="selfEvalHeader">
        <h2>{isBoss ? '上司評価' : '自己評価'}</h2>
        <p className="selfEvalTarget">
          {isBoss ? '評価対象' : '対象者'}: {employee.name}（{employee.dept}）
        </p>
      </header>

      <div className="selfEvalGuide">
        <p className="selfEvalGuideTitle">
          <span className="selfEvalGuideIcon" aria-hidden>
            ⓘ
          </span>
          評価の進め方
        </p>
        <ul className="selfEvalGuideList">
          {guideLines.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      </div>

      <div className="selfEvalSummaryCard">
        <div>
          {isBoss ? <p className="bossEvalProgressLabel">評価進捗</p> : null}
          <p className="selfEvalSummaryRatio">
            {evaluatedCount} / {totalCount} 項目
          </p>
          <p className={`selfEvalSummaryHint ${allComplete ? 'isDone' : ''}`}>
            {allComplete ? 'すべての項目の評価が完了しています' : 'すべての項目を評価してください'}
          </p>
        </div>
      </div>

      <div className="selfEvalCategories">
        {SELF_EVAL_CATEGORIES.map((cat) => {
          const done = categoryDoneCount(cat)
          const open = !!openCats[cat.id]
          return (
            <section key={cat.id} className="selfEvalCategory">
              <button
                type="button"
                className="selfEvalCategoryHead"
                onClick={() => setOpenCats((prev) => ({ ...prev, [cat.id]: !prev[cat.id] }))}
                aria-expanded={open}
              >
                <span className="selfEvalChevron" aria-hidden>
                  {open ? '▼' : '▶'}
                </span>
                <span className="selfEvalCategoryTitle">{cat.title}</span>
                <span className="selfEvalCategoryBadge">
                  {done} / {cat.items.length} 完了
                </span>
              </button>
              {open ? (
                <div className="selfEvalCategoryBody">
                  {cat.items.map((it) => {
                    const selfPts = String(peerScores[it.id] ?? '').trim()
                    return (
                      <article key={it.id} className="selfEvalItemCard">
                        <div className="selfEvalItemCardTop">
                          <h4 className="selfEvalItemTitle">{it.title}</h4>
                        </div>
                        {isBoss ? (
                          <p className="bossEvalSelfNote">
                            自己評価の点数: {selfPts ? `${selfPts}点` : '（未入力）'}
                          </p>
                        ) : null}
                        <div className={`selfEvalItemGrid${isBoss ? '' : ' isSingleField'}`}>
                          <label className="selfEvalFieldLabel">
                            <span className="selfEvalFieldHead">
                              <span>{isBoss ? '上司評価の点数' : '評価点数'}</span>
                              <button
                                type="button"
                                className="selfEvalDetailLink"
                                onClick={() => setDetailItem(it)}
                                aria-label={`${it.title} の詳細を表示`}
                                title="詳細を表示"
                              >
                                ⓘ
                              </button>
                            </span>
                            <div className="selfEvalScoreSegment" role="group" aria-label={`${it.title}の評価点数`}>
                              {[1, 2, 3, 4, 5].map((n) => {
                                const value = String(n)
                                const selected = String(scores[it.id] ?? '') === value
                                return (
                                  <button
                                    key={n}
                                    type="button"
                                    className={`selfEvalScorePill${selected ? ' isActive' : ''}`}
                                    onClick={() => patchScore(it.id, value)}
                                    aria-pressed={selected}
                                  >
                                    {n}
                                  </button>
                                )
                              })}
                            </div>
                          </label>
                          {isBoss ? (
                            <label className="selfEvalFieldLabel">
                              <span>コメント（評価の根拠など）</span>
                              <input
                                type="text"
                                value={comments[it.id] ?? ''}
                                onChange={(event) => patchComment(it.id, event.target.value)}
                                placeholder="評価の根拠や補足があれば入力"
                              />
                            </label>
                          ) : null}
                        </div>
                      </article>
                    )
                  })}
                </div>
              ) : null}
            </section>
          )
        })}
      </div>

      {detailItem ? (
        <div className="employeeModalOverlay" onClick={() => setDetailItem(null)}>
          <div className="employeeModal selfEvalDetailModal" onClick={(event) => event.stopPropagation()}>
            <button type="button" className="modalClose" onClick={() => setDetailItem(null)}>
              ×
            </button>
            <h3>{detailItem.title}</h3>
            <div className="selfEvalDetailScoreBox">
              <p className="selfEvalDetailScoreLabel">{isBoss ? '上司評価の点数' : '評価点数'}</p>
              <div className="selfEvalScoreSegment" role="group" aria-label={`${detailItem.title}の評価点数`}>
                {[1, 2, 3, 4, 5].map((n) => {
                  const value = String(n)
                  const selected = String(scores[detailItem.id] ?? '') === value
                  return (
                    <button
                      key={n}
                      type="button"
                      className={`selfEvalScorePill${selected ? ' isActive' : ''}`}
                      onClick={() => patchScore(detailItem.id, value)}
                      aria-pressed={selected}
                    >
                      {n}
                    </button>
                  )
                })}
              </div>
            </div>
            <div className="selfEvalDetailBody">
              <h4>点数の目安（1～5点）</h4>
              <pre className="selfEvalDetailCriteria">{detailItem.criteria}</pre>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  )
}

function SelfEvaluationPage({ employees, evalState, setEvalState }) {
  return <EvalQuestionnairePage variant="self" employees={employees} evalState={evalState} setEvalState={setEvalState} />
}

function SupervisorEvaluationPage({ employees, evalState, setEvalState, peerSelfEval }) {
  return (
    <EvalQuestionnairePage
      variant="boss"
      employees={employees}
      evalState={evalState}
      setEvalState={setEvalState}
      peerSelfEval={peerSelfEval}
    />
  )
}

function ExecutiveEvaluationPage({ employee, evalState, setEvalState }) {
  const baseScore = Number(evalState?.baseScore ?? 0)
  const commentHistory = Array.isArray(evalState?.commentHistory) ? evalState.commentHistory : []
  const commentTotal = commentHistory.reduce((sum, row) => sum + (Number(row.delta) || 0), 0)
  const finalScoreRaw = baseScore + commentTotal
  const finalScore = Math.max(0, Math.min(100, finalScoreRaw))

  const [draftDelta, setDraftDelta] = useState(0)
  const [draftComment, setDraftComment] = useState('')

  const setBaseScore = (value) => {
    const next = Math.max(0, Math.min(100, Number(value) || 0))
    setEvalState((prev) => ({ baseScore: next, commentHistory: [...(prev.commentHistory ?? [])] }))
  }

  const addCommentEvaluation = () => {
    const text = draftComment.trim()
    if (!text) {
      window.alert('コメント内容を入力してください。')
      return
    }
    const delta = Math.max(-20, Math.min(20, Number(draftDelta) || 0))
    const item = {
      id: `exec-log-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      delta,
      comment: text,
      createdAt: new Date().toISOString(),
    }
    setEvalState((prev) => ({
      baseScore: Number(prev.baseScore ?? 0),
      commentHistory: [item, ...(prev.commentHistory ?? [])],
    }))
    setDraftComment('')
    setDraftDelta(0)
  }

  const removeHistory = (id) => {
    if (!window.confirm('このコメント評価履歴を削除しますか？')) return
    setEvalState((prev) => ({
      baseScore: Number(prev.baseScore ?? 0),
      commentHistory: (prev.commentHistory ?? []).filter((row) => row.id !== id),
    }))
  }

  const formatJpDateTime = (iso) => {
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) return String(iso ?? '')
    return d.toLocaleString('ja-JP')
  }

  if (!employee) {
    return (
      <section className="execEvalPage">
        <p className="skillUpEmpty">従業員が登録されていません。従業員管理から登録してください。</p>
      </section>
    )
  }

  return (
    <section className="execEvalPage">
      <header className="execEvalHeader">
        <h2>経営層評価</h2>
        <p className="execEvalTarget">
          評価対象: {employee.name}（{employee.dept} / {employee.grade}）
        </p>
      </header>

      <article className="execEvalScoreCard">
        <p className="execEvalScoreLabel">最終スコア</p>
        <p className="execEvalScoreValue">
          {finalScore}
          <span>/ 100点</span>
        </p>
        <div className="execEvalScoreBreakdown">
          <span>基本点: {baseScore}</span>
          <span>コメント点: {commentTotal >= 0 ? `+${commentTotal}` : commentTotal}</span>
        </div>
      </article>

      <article className="execEvalSection">
        <h3>基本評価（100点満点）</h3>
        <p>該当する評価を選択してください</p>
        <div className="execEvalBaseButtons">
          {[
            [100, '優秀'],
            [80, '良好'],
            [60, '標準'],
            [40, '要改善'],
            [20, '不十分'],
          ].map(([score, label]) => (
            <button
              key={score}
              type="button"
              className={`execEvalBaseBtn ${baseScore === score ? 'isActive' : ''}`}
              onClick={() => setBaseScore(score)}
            >
              <strong>{score}</strong>
              <small>{label}</small>
            </button>
          ))}
        </div>
      </article>

      <article className="execEvalSection">
        <h3>コメント評価（加減点）</h3>
        <p>コメントを追加するたびに加減点が履歴として蓄積されます。</p>
        <div className="execEvalDeltaRow">
          {[-10, -5, -3, 0, 3, 5, 10].map((n) => (
            <button
              key={n}
              type="button"
              className={`execEvalDeltaBtn ${draftDelta === n ? 'isActive' : ''}`}
              onClick={() => setDraftDelta(n)}
            >
              {n > 0 ? `+${n}` : n}
            </button>
          ))}
        </div>
        <label className="execEvalCommentField">
          コメント内容
          <textarea
            value={draftComment}
            onChange={(event) => setDraftComment(event.target.value)}
            placeholder="評価の詳細や特記事項を入力してください"
            rows={4}
          />
        </label>
        <button type="button" className="execEvalAddBtn" onClick={addCommentEvaluation}>
          コメント評価を追加
        </button>
      </article>

      <article className="execEvalSection">
        <h3>コメント評価の履歴</h3>
        {commentHistory.length === 0 ? (
          <p className="execEvalEmpty">履歴はまだありません。</p>
        ) : (
          <ul className="execEvalHistoryList">
            {commentHistory.map((row) => (
              <li key={row.id} className="execEvalHistoryItem">
                <div className="execEvalHistoryTop">
                  <span className={`execEvalHistoryDelta ${row.delta >= 0 ? 'isPlus' : 'isMinus'}`}>
                    {row.delta >= 0 ? `+${row.delta}` : row.delta}点
                  </span>
                  <span className="execEvalHistoryDate">{formatJpDateTime(row.createdAt)}</span>
                  <button type="button" className="execEvalDeleteBtn" onClick={() => removeHistory(row.id)}>
                    削除
                  </button>
                </div>
                <p className="execEvalHistoryComment">{row.comment}</p>
              </li>
            ))}
          </ul>
        )}
      </article>
    </section>
  )
}

function GoalManagementPage({ employee, goals, setGoals }) {
  const [addOpen, setAddOpen] = useState(false)
  const [draftTitle, setDraftTitle] = useState('')
  const [draftDetail, setDraftDetail] = useState('')
  const [draftDeadline, setDraftDeadline] = useState('')

  const periodLabel = useMemo(() => formatQuarterLabel(new Date()), [])

  const total = goals.length
  const achieved = useMemo(() => goals.filter((g) => g.achieved).length, [goals])
  const ratePct = total === 0 ? 0 : Math.round((achieved / total) * 100)

  const openAddModal = () => {
    setDraftTitle('')
    setDraftDetail('')
    setDraftDeadline('')
    setAddOpen(true)
  }

  const closeAddModal = () => setAddOpen(false)

  const handleCreateGoal = () => {
    const title = draftTitle.trim()
    const detail = draftDetail.trim()
    const deadline = draftDeadline.trim()
    if (!title || !detail || !deadline) {
      window.alert('必須項目（目標タイトル・目標詳細・目標期日）を入力してください。')
      return
    }
    const id = `goal-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
    setGoals((prev) => [...prev, { id, title, detail, deadline, achieved: false }])
    closeAddModal()
  }

  const setGoalAchieved = (id, checked) => {
    setGoals((prev) => prev.map((g) => (g.id === id ? { ...g, achieved: checked } : g)))
  }

  const removeGoal = (id) => {
    if (!window.confirm('この目標を削除しますか？')) return
    setGoals((prev) => prev.filter((g) => g.id !== id))
  }

  const deadlineLabel = (ymd) => {
    const s = String(ymd ?? '').trim()
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return s || '―'
    try {
      return new Date(`${s}T12:00:00`).toLocaleDateString('ja-JP')
    } catch {
      return s
    }
  }

  if (!employee) {
    return (
      <section className="goalMgmtPage">
        <p className="skillUpEmpty">従業員が登録されていません。従業員管理から登録してください。</p>
      </section>
    )
  }

  return (
    <section className="goalMgmtPage">
      <header className="goalMgmtHeader">
        <h2>目標設定・管理</h2>
        <p className="goalMgmtMeta">
          {periodLabel} ・ {employee.name}
        </p>
      </header>

      <div className="goalMgmtSummaryGrid">
        <article className="goalMgmtStatCard goalMgmtStatSet">
          <div className="goalMgmtStatIcon" aria-hidden>
            📋
          </div>
          <div>
            <p className="goalMgmtStatLabel">設定目標</p>
            <strong className="goalMgmtStatValue goalMgmtStatBlue">{total}</strong>
          </div>
        </article>
        <article className="goalMgmtStatCard goalMgmtStatDone">
          <div className="goalMgmtStatIcon" aria-hidden>
            ✓
          </div>
          <div>
            <p className="goalMgmtStatLabel">達成済み</p>
            <strong className="goalMgmtStatValue goalMgmtStatGreen">{achieved}</strong>
          </div>
        </article>
        <article className="goalMgmtStatCard goalMgmtStatRate">
          <div className="goalMgmtStatIcon" aria-hidden>
            📊
          </div>
          <div>
            <p className="goalMgmtStatLabel">達成率</p>
            <strong className="goalMgmtStatValue goalMgmtStatPurple">{ratePct}%</strong>
          </div>
        </article>
      </div>

      <div className="goalMgmtToolbar">
        <button type="button" className="goalMgmtAddBtn" onClick={openAddModal}>
          + 新しい目標を追加
        </button>
      </div>

      <div className="goalMgmtMainBox">
        {total === 0 ? (
          <div className="goalMgmtEmpty">
            <p>目標が設定されていません。</p>
            <p>「新しい目標を追加」ボタンから目標を設定してください。</p>
          </div>
        ) : (
          <ul className="goalMgmtList">
            {goals.map((g) => (
              <li key={g.id} className="goalMgmtListItem">
                <div className="goalMgmtListHead">
                  <label className="goalMgmtCheckLabel">
                    <input
                      type="checkbox"
                      checked={g.achieved}
                      onChange={(event) => setGoalAchieved(g.id, event.target.checked)}
                    />
                    <span className={g.achieved ? 'goalMgmtListTitle isAchieved' : 'goalMgmtListTitle'}>{g.title}</span>
                  </label>
                  <button type="button" className="goalMgmtDeleteBtn" onClick={() => removeGoal(g.id)}>
                    削除
                  </button>
                </div>
                <p className="goalMgmtListDeadline">期日: {deadlineLabel(g.deadline)}</p>
                <p className="goalMgmtListDetail">{g.detail}</p>
              </li>
            ))}
          </ul>
        )}
      </div>

      {addOpen ? (
        <div className="employeeModalOverlay" onClick={closeAddModal}>
          <div className="employeeModal goalMgmtFormModal" onClick={(event) => event.stopPropagation()}>
            <button type="button" className="modalClose" onClick={closeAddModal}>
              ×
            </button>
            <h3>新しい目標を追加</h3>
            <p className="goalMgmtModalSub">新しい目標の内容を入力してください。</p>
            <div className="goalMgmtFormFields">
              <label className="goalMgmtFormLabel">
                目標タイトル <span className="goalMgmtReq">*</span>
                <input
                  type="text"
                  value={draftTitle}
                  onChange={(event) => setDraftTitle(event.target.value)}
                  placeholder="例：新規顧客10社の獲得"
                  autoComplete="off"
                />
              </label>
              <label className="goalMgmtFormLabel">
                目標詳細 <span className="goalMgmtReq">*</span>
                <textarea
                  value={draftDetail}
                  onChange={(event) => setDraftDetail(event.target.value)}
                  placeholder="目標の詳細な説明を入力してください"
                  rows={4}
                />
              </label>
              <label className="goalMgmtFormLabel">
                目標期日 <span className="goalMgmtReq">*</span>
                <input type="date" value={draftDeadline} onChange={(event) => setDraftDeadline(event.target.value)} />
              </label>
            </div>
            <div className="goalMgmtModalActions">
              <button type="button" className="goalMgmtBtnSecondary" onClick={closeAddModal}>
                キャンセル
              </button>
              <button type="button" className="goalMgmtBtnPrimary" onClick={handleCreateGoal}>
                作成
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  )
}

const SKILL_DEPT_CHOICES = ['製造', '営業', '品質']

function SkillSettingsPage({ skills, setSkills, sections, setSections, grades, setGrades, activeGradeId, setActiveGradeId }) {
  const [modalOpen, setModalOpen] = useState(false)
  const [sectionModalOpen, setSectionModalOpen] = useState(false)
  const [gradeModalOpen, setGradeModalOpen] = useState(false)
  const [newSectionLabel, setNewSectionLabel] = useState('')
  const [newGradeLabel, setNewGradeLabel] = useState('')
  const [editingId, setEditingId] = useState(null)
  const [draft, setDraft] = useState({
    gradeId: 'G1',
    sectionId: 'basic',
    title: '',
    description: '',
    stages: 3,
    levelStars: 5,
    maxStars: 15,
    required: true,
    allDepts: true,
    depts: [],
    levelCriteria: ['', '', ''],
  })

  const firstSectionId = sections[0]?.id ?? 'basic'
  const firstGradeId = grades[0]?.id ?? 'G1'

  useEffect(() => {
    if (!grades.some((g) => g.id === activeGradeId)) {
      setActiveGradeId(firstGradeId)
    }
  }, [grades, activeGradeId, setActiveGradeId, firstGradeId])

  const openCreate = () => {
    setEditingId(null)
    setDraft({
      gradeId: grades.some((g) => g.id === activeGradeId) ? activeGradeId : firstGradeId,
      sectionId: firstSectionId,
      title: '',
      description: '',
      stages: 3,
      levelStars: 5,
      maxStars: 15,
      required: true,
      allDepts: true,
      depts: [],
      levelCriteria: ['', '', ''],
    })
    setModalOpen(true)
  }

  const openEdit = (skill) => {
    const depts = Array.isArray(skill.departments) ? skill.departments : []
    const allDepts = depts.includes('all') || depts.length === 0
    const sectionIdSet = new Set(sections.map((s) => s.id))
    const resolvedSectionId = sectionIdSet.has(skill.sectionId) ? skill.sectionId : firstSectionId
    const gradeIdSet = new Set(grades.map((g) => g.id))
    const resolvedGradeId = gradeIdSet.has(skill.gradeId) ? skill.gradeId : firstGradeId
    const st = Math.min(20, Math.max(1, Number(skill.stages) || 3))
    const existingLc = Array.isArray(skill.levelCriteria) ? [...skill.levelCriteria] : []
    const levelCriteria = resizeLevelCriteriaArray(existingLc, st)
    setEditingId(skill.id)
    setDraft({
      gradeId: resolvedGradeId,
      sectionId: resolvedSectionId,
      title: skill.title ?? '',
      description: skill.description ?? '',
      stages: st,
      levelStars: Number(skill.levelStars) || 0,
      maxStars: Number(skill.maxStars) || 0,
      required: !!skill.required,
      allDepts,
      depts: allDepts ? [] : depts.filter((d) => d !== 'all'),
      levelCriteria,
    })
    setModalOpen(true)
  }

  const toggleDept = (name) => {
    setDraft((prev) => {
      const has = prev.depts.includes(name)
      const nextDepts = has ? prev.depts.filter((d) => d !== name) : [...prev.depts, name]
      return { ...prev, depts: nextDepts }
    })
  }

  const handleSaveSkill = (event) => {
    event.preventDefault()
    const title = draft.title.trim()
    if (!title) return

    const departments = draft.allDepts
      ? ['all']
      : draft.depts.length > 0
        ? [...draft.depts]
        : ['製造']

    const stagesNum = Math.min(20, Math.max(1, Number(draft.stages) || 3))
    const levelCriteria = resizeLevelCriteriaArray(draft.levelCriteria, stagesNum)

    const row = {
      id: editingId ?? `skill_${Date.now()}`,
      gradeId: draft.gradeId,
      sectionId: draft.sectionId,
      title,
      description: draft.description.trim(),
      stages: stagesNum,
      levelCriteria,
      levelStars: Math.max(0, Number(draft.levelStars) || 0),
      maxStars: Math.max(0, Number(draft.maxStars) || 0),
      required: !!draft.required,
      departments,
    }

    setSkills((prev) => {
      if (editingId) return prev.map((s) => (s.id === editingId ? row : s))
      return [...prev, row]
    })
    setModalOpen(false)
    setEditingId(null)
  }

  const handleDeleteSkill = (id) => {
    const ok = window.confirm('このスキル設定を削除しますか？\n\n「OK」で削除、「キャンセル」で中止します。')
    if (!ok) return
    setSkills((prev) => prev.filter((s) => s.id !== id))
  }

  const openAddSectionModal = () => {
    setNewSectionLabel('')
    setSectionModalOpen(true)
  }

  const handleSaveNewSection = (event) => {
    event.preventDefault()
    const label = newSectionLabel.trim()
    if (!label) return
    const id = `sec_${Date.now()}`
    setSections((prev) => [...prev, { id, label }])
    setSectionModalOpen(false)
    setNewSectionLabel('')
  }

  const openAddGradeModal = () => {
    setNewGradeLabel('')
    setGradeModalOpen(true)
  }

  const handleSaveNewGrade = (event) => {
    event.preventDefault()
    const label = newGradeLabel.trim()
    if (!label) return
    const id = `grade_${Date.now()}`
    setGrades((prev) => [...prev, { id, label }])
    setActiveGradeId(id)
    setGradeModalOpen(false)
    setNewGradeLabel('')
  }

  return (
    <section className="skillSettings">
      <header className="skillSettingsHeader">
        <div>
          <h2>スキル設定管理</h2>
          <p>スキルの設定を確認・編集できます</p>
        </div>
        <div className="skillSettingsHeaderActions">
          <button type="button" className="skillSectionAddButton" onClick={openAddSectionModal}>
            + 区分を追加
          </button>
          <button type="button" className="skillAddButton" onClick={openCreate}>
            + 新規スキル追加
          </button>
        </div>
      </header>

      <nav className="skillGradeTabs" aria-label="等級で切り替え">
        {grades.map((g) => (
          <button
            key={g.id}
            type="button"
            className={`skillGradeTab ${g.id === activeGradeId ? 'isActive' : ''}`}
            onClick={() => setActiveGradeId(g.id)}
          >
            {g.label}
          </button>
        ))}
        <button type="button" className="skillGradeTab skillGradeTabAdd" onClick={openAddGradeModal}>
          + 等級
        </button>
      </nav>

      {sections.map((sec) => {
        const sectionSkills = skills.filter((s) => s.sectionId === sec.id && s.gradeId === activeGradeId)
        return (
          <section className="skillSection" key={sec.id}>
            <h3 className="skillSectionTitle">
              <span className="skillGear" aria-hidden>
                ⚙
              </span>
              {sec.label}
            </h3>
            <div className="skillTableWrap">
              <table className="skillTable">
                <thead>
                  <tr>
                    <th>スキル名</th>
                    <th>段階数</th>
                    <th>★/レベル</th>
                    <th>最大★</th>
                    <th>必須/任意</th>
                    <th>対象部署</th>
                    <th>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {sectionSkills.length === 0 ? (
                    <tr>
                      <td colSpan={7} className="skillTableEmpty">
                        この区分にスキルはまだありません。
                      </td>
                    </tr>
                  ) : (
                    sectionSkills.map((skill) => (
                      <tr key={skill.id}>
                        <td className="skillNameCell">
                          <strong>{skill.title}</strong>
                          {skill.description ? <p className="skillDesc">{skill.description}</p> : null}
                        </td>
                        <td>
                          <span className="stagePill">{skill.stages}段階</span>
                        </td>
                        <td className="starCell">
                          <span className="starYellow" aria-hidden>
                            ★
                          </span>{' '}
                          {skill.levelStars}★
                        </td>
                        <td className="starCell starCellMax">
                          <span className="starGreen" aria-hidden>
                            ★
                          </span>{' '}
                          {skill.maxStars}★
                        </td>
                        <td>
                          {skill.required ? (
                            <span className="reqPill required">必須</span>
                          ) : (
                            <span className="reqPill optional">任意</span>
                          )}
                        </td>
                        <td>
                          <div className="deptBadges">
                            {(skill.departments || []).includes('all') ? (
                              <span className="deptAll">全部署</span>
                            ) : (
                              (skill.departments || []).map((d) => (
                                <span key={d} className="deptOne">
                                  {d}
                                </span>
                              ))
                            )}
                          </div>
                        </td>
                        <td className="skillTableActions">
                          <button type="button" className="skillEditBtn" onClick={() => openEdit(skill)} aria-label="編集">
                            ✎ 編集
                          </button>
                          <button
                            type="button"
                            className="skillDeleteBtn"
                            onClick={() => handleDeleteSkill(skill.id)}
                            aria-label="削除"
                            title="削除（確認のあと実行）"
                          >
                            🗑
                          </button>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </section>
        )
      })}

      {modalOpen ? (
        <div className="employeeModalOverlay" onClick={() => setModalOpen(false)}>
          <div className="employeeModal skillSettingsModal" onClick={(e) => e.stopPropagation()}>
            <button className="modalClose" type="button" onClick={() => setModalOpen(false)}>
              ×
            </button>
            <h3>{editingId ? 'スキルを編集' : '新規スキルを追加'}</h3>
            <p>内容を入力して保存してください。</p>

            <form className="employeeForm" onSubmit={handleSaveSkill}>
              <label>
                等級 *
                <select
                  value={draft.gradeId}
                  onChange={(event) => setDraft((prev) => ({ ...prev, gradeId: event.target.value }))}
                >
                  {grades.map((g) => (
                    <option key={g.id} value={g.id}>
                      {g.label}
                    </option>
                  ))}
                </select>
              </label>

              <label>
                区分 *
                <select
                  value={draft.sectionId}
                  onChange={(event) => setDraft((prev) => ({ ...prev, sectionId: event.target.value }))}
                >
                  {sections.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.label}
                    </option>
                  ))}
                </select>
              </label>

              <label>
                スキル名 *
                <input
                  type="text"
                  value={draft.title}
                  onChange={(event) => setDraft((prev) => ({ ...prev, title: event.target.value }))}
                  required
                />
              </label>

              <label>
                説明
                <textarea
                  rows={3}
                  value={draft.description}
                  onChange={(event) => setDraft((prev) => ({ ...prev, description: event.target.value }))}
                />
              </label>

              <label>
                段階数 *
                <input
                  type="number"
                  min={1}
                  max={20}
                  value={draft.stages}
                  onChange={(event) => {
                    const raw = event.target.value
                    setDraft((prev) => {
                      const parsed = Number(raw)
                      if (Number.isFinite(parsed) && parsed >= 1 && parsed <= 20) {
                        return {
                          ...prev,
                          stages: raw,
                          levelCriteria: resizeLevelCriteriaArray(prev.levelCriteria, parsed),
                        }
                      }
                      return { ...prev, stages: raw }
                    })
                  }}
                  required
                />
              </label>

              <fieldset className="skillLevelCriteriaFieldset">
                <legend>レベル別達成基準（任意）</legend>
                <p className="skillLevelCriteriaHelp">各レベルで何ができるべきかを記入してください</p>
                {Array.from(
                  { length: Math.min(20, Math.max(1, Number(draft.stages) || 3)) },
                  (_, index) => index,
                ).map((index) => (
                  <label key={index} className="skillLevelCriteriaRow">
                    Lv.{index + 1}
                    <input
                      type="text"
                      value={draft.levelCriteria[index] ?? ''}
                      placeholder={`Lv.${index + 1}で達成すべき基準を入力`}
                      onChange={(event) => {
                        const value = event.target.value
                        setDraft((prev) => {
                          const n = Math.min(20, Math.max(1, Number(prev.stages) || 3))
                          const next = resizeLevelCriteriaArray(prev.levelCriteria, n)
                          next[index] = value
                          return { ...prev, levelCriteria: next }
                        })
                      }}
                    />
                  </label>
                ))}
              </fieldset>

              <label>
                ★/レベル *
                <input
                  type="number"
                  min={0}
                  value={draft.levelStars}
                  onChange={(event) => setDraft((prev) => ({ ...prev, levelStars: event.target.value }))}
                  required
                />
              </label>

              <label>
                最大★ *
                <input
                  type="number"
                  min={0}
                  value={draft.maxStars}
                  onChange={(event) => setDraft((prev) => ({ ...prev, maxStars: event.target.value }))}
                  required
                />
              </label>

              <label>
                必須/任意 *
                <select
                  value={draft.required ? 'required' : 'optional'}
                  onChange={(event) =>
                    setDraft((prev) => ({ ...prev, required: event.target.value === 'required' }))
                  }
                >
                  <option value="required">必須</option>
                  <option value="optional">任意</option>
                </select>
              </label>

              <fieldset className="skillDeptFieldset">
                <legend>対象部署</legend>
                <label className="skillCheckboxRow">
                  <input
                    type="checkbox"
                    checked={draft.allDepts}
                    onChange={(event) =>
                      setDraft((prev) => ({
                        ...prev,
                        allDepts: event.target.checked,
                        depts: event.target.checked ? [] : prev.depts,
                      }))
                    }
                  />
                  全部署
                </label>
                {!draft.allDepts ? (
                  <div className="skillDeptChecks">
                    {SKILL_DEPT_CHOICES.map((d) => (
                      <label key={d} className="skillCheckboxRow">
                        <input
                          type="checkbox"
                          checked={draft.depts.includes(d)}
                          onChange={() => toggleDept(d)}
                        />
                        {d}
                      </label>
                    ))}
                  </div>
                ) : null}
              </fieldset>

              <div className="modalActions">
                <button type="button" className="cancel" onClick={() => setModalOpen(false)}>
                  キャンセル
                </button>
                <button type="submit" className="submit">
                  保存
                </button>
              </div>
            </form>
          </div>
        </div>
      ) : null}

      {sectionModalOpen ? (
        <div className="employeeModalOverlay" onClick={() => setSectionModalOpen(false)}>
          <div className="employeeModal skillSettingsModal" onClick={(e) => e.stopPropagation()}>
            <button className="modalClose" type="button" onClick={() => setSectionModalOpen(false)}>
              ×
            </button>
            <h3>区分を追加</h3>
            <p>一覧に表示する区分名を入力して保存してください。</p>

            <form className="employeeForm" onSubmit={handleSaveNewSection}>
              <label>
                区分名 *
                <input
                  type="text"
                  value={newSectionLabel}
                  onChange={(event) => setNewSectionLabel(event.target.value)}
                  placeholder="例: 専門編"
                  required
                />
              </label>

              <div className="modalActions">
                <button type="button" className="cancel" onClick={() => setSectionModalOpen(false)}>
                  キャンセル
                </button>
                <button type="submit" className="submit">
                  追加
                </button>
              </div>
            </form>
          </div>
        </div>
      ) : null}

      {gradeModalOpen ? (
        <div className="employeeModalOverlay" onClick={() => setGradeModalOpen(false)}>
          <div className="employeeModal skillSettingsModal" onClick={(e) => e.stopPropagation()}>
            <button className="modalClose" type="button" onClick={() => setGradeModalOpen(false)}>
              ×
            </button>
            <h3>等級を追加</h3>
            <p>タブに表示する等級名を入力してください（例: P3、専門職）。</p>

            <form className="employeeForm" onSubmit={handleSaveNewGrade}>
              <label>
                等級名 *
                <input
                  type="text"
                  value={newGradeLabel}
                  onChange={(event) => setNewGradeLabel(event.target.value)}
                  placeholder="例: P3"
                  required
                />
              </label>

              <div className="modalActions">
                <button type="button" className="cancel" onClick={() => setGradeModalOpen(false)}>
                  キャンセル
                </button>
                <button type="submit" className="submit">
                  追加
                </button>
              </div>
            </form>
          </div>
        </div>
      ) : null}
    </section>
  )
}

function AdminMockPage({
  directoryRows,
  skills,
  skillProgress,
  skillProgressUpdatedAtByEmployee,
  selfEvalByEmployee,
  supervisorEvalByEmployee,
  executiveEvalByEmployee,
  goalsByEmployee,
  forcedSelectedMemberId,
  forcedDetailTab,
  onSelectMember,
  onChangeDetailTab,
  onStartSupervisorEval,
  onStartExecutiveEval,
}) {
  const [selectedMemberId, setSelectedMemberId] = useState(null)
  const [detailTab, setDetailTab] = useState('skill')

  const memberRows = useMemo(
    () =>
      directoryRows.map((row) => ({
        id: row.id,
        name: row.name,
        dept: row.dept,
        grade: row.grade,
        score: row.score,
        stars: calcEmployeeSkillStars(skills, skillProgress?.[row.id] ?? {}),
        role: row.role ?? '一般従業員',
        joinDate: row.joinDate ?? '',
      })),
    [directoryRows, skills, skillProgress],
  )

  useEffect(() => {
    if (!memberRows.length) {
      setSelectedMemberId(null)
      return
    }
    if (!selectedMemberId || !memberRows.some((m) => m.id === selectedMemberId)) {
      setSelectedMemberId(memberRows[0].id)
    }
  }, [memberRows, selectedMemberId])

  useEffect(() => {
    if (!forcedSelectedMemberId) return
    if (memberRows.some((m) => m.id === forcedSelectedMemberId)) {
      setSelectedMemberId(forcedSelectedMemberId)
    }
  }, [forcedSelectedMemberId, memberRows])

  useEffect(() => {
    if (!forcedDetailTab) return
    setDetailTab(forcedDetailTab)
  }, [forcedDetailTab])

  const selectedMember = useMemo(
    () => memberRows.find((m) => m.id === selectedMemberId) ?? null,
    [memberRows, selectedMemberId],
  )
  const selectedMemberSkills = useMemo(() => {
    if (!selectedMember) return []
    const rawProgress = skillProgress?.[selectedMember.id] ?? {}
    return (skills ?? [])
      .filter((s) => s.gradeId === selectedMember.grade)
      .map((s) => {
        const current = Math.max(0, Number(rawProgress[s.id] ?? 0))
        const max = Math.max(1, Number(s.stages) || 1)
        return { id: s.id, title: s.title, description: s.description, required: !!s.required, current, max }
      })
  }, [selectedMember, skills, skillProgress])
  const evalItems = useMemo(() => SELF_EVAL_CATEGORIES.flatMap((cat) => cat.items), [])
  const selectedMemberSelfEvalRows = useMemo(() => {
    if (!selectedMember) return []
    const evalState = selfEvalByEmployee?.[selectedMember.id]
    const scores = evalState?.scores ?? {}
    return evalItems
      .map((item) => {
        const score = String(scores[item.id] ?? '').trim()
        if (!score) return null
        return { id: item.id, title: item.title, score }
      })
      .filter(Boolean)
  }, [selectedMember, selfEvalByEmployee, evalItems])
  const selectedMemberBossEvalRows = useMemo(() => {
    if (!selectedMember) return []
    const evalState = supervisorEvalByEmployee?.[selectedMember.id]
    const scores = evalState?.scores ?? {}
    const comments = evalState?.comments ?? {}
    return evalItems
      .map((item) => {
        const score = String(scores[item.id] ?? '').trim()
        const comment = String(comments[item.id] ?? '').trim()
        if (!score && !comment) return null
        return { id: item.id, title: item.title, score, comment }
      })
      .filter(Boolean)
  }, [selectedMember, supervisorEvalByEmployee, evalItems])
  const selectedMemberGoals = selectedMember ? goalsByEmployee?.[selectedMember.id] ?? [] : []
  const selectedMemberGoalCount = selectedMemberGoals.length
  const selectedMemberAcquiredSkillCount = selectedMemberSkills.filter((x) => x.current > 0).length

  const gradeRows = useMemo(() => {
    const order = ['G6', 'G5', 'G4', 'G3', 'G2', 'G1']
    const toneMap = { G6: 'gold', G5: 'orange', G4: 'blue', G3: 'green', G2: 'purple', G1: 'gray' }
    const counts = Object.fromEntries(order.map((g) => [g, 0]))
    for (const row of directoryRows) {
      if (counts[row.grade] !== undefined) counts[row.grade] += 1
    }
    const total = directoryRows.length || 1
    return order.map((badge) => ({
      badge,
      label: badge,
      count: counts[badge],
      percent: total ? (counts[badge] / total) * 100 : 0,
      tone: toneMap[badge],
      barTone: toneMap[badge],
    }))
  }, [directoryRows])

  const averageGradeLabel = useMemo(() => {
    const gradeToNum = (g) => {
      const m = /^G(\d)$/.exec(g)
      return m ? Number(m[1]) : null
    }
    const values = directoryRows.map((r) => gradeToNum(r.grade)).filter((v) => v != null)
    if (!values.length) return '—'
    const avg = values.reduce((a, b) => a + b, 0) / values.length
    return `G${avg.toFixed(1)}`
  }, [directoryRows])

  const totalCount = directoryRows.length
  const stagnationAlerts = useMemo(() => {
    const nowMs = Date.now()
    const threeMonthsMs = 1000 * 60 * 60 * 24 * 90
    const hasEvalScore = (evalRows) =>
      Array.isArray(evalRows) &&
      evalRows.some((item) => {
        const score = Number(item?.score ?? 0)
        return Number.isFinite(score) && score > 0
      })

    return directoryRows
      .map((row) => {
        const lastUpdatedRaw = skillProgressUpdatedAtByEmployee?.[row.id]
        const lastUpdatedMs = lastUpdatedRaw ? Date.parse(lastUpdatedRaw) : Number.NaN
        const hasSkillUpdateDate = Number.isFinite(lastUpdatedMs)
        const isSkillStagnated = !hasSkillUpdateDate || nowMs - lastUpdatedMs >= threeMonthsMs

        const selfDone = hasEvalScore(selfEvalByEmployee?.[row.id])
        const supervisorDone = hasEvalScore(supervisorEvalByEmployee?.[row.id])
        const execData = executiveEvalByEmployee?.[row.id]
        const executiveDone = !!(
          execData &&
          (Number(execData.baseScore ?? 0) > 0 || (Array.isArray(execData.commentHistory) && execData.commentHistory.length > 0))
        )

        const tags = []
        if (isSkillStagnated) tags.push('スキル更新停滞(3か月以上)')
        if (!selfDone) tags.push('自己評価未実施')
        if (!supervisorDone) tags.push('上司評価未実施')
        if (!executiveDone) tags.push('経営層評価未実施')
        if (!tags.length) return null

        return {
          id: row.id,
          name: row.name,
          dept: row.dept,
          tags,
        }
      })
      .filter(Boolean)
  }, [
    directoryRows,
    skillProgressUpdatedAtByEmployee,
    selfEvalByEmployee,
    supervisorEvalByEmployee,
    executiveEvalByEmployee,
  ])

  return (
    <section className="adminMock">
      <div className="adminMain only">
        <section className="adminOverview">
          <header className="adminHeader">
            <h2>管理者ダッシュボード</h2>
            <p>従業員のスキル状況を管理し、成長をサポートします</p>
          </header>

          <section className="stagnationAlert">
            <h3>⚠ スキルアップ停滞アラート</h3>
            <p>
              3か月以上スキル更新がない従業員、または評価（自己・上司・経営層）が未実施の従業員を表示しています。
            </p>
            {stagnationAlerts.length ? (
              stagnationAlerts.map((alert) => (
                <article className="stagnationCard" key={alert.id}>
                  <h4>{alert.name}</h4>
                  <span>{alert.dept}</span>
                  <div className="statusTags">
                    {alert.tags.map((tag) => (
                      <em key={tag}>{tag}</em>
                    ))}
                  </div>
                </article>
              ))
            ) : (
              <article className="stagnationCard">
                <h4>要注意者はいません</h4>
                <span>全員が最新状態です</span>
              </article>
            )}
          </section>

          <div className="summaryCards">
            <article>
              <p>総従業員数</p>
              <strong>{totalCount}</strong>
            </article>
            <article>
              <p>登録スキル数</p>
              <strong className="green">15</strong>
            </article>
            <article>
              <p>要注意者</p>
              <strong className="red">{stagnationAlerts.length}</strong>
            </article>
          </div>
        </section>

        <section className="adminPanel">
          <header className="listHeader">
            <h3>従業員一覧</h3>
            <span>
              {totalCount}人 / {totalCount}人
            </span>
          </header>
          <div className="filters">
            <input type="text" placeholder="名前で検索..." />
            <select>
              <option>全部署</option>
            </select>
            <select>
              <option>全等級</option>
            </select>
            <select>
              <option>全従業員</option>
            </select>
          </div>
          <div className="memberTable">
            <div className="row head">
              <span>名前</span>
              <span>部署</span>
              <span>等級</span>
              <span>★数</span>
            </div>
            {memberRows.map((member) => (
              <div className="row" key={member.id}>
                <span>
                  <button
                    type="button"
                    className={`memberNameButton ${selectedMemberId === member.id ? 'isActive' : ''}`}
                    onClick={() => {
                      setSelectedMemberId(member.id)
                      onSelectMember?.(member.id)
                    }}
                  >
                    {member.name}
                  </button>
                </span>
                <span>{member.dept}</span>
                <span>{member.grade}</span>
                <span className="stars">★ {member.stars}</span>
              </div>
            ))}
          </div>
          {selectedMember ? (
            <section className="memberDetailWorkspace">
              <header className="memberDetailHero">
                <div className="memberDetailHeroTop">
                  <div className="memberDetailAvatar" aria-hidden>
                    👤
                  </div>
                  <div>
                    <h4>{selectedMember.name}</h4>
                    <p>{selectedMember.dept}</p>
                    <small>入社日: {selectedMember.joinDate || '―'}</small>
                  </div>
                  <strong className="memberDetailStar">★ {selectedMember.stars}</strong>
                </div>
                <div className="memberDetailMetricGrid">
                  <article>
                    <span>現在の等級</span>
                    <strong>{selectedMember.grade}</strong>
                  </article>
                  <article>
                    <span>獲得★数</span>
                    <strong>{selectedMember.stars}★</strong>
                  </article>
                  <article>
                    <span>習得スキル</span>
                    <strong>{selectedMemberAcquiredSkillCount}</strong>
                  </article>
                </div>
                <div className="memberDetailActions">
                  <button
                    type="button"
                    onClick={() => {
                      if (!selectedMember) return
                      onStartSupervisorEval?.(selectedMember.id)
                    }}
                  >
                    ☑ 上司評価を実施
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      if (!selectedMember) return
                      onStartExecutiveEval?.(selectedMember.id)
                    }}
                  >
                    ★ 経営層評価を実施
                  </button>
                </div>
              </header>

              <div className="memberDetailTabs">
                <button
                  type="button"
                  className={detailTab === 'skill' ? 'isActive' : ''}
                  onClick={() => {
                    setDetailTab('skill')
                    onChangeDetailTab?.('skill')
                  }}
                >
                  スキル習得状況
                </button>
                <button
                  type="button"
                  className={detailTab === 'self' ? 'isActive' : ''}
                  onClick={() => {
                    setDetailTab('self')
                    onChangeDetailTab?.('self')
                  }}
                >
                  自己評価
                </button>
                <button
                  type="button"
                  className={detailTab === 'boss' ? 'isActive' : ''}
                  onClick={() => {
                    setDetailTab('boss')
                    onChangeDetailTab?.('boss')
                  }}
                >
                  上司評価
                </button>
                <button
                  type="button"
                  className={detailTab === 'goal' ? 'isActive' : ''}
                  onClick={() => {
                    setDetailTab('goal')
                    onChangeDetailTab?.('goal')
                  }}
                >
                  目標管理
                </button>
              </div>

              <div className="memberDetailTabPanel">
                {detailTab === 'skill' ? (
                  selectedMemberSkills.length ? (
                    <ul className="memberSkillList">
                      {selectedMemberSkills.map((s) => (
                        <li key={s.id}>
                          <p className="memberSkillTitle">{s.title}</p>
                          <p className="memberSkillMeta">
                            {s.required ? '必須' : '任意'} / Lv.{s.current}/{s.max}
                          </p>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="memberDetailEmpty">この等級のスキル設定がありません。</p>
                  )
                ) : null}
                {detailTab === 'self' ? (
                  selectedMemberSelfEvalRows.length ? (
                    <ul className="memberEvalList">
                      {selectedMemberSelfEvalRows.map((row) => (
                        <li key={row.id} className="memberEvalItem">
                          <div className="memberEvalHead">
                            <p className="memberEvalTitle">{row.title}</p>
                            <span className="memberEvalScore">{row.score}点</span>
                          </div>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="memberDetailEmpty">自己評価の入力はまだありません。</p>
                  )
                ) : null}
                {detailTab === 'boss' ? (
                  selectedMemberBossEvalRows.length ? (
                    <ul className="memberEvalList">
                      {selectedMemberBossEvalRows.map((row) => (
                        <li key={row.id} className="memberEvalItem">
                          <div className="memberEvalHead">
                            <p className="memberEvalTitle">{row.title}</p>
                            <span className="memberEvalScore">{row.score ? `${row.score}点` : '未入力'}</span>
                          </div>
                          {row.comment ? <p className="memberEvalComment">{row.comment}</p> : null}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="memberDetailEmpty">上司評価の入力はまだありません。</p>
                  )
                ) : null}
                {detailTab === 'goal' ? (
                  selectedMemberGoalCount > 0 ? (
                    <ul className="memberGoalList">
                      {selectedMemberGoals.map((goal) => (
                        <li key={goal.id} className="memberGoalItem">
                          <div className="memberGoalHead">
                            <p className={goal.achieved ? 'memberGoalTitle isDone' : 'memberGoalTitle'}>{goal.title}</p>
                            <span className={`memberGoalStatus${goal.achieved ? ' isDone' : ''}`}>
                              {goal.achieved ? '達成済み' : '進行中'}
                            </span>
                          </div>
                          <p className="memberGoalDeadline">期日: {goal.deadline || '―'}</p>
                          <p className="memberGoalDetail">{goal.detail || '（詳細なし）'}</p>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="memberDetailEmpty">登録目標はありません。</p>
                  )
                ) : null}
              </div>
            </section>
          ) : null}
        </section>

        <section className="adminPanel">
          <header className="listHeader">
            <h3>等級別人数分布</h3>
          </header>
          <div className="gradeDistribution">
            {gradeRows.map((row, index) => (
              <article className="gradeRow" key={`${row.label}-${index}`}>
                <div className="gradeMeta">
                  <span className={`gradeBadge ${row.tone}`}>{row.badge}</span>
                  <span className="gradeLabel">{row.label}</span>
                  <span className="gradeCount">
                    {row.count}人 <small>({row.percent.toFixed(1)}%)</small>
                  </span>
                </div>
                <div className="gradeBar">
                  <span className={`barTone ${row.barTone}`} style={{ width: `${row.percent}%` }} />
                </div>
              </article>
            ))}
          </div>
          <div className="gradeSummary">
            <p>
              総従業員数: <strong>{totalCount}</strong>
            </p>
            <p>
              平均等級: <strong>{averageGradeLabel}</strong>
            </p>
          </div>
        </section>
      </div>
    </section>
  )
}

function EmployeeManagePage({
  rows,
  setRows,
  skills,
  skillProgress,
  selfEvalByEmployee,
  supervisorEvalByEmployee,
  executiveEvalByEmployee,
}) {
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false)
  const [isEditModalOpen, setIsEditModalOpen] = useState(false)
  const [editingRow, setEditingRow] = useState(null)
  const [newEmployee, setNewEmployee] = useState({
    id: '',
    name: '',
    dept: '製造',
    role: '一般従業員',
    grade: 'G1',
    password: '',
  })

  const handleCreateEmployee = (event) => {
    event.preventDefault()
    if (!newEmployee.id.trim() || !newEmployee.name.trim()) return

    setRows((prev) => [
      ...prev,
      {
        id: newEmployee.id.trim(),
        name: newEmployee.name.trim(),
        dept: newEmployee.dept,
        grade: newEmployee.grade,
        score: '0.0点',
        role: newEmployee.role,
        password: newEmployee.password,
      },
    ])
    setIsCreateModalOpen(false)
    setNewEmployee({
      id: '',
      name: '',
      dept: '製造',
      role: '一般従業員',
      grade: 'G1',
      password: '',
    })
  }

  const handleStartEdit = (row) => {
    setEditingRow({ ...row })
    setIsEditModalOpen(true)
  }

  const handleSaveEdit = (event) => {
    event.preventDefault()
    if (!editingRow) return

    const trimmedName = editingRow.name.trim()
    if (!trimmedName) return

    setRows((prev) => prev.map((row) => (row.id === editingRow.id ? { ...row, ...editingRow, name: trimmedName } : row)))
    setIsEditModalOpen(false)
    setEditingRow(null)
  }

  const handleDeleteRow = (rowId) => {
    const shouldDelete = window.confirm(
      'この従業員の行を削除しますか？\n\n「OK」で削除、「キャンセル」で中止します。',
    )
    if (!shouldDelete) return

    setRows((prev) => prev.filter((row) => row.id !== rowId))
    if (editingRow?.id === rowId) {
      setIsEditModalOpen(false)
      setEditingRow(null)
    }
  }

  const employeeCsvFileRef = useRef(null)
  const [directoryCsvMessage, setDirectoryCsvMessage] = useState('')

  const scoreByEmployeeId = useMemo(() => {
    const itemIds = SELF_EVAL_CATEGORIES.flatMap((c) => c.items.map((it) => it.id))
    const evalScoreTo100 = (evalMap, employeeId) => {
      const scores = evalMap?.[employeeId]?.scores ?? {}
      const values = itemIds
        .map((id) => Number(scores[id]))
        .filter((n) => Number.isFinite(n) && n >= 1 && n <= 5)
      if (!values.length) return 0
      const avg5 = values.reduce((a, b) => a + b, 0) / values.length
      return (avg5 / 5) * 100
    }
    const skillScoreTo100 = (employee) => {
      const gradeSkills = (skills ?? []).filter((s) => s.gradeId === employee.grade)
      if (!gradeSkills.length) return 0
      const prog = skillProgress?.[employee.id] ?? {}
      const ratioAvg =
        gradeSkills.reduce((sum, s) => {
          const cur = Math.max(0, Number(prog[s.id] ?? 0))
          const max = Math.max(1, Number(s.stages) || 1)
          return sum + Math.min(1, cur / max)
        }, 0) / gradeSkills.length
      return ratioAvg * 100
    }
    const executiveScoreTo100 = (employeeId) => {
      const ex = executiveEvalByEmployee?.[employeeId]
      if (!ex) return 0
      const base = Number(ex.baseScore ?? 0) || 0
      const commentTotal = Array.isArray(ex.commentHistory)
        ? ex.commentHistory.reduce((sum, row) => sum + (Number(row.delta) || 0), 0)
        : 0
      return Math.max(0, Math.min(100, base + commentTotal))
    }
    const out = {}
    for (const row of rows) {
      const skill100 = skillScoreTo100(row)
      const self100 = evalScoreTo100(selfEvalByEmployee, row.id)
      const supervisor100 = evalScoreTo100(supervisorEvalByEmployee, row.id)
      const executive100 = executiveScoreTo100(row.id)
      const total = skill100 * 0.3 + self100 * 0.15 + supervisor100 * 0.25 + executive100 * 0.3
      out[row.id] = `${total.toFixed(1)}点`
    }
    return out
  }, [rows, skills, skillProgress, selfEvalByEmployee, supervisorEvalByEmployee, executiveEvalByEmployee])

  const handleEmployeeExportCsv = () => {
    const headers = ['社員C', '名前', '部署', '等級', '総合得点', '役割']
    const body = rows.map((row) =>
      [
        escapeCsvField(row.id),
        escapeCsvField(row.name),
        escapeCsvField(row.dept),
        escapeCsvField(row.grade),
        escapeCsvField(scoreByEmployeeId[row.id] ?? '0.0点'),
        escapeCsvField(row.role),
      ].join(','),
    )
    const csvContent = [headers.join(','), ...body].join('\r\n')
    const bom = '\uFEFF'
    const blob = new Blob([bom + csvContent], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    const date = new Date().toISOString().slice(0, 10)
    link.href = url
    link.download = `employees_${date}.csv`
    link.click()
    URL.revokeObjectURL(url)
    setDirectoryCsvMessage(`${rows.length}件をCSVに出力しました。`)
  }

  const handleEmployeeImportCsv = async (event) => {
    const file = event.target.files?.[0]
    if (!file) return

    try {
      const content = await file.text()
      const lines = content
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line !== '')

      if (lines.length < 2) {
        setDirectoryCsvMessage('CSVにデータ行がありません。')
        return
      }

      const headers = parseCsvLine(lines[0])
      const idIdx = findHeaderIndex(headers, ['社員C', 'ID', 'id', '従業員ID'])
      const nameIdx = findHeaderIndex(headers, ['名前', '社員名'])
      const deptIdx = findHeaderIndex(headers, ['部署'])
      const gradeIdx = findHeaderIndex(headers, ['等級', 'グレード'])
      const scoreIdx = findHeaderIndex(headers, ['総合得点'])
      const roleIdx = findHeaderIndex(headers, ['役割'])

      if (nameIdx < 0) {
        setDirectoryCsvMessage('CSVヘッダーに「名前」または「社員名」列が必要です。')
        return
      }

      const imported = []
      let generated = 0
      const idBase = Date.now()
      for (let i = 1; i < lines.length; i++) {
        const cols = parseCsvLine(lines[i])
        const name = (cols[nameIdx] ?? '').trim()
        if (!name) continue

        let id = idIdx >= 0 ? (cols[idIdx] ?? '').trim() : ''
        if (!id) {
          id = `csv_${idBase}_${generated}`
          generated += 1
        }

        imported.push({
          id,
          name,
          dept: deptIdx >= 0 ? normalizeEmployeeDept(cols[deptIdx]) : '製造',
          grade: gradeIdx >= 0 ? normalizeEmployeeGrade(cols[gradeIdx]) : 'G1',
          score: scoreIdx >= 0 ? normalizeEmployeeDirectoryScore(cols[scoreIdx]) : '0.0点',
          role: roleIdx >= 0 ? normalizeEmployeeRole(cols[roleIdx]) : '一般従業員',
          password: '',
        })
      }

      if (imported.length === 0) {
        setDirectoryCsvMessage('取り込める行がありませんでした（名前は必須です）。')
        return
      }

      setRows((prev) => mergeEmployeeDirectoryRows(prev, imported))
      setDirectoryCsvMessage(
        `${imported.length}件を取り込みました（同一の社員Cは上書き、それ以外はそのまま残ります）。`,
      )
    } catch {
      setDirectoryCsvMessage('CSVの読み込みに失敗しました。形式を確認してください。')
    } finally {
      event.target.value = ''
    }
  }

  return (
    <section className="employeeManage">
      <header className="employeeHeader">
        <h2>従業員管理</h2>
        <p>従業員の登録・編集・削除を行います</p>
      </header>

      <div className="employeeToolbar">
        <div className="leftActions">
          <button type="button" className="btn export" onClick={handleEmployeeExportCsv}>
            CSVエクスポート
          </button>
          <button type="button" className="btn import" onClick={() => employeeCsvFileRef.current?.click()}>
            CSVインポート
          </button>
          <input
            ref={employeeCsvFileRef}
            type="file"
            accept=".csv,text/csv"
            className="employeeCsvHiddenInput"
            onChange={handleEmployeeImportCsv}
          />
        </div>
        <button className="btn add" onClick={() => setIsCreateModalOpen(true)}>
          + 新規従業員を追加
        </button>
      </div>

      {directoryCsvMessage ? <p className="employeeCsvMessage">{directoryCsvMessage}</p> : null}

      <div className="employeeTable">
        <div className="row head">
          <span>ID</span>
          <span>名前</span>
          <span>部署</span>
          <span>等級</span>
          <span>総合得点</span>
          <span>役割</span>
          <span>パスワード</span>
          <span>操作</span>
        </div>
        {rows.map((row) => (
          <div className="row" key={row.id}>
            <span>{row.id}</span>
            <span>{row.name}</span>
            <span>{row.dept}</span>
            <span className="grade">{row.grade}</span>
            <span className="score">{scoreByEmployeeId[row.id] ?? '0.0点'}</span>
            <span>
              <em className="roleTag">{row.role}</em>
            </span>
            <span className="passwordCell">
              <span className="passwordText">********</span>
            </span>
            <span className="actions">
              <button type="button" className="actionIcon" onClick={() => handleStartEdit(row)} aria-label="編集">
                ✎
              </button>
              <button
                type="button"
                className="delete"
                title="削除（確認のあと実行）"
                onClick={() => handleDeleteRow(row.id)}
                aria-label="削除"
              >
                🗑
              </button>
            </span>
          </div>
        ))}
      </div>
      {isCreateModalOpen ? (
        <div className="employeeModalOverlay" onClick={() => setIsCreateModalOpen(false)}>
          <div className="employeeModal" onClick={(event) => event.stopPropagation()}>
            <button className="modalClose" type="button" onClick={() => setIsCreateModalOpen(false)}>
              ×
            </button>
            <h3>新規従業員を追加</h3>
            <p>従業員の基本情報とログイン情報を入力してください。</p>

            <form className="employeeForm" onSubmit={handleCreateEmployee}>
              <label>
                社員C *
                <input
                  type="text"
                  placeholder="例: 0001"
                  value={newEmployee.id}
                  onChange={(event) => setNewEmployee((prev) => ({ ...prev, id: event.target.value }))}
                  required
                />
                <small>ログイン時に使用します（編集不可）</small>
              </label>

              <label>
                名前 *
                <input
                  type="text"
                  placeholder="例: 山田 太郎"
                  value={newEmployee.name}
                  onChange={(event) => setNewEmployee((prev) => ({ ...prev, name: event.target.value }))}
                  required
                />
              </label>

              <label>
                部署 *
                <select
                  value={newEmployee.dept}
                  onChange={(event) => setNewEmployee((prev) => ({ ...prev, dept: event.target.value }))}
                >
                  <option>製造</option>
                  <option>営業</option>
                  <option>品質</option>
                </select>
              </label>

              <label>
                役割 *
                <select
                  value={newEmployee.role}
                  onChange={(event) => setNewEmployee((prev) => ({ ...prev, role: event.target.value }))}
                >
                  <option>一般従業員</option>
                  <option>上司</option>
                  <option>管理者</option>
                </select>
              </label>

              <label>
                グレード *
                <select
                  value={newEmployee.grade}
                  onChange={(event) => setNewEmployee((prev) => ({ ...prev, grade: event.target.value }))}
                >
                  <option value="G1">G1</option>
                  <option value="G2">G2</option>
                  <option value="G3">G3</option>
                  <option value="G4">G4</option>
                  <option value="G5">G5</option>
                  <option value="G6">G6</option>
                </select>
                <small>従業員のグレードを設定します</small>
              </label>

              <label>
                パスワード *
                <input
                  type="password"
                  placeholder="パスワードを入力"
                  value={newEmployee.password}
                  onChange={(event) => setNewEmployee((prev) => ({ ...prev, password: event.target.value }))}
                  required
                />
                <small>ログイン時に使用します</small>
              </label>

              <div className="modalActions">
                <button type="button" className="cancel" onClick={() => setIsCreateModalOpen(false)}>
                  キャンセル
                </button>
                <button type="submit" className="submit">
                  追加
                </button>
              </div>
            </form>
          </div>
        </div>
      ) : null}
      {isEditModalOpen && editingRow ? (
        <div className="employeeModalOverlay" onClick={() => setIsEditModalOpen(false)}>
          <div className="employeeModal" onClick={(event) => event.stopPropagation()}>
            <button className="modalClose" type="button" onClick={() => setIsEditModalOpen(false)}>
              ×
            </button>
            <h3>従業員情報を編集</h3>
            <p>内容を更新して保存してください。</p>

            <form className="employeeForm" onSubmit={handleSaveEdit}>
              <label>
                社員C
                <input type="text" value={editingRow.id} disabled />
              </label>

              <label>
                名前 *
                <input
                  type="text"
                  value={editingRow.name}
                  onChange={(event) => setEditingRow((prev) => ({ ...prev, name: event.target.value }))}
                  required
                />
              </label>

              <label>
                部署 *
                <select
                  value={editingRow.dept}
                  onChange={(event) => setEditingRow((prev) => ({ ...prev, dept: event.target.value }))}
                >
                  <option>製造</option>
                  <option>営業</option>
                  <option>品質</option>
                </select>
              </label>

              <label>
                役割 *
                <select
                  value={editingRow.role}
                  onChange={(event) => setEditingRow((prev) => ({ ...prev, role: event.target.value }))}
                >
                  <option>一般従業員</option>
                  <option>上司</option>
                  <option>管理者</option>
                </select>
              </label>

              <label>
                グレード *
                <select
                  value={editingRow.grade}
                  onChange={(event) => setEditingRow((prev) => ({ ...prev, grade: event.target.value }))}
                >
                  <option value="G1">G1</option>
                  <option value="G2">G2</option>
                  <option value="G3">G3</option>
                  <option value="G4">G4</option>
                  <option value="G5">G5</option>
                  <option value="G6">G6</option>
                </select>
              </label>

              <label>
                パスワード *
                <input
                  type="password"
                  placeholder="パスワードを入力"
                  value={editingRow.password ?? ''}
                  onChange={(event) => setEditingRow((prev) => ({ ...prev, password: event.target.value }))}
                  required
                />
                <small>ログイン時に使用します</small>
              </label>

              <div className="modalActions">
                <button
                  type="button"
                  className="cancel"
                  onClick={() => {
                    setIsEditModalOpen(false)
                    setEditingRow(null)
                  }}
                >
                  キャンセル
                </button>
                <button type="submit" className="submit">
                  保存
                </button>
              </div>
            </form>
          </div>
        </div>
      ) : null}
    </section>
  )
}

export default App
