import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
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
  adjustment: '',
  specialAllowance: '',
  note: '',
})

const GYOSEKI_CSV_COLUMNS = [
  { key: 'employeeNo', label: '社員番号', value: (row) => row.employeeNo },
  { key: 'employeeName', label: '社員名', value: (row) => row.employeeName },
  { key: 'photo', label: '顔写真', value: (row) => (row.photoDataUrl ? '登録済み' : '') },
  { key: 'team', label: '区分', value: (row) => (row.team === 'ck' ? 'CK' : 'デンチャー') },
  { key: 'grade', label: '等級', value: (row) => row.grade },
  { key: 'score', label: '評価スコア', value: (row) => row.score },
  { key: 'performanceAllowance', label: '業績手当', value: (row) => row.performanceAllowance },
  { key: 'adjustment', label: '調整', value: (row) => row.adjustment ?? '' },
  { key: 'specialAllowance', label: '特別手当', value: (row) => row.specialAllowance },
  { key: 'thirdBonus', label: '第3回目賞与', value: (row) => row.thirdBonus },
  { key: 'note', label: '備考欄', value: (row) => row.note },
]

const STORAGE_KEY = 'performanceAllowanceAppData'
const CLOUD_STATE_ID = 'default'
const CLOUD_SYNC_INTERVAL_MS = 120000
const EMPLOYEE_DIRECTORY_SYNC_DEBOUNCE_MS = 1500
/** 自己評価・上司評価・目標管理の「提出取り消し」は評価期ごとにこの回数まで */
const MAX_EVAL_SUBMISSION_WITHDRAWALS = 3

function clampEvalSubmissionWithdrawalsUsed(raw) {
  const n = Math.trunc(Number(raw))
  if (!Number.isFinite(n) || n < 0) return 0
  return Math.min(MAX_EVAL_SUBMISSION_WITHDRAWALS, n)
}

const getCurrentPeriod = () => new Date().toISOString().slice(0, 7)
function evalPeriodAnchorMs(key) {
  const s = String(key ?? '').trim()
  const legacy = /^(\d{4})-H([12])$/i.exec(s)
  if (legacy) {
    const y = Number(legacy[1])
    const half = Number(legacy[2])
    const d = new Date(y, half === 1 ? 0 : 6, 1)
    d.setHours(0, 0, 0, 0)
    return d.getTime()
  }
  const mon = /^(\d{4})-(\d{1,2})$/.exec(s)
  if (mon) {
    const y = Number(mon[1])
    const m = Math.min(12, Math.max(1, Number(mon[2])))
    const d = new Date(y, m - 1, 1)
    d.setHours(0, 0, 0, 0)
    return d.getTime()
  }
  return NaN
}

function evalPeriodSortKey(key) {
  const ms = evalPeriodAnchorMs(key)
  if (Number.isFinite(ms)) {
    const d = new Date(ms)
    return d.getFullYear() * 12 + d.getMonth()
  }
  return Number.NEGATIVE_INFINITY
}

function compareEvalPeriodDesc(a, b) {
  const ka = evalPeriodSortKey(a)
  const kb = evalPeriodSortKey(b)
  if (ka !== kb) return kb - ka
  return String(b).localeCompare(String(a))
}

function buildDefaultMarSepEvalPeriods() {
  const y0 = new Date().getFullYear()
  const list = []
  for (let d = -1; d <= 2; d++) {
    const y = y0 + d
    list.push({ key: `${y}-03`, label: `${y}年3月期` })
    list.push({ key: `${y}-09`, label: `${y}年9月期` })
  }
  list.sort((x, y) => compareEvalPeriodDesc(x.key, y.key))
  return list
}

function parseCommaSeparatedEmployeeIds(text) {
  const s = String(text ?? '').trim()
  if (!s) return []
  return [...new Set(s.split(/[,，\s]+/).map((x) => x.trim()).filter(Boolean))]
}

function parseOnlyForEmployeeIdsFromStored(row) {
  const raw = row?.onlyForEmployeeIds ?? row?.employeeIds
  if (Array.isArray(raw)) {
    return [...new Set(raw.map((id) => String(id ?? '').trim()).filter(Boolean))]
  }
  if (typeof raw === 'string' && raw.trim()) {
    return parseCommaSeparatedEmployeeIds(raw)
  }
  return []
}

function normalizeDeadlineDate(value) {
  const s = String(value ?? '').trim()
  if (!s) return ''
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/)
  if (m) return `${m[1]}-${m[2]}-${m[3]}`
  const ms = new Date(s).getTime()
  if (!Number.isFinite(ms)) return ''
  const d = new Date(ms)
  const y = d.getFullYear()
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${y}-${mm}-${dd}`
}

function deadlineStartMs(value) {
  const s = normalizeDeadlineDate(value)
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (!m) return Number.NaN
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 0, 0, 0, 0).getTime()
}

function isSelfEvalDeadlineLockedForPeriod(evalPeriodDefinitions, periodKey) {
  const pk = String(periodKey ?? '').trim()
  if (!pk) return false
  const row = (evalPeriodDefinitions ?? []).find((d) => String(d?.key ?? '').trim() === pk)
  const at = normalizeDeadlineDate(row?.selfEvalDeadlineAt)
  return Number.isFinite(deadlineStartMs(at)) ? Date.now() >= deadlineStartMs(at) : false
}

function isSupervisorEvalDeadlineLockedForPeriod(evalPeriodDefinitions, periodKey) {
  const pk = String(periodKey ?? '').trim()
  if (!pk) return false
  const row = (evalPeriodDefinitions ?? []).find((d) => String(d?.key ?? '').trim() === pk)
  const at = normalizeDeadlineDate(row?.supervisorEvalDeadlineAt)
  return Number.isFinite(deadlineStartMs(at)) ? Date.now() >= deadlineStartMs(at) : false
}

function normalizeEvalPeriodDefinitionRow(row) {
  const key = String(row?.key ?? '').trim()
  if (!key) return null
  const label = String(row?.label ?? '').trim() || key
  const onlyForEmployeeIds = parseOnlyForEmployeeIdsFromStored(row)
  const selfEvalDeadlineAt = normalizeDeadlineDate(row?.selfEvalDeadlineAt)
  const supervisorEvalDeadlineAt = normalizeDeadlineDate(row?.supervisorEvalDeadlineAt)
  const executiveEvalDeadlineAt = normalizeDeadlineDate(row?.executiveEvalDeadlineAt)
  const next = { key, label }
  if (onlyForEmployeeIds.length) next.onlyForEmployeeIds = onlyForEmployeeIds
  if (selfEvalDeadlineAt) next.selfEvalDeadlineAt = selfEvalDeadlineAt
  if (supervisorEvalDeadlineAt) next.supervisorEvalDeadlineAt = supervisorEvalDeadlineAt
  if (executiveEvalDeadlineAt) next.executiveEvalDeadlineAt = executiveEvalDeadlineAt
  return next
}

function parseEvalPeriodDefinitionList(raw) {
  if (!Array.isArray(raw)) return []
  const out = raw.map(normalizeEvalPeriodDefinitionRow).filter(Boolean)
  const seen = new Set()
  return out.filter((row) => {
    if (seen.has(row.key)) return false
    seen.add(row.key)
    return true
  })
}

function normalizeEvalPeriodDefinitions(raw) {
  const parsed = parseEvalPeriodDefinitionList(raw)
  if (parsed.length) return parsed
  return []
}

function mergeEvalPeriodDefinitionArrays(prevRaw, remoteRaw) {
  const prev = parseEvalPeriodDefinitionList(prevRaw)
  const remote = parseEvalPeriodDefinitionList(remoteRaw)
  const map = new Map()
  for (const row of prev) map.set(row.key, { ...row })
  for (const row of remote) {
    const cur = map.get(row.key)
    if (!cur) {
      map.set(row.key, { ...row })
      continue
    }
    const ids = [...new Set([...(cur.onlyForEmployeeIds ?? []), ...(row.onlyForEmployeeIds ?? [])])]
    const next = { ...cur, label: cur.label || row.label || cur.key }
    if (ids.length) next.onlyForEmployeeIds = ids
    else delete next.onlyForEmployeeIds
    const mergedSelfDeadline = normalizeDeadlineDate(cur.selfEvalDeadlineAt ?? row.selfEvalDeadlineAt)
    if (mergedSelfDeadline) next.selfEvalDeadlineAt = mergedSelfDeadline
    else delete next.selfEvalDeadlineAt
    const mergedSupervisorDeadline = normalizeDeadlineDate(cur.supervisorEvalDeadlineAt ?? row.supervisorEvalDeadlineAt)
    if (mergedSupervisorDeadline) next.supervisorEvalDeadlineAt = mergedSupervisorDeadline
    else delete next.supervisorEvalDeadlineAt
    const mergedExecutiveDeadline = normalizeDeadlineDate(cur.executiveEvalDeadlineAt ?? row.executiveEvalDeadlineAt)
    if (mergedExecutiveDeadline) next.executiveEvalDeadlineAt = mergedExecutiveDeadline
    else delete next.executiveEvalDeadlineAt
    map.set(row.key, next)
  }
  return [...map.values()].sort((a, b) => compareEvalPeriodDesc(a.key, b.key))
}

function pickRadarPeriodKeys({ activeKey, selfHist, bossHist, execHist, definitions, limit = 3 }) {
  const active = String(activeKey ?? '').trim()
  const selfKeys = Object.keys(selfHist ?? {})
  const bossKeys = Object.keys(bossHist ?? {})
  const execKeys = Object.keys(execHist ?? {}).filter((k) => k !== 'cumulative')
  const available = new Set([...selfKeys, ...bossKeys, ...execKeys, active].filter(Boolean))
  if (!available.size) return []

  const preferredOrder = (definitions ?? [])
    .map((d) => String(d?.key ?? '').trim())
    .filter((k) => k && available.has(k))
  const preferredSet = new Set(preferredOrder)
  const rest = [...available]
    .filter((k) => !preferredSet.has(k))
    .sort(compareEvalPeriodDesc)
  const maxLen = Math.max(1, Number(limit) || 3)
  const ordered = [...preferredOrder, ...rest]
  const sliced = ordered.slice(0, maxLen)
  if (!active || !available.has(active) || sliced.includes(active)) return sliced
  if (sliced.length < maxLen) return [...sliced, active]
  // Keep display count fixed, but always include selected period.
  return [...sliced.slice(0, Math.max(0, maxLen - 1)), active]
}

function getSuggestedEvalPeriodKey(definitions) {
  const all = definitions?.length ? definitions : []
  const globalLike = all.filter((d) => !d.onlyForEmployeeIds?.length)
  const defs = globalLike.length ? globalLike : all
  const keys = defs.map((d) => String(d.key ?? '').trim()).filter(Boolean)
  if (!keys.length) {
    return ''
  }
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const todayMs = today.getTime()
  let bestKey = keys[0]
  let bestMs = Number.NEGATIVE_INFINITY
  let futureKey = null
  let futureMs = Number.POSITIVE_INFINITY
  for (const key of keys) {
    const ms = evalPeriodAnchorMs(key)
    if (!Number.isFinite(ms)) continue
    if (ms <= todayMs && ms >= bestMs) {
      bestMs = ms
      bestKey = key
    }
    if (ms > todayMs && ms < futureMs) {
      futureMs = ms
      futureKey = key
    }
  }
  if (Number.isFinite(bestMs) && bestMs > Number.NEGATIVE_INFINITY) return bestKey
  if (futureKey) return futureKey
  return [...keys].sort(compareEvalPeriodDesc)[0]
}

function readInitialEvalPeriodStateFromSavedData(sd) {
  const defs = normalizeEvalPeriodDefinitions(sd?.evalPeriodDefinitions)
  const saved = sd?.activeEvalPeriodKey
  const active =
    typeof saved === 'string' && saved.trim() ? saved.trim() : getSuggestedEvalPeriodKey(defs)
  return { defs, active }
}

function buildEvalPeriodSelectOptionList({
  definitions,
  selfEvalHistoryByEmployee,
  supervisorEvalHistoryByEmployee,
  extraPeriods,
  forEmployeeId,
}) {
  const fid = String(forEmployeeId ?? '').trim()
  const fromDefs = (definitions ?? [])
    .filter((d) => {
      const ids = d.onlyForEmployeeIds
      if (!Array.isArray(ids) || !ids.length) return true
      if (!fid) return false
      return ids.some((id) => String(id ?? '').trim() === fid)
    })
    .map((d) => {
      const restricted = Array.isArray(d.onlyForEmployeeIds) && d.onlyForEmployeeIds.length > 0
      const base = String(d.label ?? d.key ?? '').trim() || String(d.key)
      return {
        value: String(d.key ?? '').trim(),
        label: restricted ? `${base}（指定社員のみ）` : base,
      }
    })
    .filter((o) => o.value)
  const seen = new Set(fromDefs.map((o) => o.value))
  const tail = []
  const addKey = (k, suffix) => {
    const v = String(k ?? '').trim()
    if (!v || seen.has(v)) return
    seen.add(v)
    tail.push({ value: v, label: suffix ? `${v}（${suffix}）` : v })
  }
  const scan = (hist, suffix) => {
    if (!hist || typeof hist !== 'object' || Array.isArray(hist)) return
    if (!fid) return
    const key = Object.keys(hist).find((k) => String(k ?? '').trim() === fid)
    if (!key) return
    const periods = hist[key]
    if (!periods || typeof periods !== 'object' || Array.isArray(periods)) return
    Object.keys(periods).forEach((pk) => addKey(pk, suffix))
  }
  scan(selfEvalHistoryByEmployee, '履歴')
  scan(supervisorEvalHistoryByEmployee, '履歴')
  for (const row of extraPeriods ?? []) {
    if (!row?.key || seen.has(row.key)) continue
    seen.add(row.key)
    tail.push({
      value: row.key,
      label: row.label ? `${row.label}（この人のみ）` : `${row.key}（この人のみ）`,
    })
  }
  // Keep master order as-is; append non-master periods from history/extra after it.
  const tailSorted = [...tail].sort((a, b) => compareEvalPeriodDesc(a.value, b.value))
  return [...fromDefs, ...tailSorted]
}

function pruneEvalHistoryMapByAllowedKeys(historyMap, allowedKeySet) {
  if (!historyMap || typeof historyMap !== 'object' || Array.isArray(historyMap)) return { next: {}, removed: 0 }
  const next = {}
  let removed = 0
  for (const [employeeId, periods] of Object.entries(historyMap)) {
    if (!periods || typeof periods !== 'object' || Array.isArray(periods)) continue
    const kept = {}
    for (const [periodKey, value] of Object.entries(periods)) {
      const pk = String(periodKey ?? '').trim()
      if (allowedKeySet.has(pk)) {
        kept[pk] = value
      } else {
        removed += 1
      }
    }
    if (Object.keys(kept).length > 0) next[employeeId] = kept
  }
  return { next, removed }
}

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

/** 従業員管理 CSV の1行目。パスワード列あり（セル空なら既存パスワードを維持）。 */
const EMPLOYEE_DIRECTORY_CSV_HEADERS = ['社員C', '名前', '部署', '等級', '総合得点', '役割', 'パスワード']

/** 退職扱い: 社員C を「退職」または「退職_…」にした行（例: 退職_e1） */
function isEmployeeDirectoryRetired(row) {
  const id = String(row?.id ?? '').trim()
  if (!id) return false
  return id === '退職' || id.startsWith('退職')
}

/** 等級分布・平均等級・総従業員数（分布内）の集計に含める行（退職者・役員を除く） */
function isDirectoryRowCountedForGradeStats(row) {
  if (isEmployeeDirectoryRetired(row)) return false
  if (String(row?.role ?? '').trim() === '役員') return false
  return true
}

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

const DEFAULT_EMPLOYEE_DEPTS = ['製造', '営業', '品質']
const EMPLOYEE_ROLE_OPTIONS = ['一般従業員', '上司', '役員', '管理者']

function normalizeEmployeeDeptOptions(raw) {
  const seen = new Set()
  const out = []
  if (Array.isArray(raw)) {
    for (const x of raw) {
      const v = String(x ?? '').trim()
      if (!v || seen.has(v)) continue
      seen.add(v)
      out.push(v)
    }
  }
  if (out.length === 0) return [...DEFAULT_EMPLOYEE_DEPTS]
  return out
}

function mergeEmployeeDeptOptionsFromRows(savedOptions, rows) {
  const base = normalizeEmployeeDeptOptions(savedOptions)
  const seen = new Set(base)
  const out = [...base]
  for (const row of rows || []) {
    const d = String(row?.dept ?? '').trim()
    if (d && !seen.has(d)) {
      seen.add(d)
      out.push(d)
    }
  }
  return out
}

function normalizeEmployeeDept(value, deptOptions) {
  const v = String(value ?? '').trim()
  const list = Array.isArray(deptOptions) && deptOptions.length > 0 ? deptOptions : DEFAULT_EMPLOYEE_DEPTS
  return list.includes(v) ? v : (list[0] ?? '製造')
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

function normalizeEmployeeNoLinkKey(value) {
  const raw = String(value ?? '')
  if (!raw) return ''
  const half = raw.replace(/[０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
  const compact = half.replace(/\s+/g, '').trim()
  if (!compact) return ''
  if (/^\d+$/.test(compact)) return String(Number(compact))
  return compact
}

function formatLoginLikeCode(value) {
  const v = String(value ?? '').trim()
  if (!v) return ''
  if (/^\d+$/.test(v)) return v.padStart(4, '0')
  return v
}

function normalizeEmployeeExtraMenuKeys(value) {
  if (!Array.isArray(value)) return []
  const allowed = new Set(MAIN_WORKSPACE_TAB_ORDER.map((tab) => tab.key))
  return [...new Set(value.map((k) => String(k)).filter((k) => allowed.has(k)))]
}

function normalizeExtraEvalPeriodsForEmployee(row) {
  const raw = row?.extraEvalPeriods
  if (!Array.isArray(raw)) return []
  const out = []
  const seen = new Set()
  for (const item of raw) {
    const key = String(item?.key ?? '').trim()
    if (!key || !/^[\w.-]+$/.test(key)) continue
    if (seen.has(key)) continue
    seen.add(key)
    const label = String(item?.label ?? '').trim() || key
    out.push({ key, label })
  }
  return out.sort((a, b) => compareEvalPeriodDesc(a.key, b.key))
}

function normalizeEmployeeDirectoryRows(rows) {
  if (!Array.isArray(rows)) return []
  return rows.map((row) => ({
    ...row,
    extraMenuKeys: normalizeEmployeeExtraMenuKeys(row?.extraMenuKeys),
    extraEvalPeriods: normalizeExtraEvalPeriodsForEmployee(row),
  }))
}

function stripSensitiveEmployeeFields(rows) {
  if (!Array.isArray(rows)) return []
  return rows.map((row) => ({ ...row, password: '' }))
}

/** CSV 等で「列はあるが空欄」のときはキーを付けず、既存行の値を維持する */
const EMPLOYEE_DIRECTORY_MERGE_KEYS = [
  'name',
  'dept',
  'grade',
  'score',
  'role',
  'joinDate',
  'email',
  'extraMenuKeys',
]

function mergeEmployeeDirectoryRows(prev, imported) {
  const mapImport = new Map(imported.map((r) => [String(r.id), r]))
  const seen = new Set()
  const merged = []
  const employeeIdsToClearSkillProgress = []
  for (const row of prev) {
    const imp = mapImport.get(String(row.id))
    if (imp) {
      const next = { ...row }
      for (const k of EMPLOYEE_DIRECTORY_MERGE_KEYS) {
        if (Object.prototype.hasOwnProperty.call(imp, k)) {
          next[k] = imp[k]
        }
      }
      const nextPassword =
        Object.prototype.hasOwnProperty.call(imp, 'password') && String(imp.password ?? '').trim()
          ? String(imp.password).trim()
          : (row.password ?? '')
      next.password = nextPassword
      if (
        Object.prototype.hasOwnProperty.call(imp, 'grade') &&
        String(row.grade ?? '').trim() !== String(next.grade ?? '').trim()
      ) {
        employeeIdsToClearSkillProgress.push(String(row.id))
      }
      merged.push(next)
      seen.add(String(row.id))
    } else {
      merged.push(row)
    }
  }
  for (const imp of imported) {
    if (!seen.has(String(imp.id))) {
      merged.push({
        ...imp,
        password: String(imp.password ?? '').trim() ? String(imp.password).trim() : '',
      })
      seen.add(String(imp.id))
    }
  }
  return {
    merged,
    employeeIdsToClearSkillProgress: [...new Set(employeeIdsToClearSkillProgress)],
  }
}

/** 昇級は G1→G2→…→G6（一段階） */
const PROMOTION_GRADE_ORDER = ['G1', 'G2', 'G3', 'G4', 'G5', 'G6']

function nextPromotionGrade(currentGrade) {
  const g = normalizeEmployeeGrade(currentGrade)
  const i = PROMOTION_GRADE_ORDER.indexOf(g)
  if (i < 0 || i >= PROMOTION_GRADE_ORDER.length - 1) return null
  return PROMOTION_GRADE_ORDER[i + 1]
}

function normalizePromotionRequests(raw) {
  if (!Array.isArray(raw)) return []
  return raw
    .filter((x) => x && typeof x === 'object')
    .map((x, idx) => ({
      id: String(x.id ?? '').trim() || `promo_${idx}_${Date.now()}`,
      employeeId: String(x.employeeId ?? '').trim(),
      employeeName: String(x.employeeName ?? '').trim(),
      fromGrade: normalizeEmployeeGrade(x.fromGrade),
      toGrade: normalizeEmployeeGrade(x.toGrade),
      status: x.status === 'approved' || x.status === 'rejected' ? x.status : 'pending',
      requestedAt: String(x.requestedAt ?? '').trim() || new Date().toISOString(),
      reviewedAt: String(x.reviewedAt ?? '').trim(),
    }))
    .filter((x) => x.employeeId)
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

/** 自己評価・上司評価の大分類（UI色分け）: business=業務能力（青）, interpersonal=対人関係能力（黄） */
const SELF_EVAL_SUPER_GROUP = {
  business: { key: 'business', label: '業務能力', description: '業務遂行・目標達成など' },
  interpersonal: { key: 'interpersonal', label: '対人関係能力', description: 'コミュニケーション・協働など' },
}

const SELF_EVAL_CATEGORIES = [
  {
    id: 'cat-exec',
    title: '業務遂行能力',
    superGroup: 'business',
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
    superGroup: 'interpersonal',
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
    superGroup: 'interpersonal',
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

function scoreCriteriaToCriteriaBlob(scoreCriteria) {
  const arr = Array.isArray(scoreCriteria) ? [...scoreCriteria] : []
  while (arr.length < 5) arr.push('')
  return [5, 4, 3, 2, 1]
    .map((n) => `${n}点：${String(arr[n - 1] ?? '').trim()}`)
    .join('\n')
}

function buildEvalCategoriesForGrade(criteriaStore, gradeId) {
  const g = String(gradeId ?? '').trim()
  const seedSuperGroupByTitle = new Map(
    SELF_EVAL_CATEGORIES.map((cat) => [String(cat.title ?? '').trim(), cat.superGroup === 'interpersonal' ? 'interpersonal' : 'business']),
  )
  const sharedMajors = Array.isArray(criteriaStore?.sharedMajors) ? criteriaStore.sharedMajors : []
  const minorsByMajor =
    criteriaStore?.minorsByGrade?.[g] && typeof criteriaStore.minorsByGrade[g] === 'object' && !Array.isArray(criteriaStore.minorsByGrade[g])
      ? criteriaStore.minorsByGrade[g]
      : null

  if (sharedMajors.length > 0 && minorsByMajor) {
    return sharedMajors.map((major, majorIndex) => {
      const title = String(major?.title ?? '').trim()
      const superGroup = seedSuperGroupByTitle.get(title) ?? 'business'
      const rawMinors = Array.isArray(minorsByMajor[major.id]) ? minorsByMajor[major.id] : []
      const items = rawMinors
        .map((minor, minorIndex) => ({
          id: String(minor?.id ?? '').trim() || `min-fallback-${majorIndex}-${minorIndex}`,
          title: String(minor?.title ?? '').trim(),
          weightPct: Math.min(100, Math.max(0, Number(minor?.weightPct) || 0)),
          criteria: scoreCriteriaToCriteriaBlob(minor?.scoreCriteria),
        }))
        .filter((it) => it.title)
      return {
        id: String(major?.id ?? '').trim() || `major-fallback-${majorIndex}`,
        title: title || `大項目${majorIndex + 1}`,
        superGroup,
        items,
      }
    })
  }

  return SELF_EVAL_CATEGORIES.map((cat) => ({
    id: cat.id,
    title: cat.title,
    superGroup: cat.superGroup === 'interpersonal' ? 'interpersonal' : 'business',
    items: cat.items.map((it) => ({
      id: it.id,
      title: it.title,
      weightPct: it.weightPct,
      criteria: it.criteria,
    })),
  }))
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

function normalizeSharedMajor(m) {
  return {
    id: typeof m?.id === 'string' && m.id ? m.id : newEvaluationId('maj'),
    title: String(m?.title ?? '').trim(),
  }
}

/** 旧形式 { G1: majors[], G2: ... } を大項目共通＋等級別小項目へ移行 */
function migrateLegacyEvaluationCriteriaToShared(raw, gradeList) {
  const grades = gradeList?.length ? gradeList : defaultSkillGrades
  const gradeIds = grades.map((g) => g.id)
  const majorSeen = new Map()
  const majorOrder = []
  for (const gid of gradeIds) {
    const arr = Array.isArray(raw?.[gid]) ? raw[gid] : []
    for (const m of arr) {
      const id = String(m?.id ?? '').trim()
      const title = String(m?.title ?? '').trim()
      if (!id || !title) continue
      if (!majorSeen.has(id)) {
        majorSeen.set(id, title)
        majorOrder.push(id)
      }
    }
  }
  if (majorOrder.length === 0) {
    return buildDefaultEvaluationCriteriaFromSelfEval(gradeList)
  }
  const sharedMajors = majorOrder.map((id) => ({ id, title: majorSeen.get(id) }))
  const minorsByGrade = {}
  for (const gid of gradeIds) {
    minorsByGrade[gid] = {}
    const arr = Array.isArray(raw?.[gid]) ? raw[gid] : []
    const byMajorId = Object.fromEntries(
      arr.filter((x) => x && String(x?.id ?? '').trim()).map((x) => [String(x.id).trim(), x]),
    )
    for (const mj of sharedMajors) {
      const found = byMajorId[mj.id]
      const minors =
        found && Array.isArray(found.minors)
          ? found.minors.map(normalizeEvaluationMinor).filter((x) => x.title)
          : []
      minorsByGrade[gid][mj.id] = minors
    }
  }
  return { sharedMajors, minorsByGrade }
}

function normalizeEvaluationCriteriaStore(raw, gradeList) {
  const grades = gradeList?.length ? gradeList : defaultSkillGrades
  const gradeIds = grades.map((g) => g.id)
  if (
    raw &&
    typeof raw === 'object' &&
    !Array.isArray(raw) &&
    Array.isArray(raw.sharedMajors) &&
    raw.minorsByGrade &&
    typeof raw.minorsByGrade === 'object' &&
    !Array.isArray(raw.minorsByGrade)
  ) {
    const sharedMajors = raw.sharedMajors.map(normalizeSharedMajor).filter((m) => m.id && m.title)
    if (sharedMajors.length === 0) {
      return buildDefaultEvaluationCriteriaFromSelfEval(gradeList)
    }
    const minorsByGrade = {}
    for (const gid of gradeIds) {
      const blob =
        raw.minorsByGrade[gid] && typeof raw.minorsByGrade[gid] === 'object' && !Array.isArray(raw.minorsByGrade[gid])
          ? raw.minorsByGrade[gid]
          : {}
      minorsByGrade[gid] = {}
      for (const mj of sharedMajors) {
        const arr = blob[mj.id]
        minorsByGrade[gid][mj.id] = Array.isArray(arr) ? arr.map(normalizeEvaluationMinor).filter((x) => x.title) : []
      }
    }
    return { sharedMajors, minorsByGrade }
  }
  return migrateLegacyEvaluationCriteriaToShared(raw, gradeList)
}

function buildDefaultEvaluationCriteriaFromSelfEval(gradeList) {
  const grades = gradeList?.length ? gradeList : defaultSkillGrades
  const sharedMajors = SELF_EVAL_CATEGORIES.map((cat) => ({
    id: `maj-seed-${cat.id}`,
    title: cat.title,
  }))
  const seedMinorsForOneGrade = () =>
    Object.fromEntries(
      SELF_EVAL_CATEGORIES.map((cat) => [
        `maj-seed-${cat.id}`,
        cat.items.map((it) =>
          normalizeEvaluationMinor({
      id: `min-seed-${it.id}`,
      title: it.title,
            weightPct: it.weightPct,
      scoreCriteria: criteriaBlobToFiveScores(it.criteria),
          }),
        ),
      ]),
    )
  const minorsByGrade = Object.fromEntries(grades.map((g) => [g.id, seedMinorsForOneGrade()]))
  return { sharedMajors, minorsByGrade }
}

const MENU_ROLE_IPPAN = 'ippan'
const MENU_ROLE_JOUSHI = 'joushi'
const MENU_ROLE_YAKUIN = 'yakuin'
const MENU_ROLE_ADMIN = 'admin'

const MENU_DISPLAY_META = {
  gyoseki: { tabLabel: '業績手当', description: '業績手当の入力・自動計算を行います。' },
  count: { tabLabel: 'カウント', description: 'カウント機能の内容を後から追加します。' },
  honsu: { tabLabel: '本数表', description: '本数表機能の内容を後から追加します。' },
  skillup: { tabLabel: 'スキルアップ', description: 'スキル習得状況の確認と管理を行います。' },
  selfeval: { tabLabel: '自己評価', description: '自己評価の実施と確認を行います。' },
  goals: { tabLabel: '目標設定・管理', description: '個人の目標設定と進捗管理を行います。' },
  bossEval: { tabLabel: '1次評価(上司)', description: '部下の評価を実施します。' },
  execEval: { tabLabel: '経営層評価', description: '従業員を100点満点で評価します。' },
  admin: { tabLabel: '評価者用', description: '全従業員の状況を一覧管理します。' },
  settings: { tabLabel: '設定', description: 'スキル設定・評価基準設定・表示設定を行います。' },
  skill: { tabLabel: 'スキル設定', description: 'スキル項目の作成と編集を行います。' },
  evalcriteria: { tabLabel: '評価基準設定', description: '評価項目と基準を設定します。' },
  menusettings: { tabLabel: '表示設定', description: '役割ごとのメニュー表示をカスタマイズします。' },
  employee: { tabLabel: '従業員管理', description: '従業員アカウントの登録・編集・削除を行います。' },
}

const MAIN_WORKSPACE_TAB_ORDER = [
  { key: 'gyoseki', label: '業績手当' },
  { key: 'count', label: MENU_DISPLAY_META.count.tabLabel },
  { key: 'honsu', label: MENU_DISPLAY_META.honsu.tabLabel },
  { key: 'admin', label: MENU_DISPLAY_META.admin.tabLabel },
  { key: 'employee', label: MENU_DISPLAY_META.employee.tabLabel },
  { key: 'settings', label: MENU_DISPLAY_META.settings.tabLabel },
  { key: 'skillup', label: MENU_DISPLAY_META.skillup.tabLabel },
  { key: 'selfeval', label: MENU_DISPLAY_META.selfeval.tabLabel },
  { key: 'goals', label: MENU_DISPLAY_META.goals.tabLabel },
]

const MAIN_WORKSPACE_TAB_ICONS = {
  gyoseki: '💹',
  count: '🔢',
  honsu: '📋',
  admin: '📊',
  employee: '👥',
  settings: '⚙️',
  skillup: '🚀',
  selfeval: '📝',
  goals: '🎯',
}

/** 管理者の表示設定対象タブ（業績手当含む） */
const ADMIN_ROLE_MENU_KEYS = MAIN_WORKSPACE_TAB_ORDER.map((t) => t.key)

const MENU_KEYS_BY_ROLE_CARD = {
  [MENU_ROLE_IPPAN]: ['count', 'honsu', 'skillup', 'selfeval', 'goals'],
  [MENU_ROLE_JOUSHI]: ['count', 'honsu', 'admin', 'skillup', 'selfeval', 'goals', 'bossEval', 'execEval'],
  [MENU_ROLE_YAKUIN]: [
    'gyoseki',
    'count',
    'honsu',
    'admin',
    'employee',
    'settings',
    'goals',
    'bossEval',
    'execEval',
  ],
  [MENU_ROLE_ADMIN]: [...ADMIN_ROLE_MENU_KEYS],
}

const DEFAULT_MENU_VISIBILITY_BY_ROLE = {
  [MENU_ROLE_IPPAN]: ['count', 'honsu', 'skillup', 'selfeval', 'goals'],
  [MENU_ROLE_JOUSHI]: ['count', 'honsu', 'skillup', 'selfeval', 'goals', 'bossEval', 'execEval'],
  [MENU_ROLE_YAKUIN]: [
    'gyoseki',
    'count',
    'honsu',
    'admin',
    'employee',
    'settings',
    'goals',
    'bossEval',
    'execEval',
  ],
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
  if (emp?.role === '役員') return MENU_ROLE_YAKUIN
  if (emp) return MENU_ROLE_IPPAN
  return MENU_ROLE_ADMIN
}

function isWorkspaceVisibleForRole(workspaceKey, roleKey, menuVisibilityByRole) {
  const normalizedWorkspaceKey =
    workspaceKey === 'skill' || workspaceKey === 'evalcriteria' || workspaceKey === 'menusettings'
      ? 'settings'
      : workspaceKey
  if (normalizedWorkspaceKey === 'gyoseki') {
    if (roleKey !== MENU_ROLE_ADMIN && roleKey !== MENU_ROLE_YAKUIN) return false
    const list = menuVisibilityByRole[roleKey] ?? []
    return list.includes('gyoseki')
  }
  if (roleKey === MENU_ROLE_ADMIN && normalizedWorkspaceKey === 'settings') return true
  if (
    (normalizedWorkspaceKey === 'bossEval' || normalizedWorkspaceKey === 'execEval') &&
    (roleKey === MENU_ROLE_JOUSHI || roleKey === MENU_ROLE_YAKUIN || roleKey === MENU_ROLE_ADMIN)
  ) {
    return true
  }
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
    const commentHistory = Array.isArray(entry?.commentHistory)
      ? entry.commentHistory
          .map((h, idx) => {
            const comment = String(h?.comment ?? '').trim()
            if (!comment) return null
            return {
              id: typeof h?.id === 'string' && h.id ? h.id : `boss-comment-${empId}-${idx}`,
              comment,
              majorCategoryKey: String(h?.majorCategoryKey ?? '').trim(),
              createdAt: String(h?.createdAt ?? '').trim() || new Date().toISOString(),
            }
          })
          .filter(Boolean)
      : []
    out[empId] = { scores, comments, commentHistory }
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
    const baseByMajor =
      entry?.baseByMajor && typeof entry.baseByMajor === 'object' && !Array.isArray(entry.baseByMajor)
        ? Object.fromEntries(
            Object.entries(entry.baseByMajor)
              .map(([k, v]) => {
                const kk = String(k ?? '').trim()
                const vv = normalizeExecutiveBaseLevel(v)
                if (!kk || !Number.isFinite(vv) || vv < 1) return null
                return [kk, vv]
              })
              .filter(Boolean),
          )
        : {}
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
              majorCategoryKey: String(h?.majorCategoryKey ?? '').trim(),
              createdAt: String(h?.createdAt ?? '').trim() || new Date().toISOString(),
            }
          })
          .filter(Boolean)
      : []
    const scores = entry?.scores && typeof entry.scores === 'object' && !Array.isArray(entry.scores) ? { ...entry.scores } : {}
    const comments =
      entry?.comments && typeof entry.comments === 'object' && !Array.isArray(entry.comments) ? { ...entry.comments } : {}
    out[empId] = { baseScore, baseByMajor, commentHistory, scores, comments }
  }
  return out
}

function normalizeEvalHistoryByEmployeeMap(raw, normalizer) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out = {}
  for (const [empId, periods] of Object.entries(raw)) {
    if (!empId || typeof periods !== 'object' || Array.isArray(periods)) continue
    const periodMap = {}
    for (const [periodKey, state] of Object.entries(periods)) {
      const pk = String(periodKey ?? '').trim()
      if (!pk) continue
      const normalized = normalizer({ [empId]: state })[empId]
      if (!normalized) continue
      const evalGradeRaw = typeof state?.evalGrade === 'string' ? state.evalGrade.trim() : ''
      const submittedAtRaw = typeof state?.submittedAt === 'string' ? state.submittedAt.trim() : ''
      const resubmitRequestedAtRaw =
        typeof state?.resubmitRequestedAt === 'string' ? state.resubmitRequestedAt.trim() : ''
      const resubmitReasonRaw = typeof state?.resubmitReason === 'string' ? state.resubmitReason.trim() : ''
      const submissionWithdrawalsUsed = clampEvalSubmissionWithdrawalsUsed(state?.submissionWithdrawalsUsed)
      periodMap[pk] = {
        ...normalized,
        savedAt:
          typeof state?.savedAt === 'string' && state.savedAt.trim()
            ? state.savedAt.trim()
            : new Date().toISOString(),
        ...(evalGradeRaw ? { evalGrade: evalGradeRaw } : {}),
        ...(submittedAtRaw ? { submittedAt: submittedAtRaw } : {}),
        ...(resubmitRequestedAtRaw ? { resubmitRequestedAt: resubmitRequestedAtRaw } : {}),
        ...(resubmitReasonRaw ? { resubmitReason: resubmitReasonRaw } : {}),
        ...(submissionWithdrawalsUsed > 0 ? { submissionWithdrawalsUsed } : {}),
      }
    }
    if (Object.keys(periodMap).length) out[empId] = periodMap
  }
  return out
}

function normalizeGoalList(rawList, empId = '') {
  if (!Array.isArray(rawList)) return []
  return rawList
    .map((g, idx) => ({
      id: typeof g?.id === 'string' && g.id ? g.id : `goal-${empId}-${idx}`,
      title: String(g?.title ?? '').trim(),
      detail: String(g?.detail ?? g?.description ?? '').trim(),
      deadline: String(g?.deadline ?? '').trim(),
      achieved: Boolean(g?.achieved),
    }))
    .filter((g) => g.title && g.deadline)
}

function mergeEvalHistoryMapBySavedAt(currentMap, incomingMap) {
  const current = currentMap && typeof currentMap === 'object' && !Array.isArray(currentMap) ? currentMap : {}
  const incoming = incomingMap && typeof incomingMap === 'object' && !Array.isArray(incomingMap) ? incomingMap : {}
  let changed = false
  const merged = { ...current }
  const toSavedAtMs = (slot) => {
    const raw = String(slot?.savedAt ?? '').trim()
    const ms = Date.parse(raw)
    return Number.isFinite(ms) ? ms : 0
  }
  for (const [empId, incomingPeriods] of Object.entries(incoming)) {
    if (!incomingPeriods || typeof incomingPeriods !== 'object' || Array.isArray(incomingPeriods)) continue
    const currentPeriods =
      merged[empId] && typeof merged[empId] === 'object' && !Array.isArray(merged[empId]) ? merged[empId] : {}
    let periodChanged = false
    const nextPeriods = { ...currentPeriods }
    for (const [periodKey, incomingSlot] of Object.entries(incomingPeriods)) {
      if (!incomingSlot || typeof incomingSlot !== 'object' || Array.isArray(incomingSlot)) continue
      const currentSlot = currentPeriods?.[periodKey]
      if (!currentSlot || typeof currentSlot !== 'object' || Array.isArray(currentSlot)) {
        nextPeriods[periodKey] = incomingSlot
        periodChanged = true
        continue
      }
      const incomingMs = toSavedAtMs(incomingSlot)
      const currentMs = toSavedAtMs(currentSlot)
      if (incomingMs > currentMs || (incomingMs >= currentMs && currentSlot !== incomingSlot)) {
        nextPeriods[periodKey] = incomingSlot
        periodChanged = true
      }
    }
    if (periodChanged || !Object.prototype.hasOwnProperty.call(current, empId)) {
      merged[empId] = nextPeriods
      changed = true
    }
  }
  return changed ? merged : current
}

function filterCommittedEvalHistoryMap(historyMap) {
  if (!historyMap || typeof historyMap !== 'object' || Array.isArray(historyMap)) return {}
  const next = {}
  for (const [empId, periods] of Object.entries(historyMap)) {
    if (!periods || typeof periods !== 'object' || Array.isArray(periods)) continue
    const kept = {}
    for (const [periodKey, slot] of Object.entries(periods)) {
      if (!slot || typeof slot !== 'object' || Array.isArray(slot)) continue
      const hasSubmitted = Boolean(String(slot?.submittedAt ?? '').trim())
      const hasResubmitRequest = Boolean(String(slot?.resubmitRequestedAt ?? '').trim())
      const hasWithdrawal = clampEvalSubmissionWithdrawalsUsed(slot?.submissionWithdrawalsUsed) > 0
      if (hasSubmitted || hasResubmitRequest || hasWithdrawal) {
        kept[periodKey] = slot
      }
    }
    if (Object.keys(kept).length > 0) next[empId] = kept
  }
  return next
}

function normalizeGoalsByEmployeePeriodMap(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out = {}
  for (const [empId, periods] of Object.entries(raw)) {
    if (!empId || !periods || typeof periods !== 'object' || Array.isArray(periods)) continue
    const periodMap = {}
    for (const [periodKey, list] of Object.entries(periods)) {
      const pk = String(periodKey ?? '').trim()
      if (!pk) continue
      const normalized = normalizeGoalList(list, empId)
      if (normalized.length > 0) periodMap[pk] = normalized
    }
    if (Object.keys(periodMap).length > 0) out[empId] = periodMap
  }
  return out
}

function normalizeGoalDirectionByEmployeePeriodMap(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out = {}
  for (const [empId, periods] of Object.entries(raw)) {
    if (!empId || !periods || typeof periods !== 'object' || Array.isArray(periods)) continue
    const periodMap = {}
    for (const [periodKey, value] of Object.entries(periods)) {
      const pk = String(periodKey ?? '').trim()
      const v = String(value ?? '').trim()
      if (!pk || !v) continue
      periodMap[pk] = v
    }
    if (Object.keys(periodMap).length > 0) out[empId] = periodMap
  }
  return out
}

function normalizeGoalFocusMajorByEmployeePeriodMap(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out = {}
  for (const [empId, periods] of Object.entries(raw)) {
    if (!empId || !periods || typeof periods !== 'object' || Array.isArray(periods)) continue
    const periodMap = {}
    for (const [periodKey, value] of Object.entries(periods)) {
      const pk = String(periodKey ?? '').trim()
      const v = String(value ?? '').trim()
      if (!pk || !v) continue
      periodMap[pk] = v
    }
    if (Object.keys(periodMap).length > 0) out[empId] = periodMap
  }
  return out
}

function areShallowStringMapEqual(a, b) {
  const ao = a && typeof a === 'object' && !Array.isArray(a) ? a : {}
  const bo = b && typeof b === 'object' && !Array.isArray(b) ? b : {}
  const aKeys = Object.keys(ao)
  const bKeys = Object.keys(bo)
  if (aKeys.length !== bKeys.length) return false
  for (const k of aKeys) {
    if (!Object.prototype.hasOwnProperty.call(bo, k)) return false
    if (String(ao[k] ?? '') !== String(bo[k] ?? '')) return false
  }
  return true
}

function areEvalStateMapsEqual(a, b) {
  const ao = a && typeof a === 'object' && !Array.isArray(a) ? a : {}
  const bo = b && typeof b === 'object' && !Array.isArray(b) ? b : {}
  const aKeys = Object.keys(ao)
  const bKeys = Object.keys(bo)
  if (aKeys.length !== bKeys.length) return false
  for (const empId of aKeys) {
    if (!Object.prototype.hasOwnProperty.call(bo, empId)) return false
    const ae = ao[empId] ?? {}
    const be = bo[empId] ?? {}
    if (!areShallowStringMapEqual(ae.scores, be.scores)) return false
    if (!areShallowStringMapEqual(ae.comments, be.comments)) return false
  }
  return true
}

function areExecutiveEvalStateMapsEqual(a, b) {
  const na = normalizeExecutiveEvalByEmployeeMap(a && typeof a === 'object' && !Array.isArray(a) ? a : {})
  const nb = normalizeExecutiveEvalByEmployeeMap(b && typeof b === 'object' && !Array.isArray(b) ? b : {})
  return JSON.stringify(na) === JSON.stringify(nb)
}

function resizeLevelCriteriaArray(prev, newLen) {
  const next = [...(prev || [])]
  while (next.length < newLen) next.push('')
  while (next.length > newLen) next.pop()
  return next
}

function GyosekiSvgIcon({ children }) {
  return (
    <svg className="gyosekiSvgIcon" viewBox="0 0 24 24" width="18" height="18" aria-hidden>
      {children}
    </svg>
  )
}

function GyosekiIconDownload() {
  return (
    <GyosekiSvgIcon>
      <path
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M12 3v12m0 0l-4-4m4 4l4-4M4 21h16"
      />
    </GyosekiSvgIcon>
  )
}

function GyosekiIconUpload() {
  return (
    <GyosekiSvgIcon>
      <path
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M12 21V9m0 0l-4 4m4-4l4 4M4 15h16"
      />
    </GyosekiSvgIcon>
  )
}

function GyosekiIconMail() {
  return (
    <GyosekiSvgIcon>
      <path
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"
      />
    </GyosekiSvgIcon>
  )
}

function GyosekiIconPlus() {
  return (
    <GyosekiSvgIcon>
      <path
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        d="M12 5v14M5 12h14"
      />
    </GyosekiSvgIcon>
  )
}

function GyosekiIconSortAsc() {
  return (
    <GyosekiSvgIcon>
      <path fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" d="M8 17l4-8 4 8M8 17h8" />
    </GyosekiSvgIcon>
  )
}

function GyosekiIconSortDesc() {
  return (
    <GyosekiSvgIcon>
      <path fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" d="M8 7l4 8 4-8M8 7h8" />
    </GyosekiSvgIcon>
  )
}

function sortGyosekiAllowanceRows(list, sortKey, sortOrder, gradeOrderIds = null) {
  const direction = sortOrder === 'asc' ? 1 : -1
  const toString = (value) => String(value ?? '').toLowerCase()
  return [...list].sort((a, b) => {
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
    if (sortKey === 'grade') {
      if (Array.isArray(gradeOrderIds) && gradeOrderIds.length) {
        const rank = (g) => {
          const i = gradeOrderIds.indexOf(String(g ?? ''))
          return i >= 0 ? i : 9999
        }
        return (rank(a.grade) - rank(b.grade)) * direction
      }
      return ((gradeRates[a.grade] ?? 0) - (gradeRates[b.grade] ?? 0)) * direction
    }
    if (sortKey === 'team') return toString(a.team).localeCompare(toString(b.team), 'ja') * direction

    return toString(a[sortKey]).localeCompare(toString(b[sortKey]), 'ja') * direction
  })
}

function EmployeeIconTemplateCsv() {
  return (
    <svg className="employeeToolbarSvgIcon" viewBox="0 0 24 24" width="18" height="18" aria-hidden>
      <path
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"
      />
      <path fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" d="M14 2v6h6" />
      <path fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" d="M8 13h8M8 17h6" />
    </svg>
  )
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
  const [resetFeedback, setResetFeedback] = useState('')
  const [resetFeedbackType, setResetFeedbackType] = useState('error')
  const savedData = loadSavedData()
  const __initEvalPeriodState = readInitialEvalPeriodStateFromSavedData(savedData)
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
  const [gyosekiCsvModalOpen, setGyosekiCsvModalOpen] = useState(false)
  const [gyosekiInfoModalOpen, setGyosekiInfoModalOpen] = useState(false)
  const [gyosekiCsvColumnOrder, setGyosekiCsvColumnOrder] = useState(() => GYOSEKI_CSV_COLUMNS.map((c) => c.key))
  const [gyosekiCsvColumnEnabled, setGyosekiCsvColumnEnabled] = useState(() =>
    Object.fromEntries(GYOSEKI_CSV_COLUMNS.map((c) => [c.key, true])),
  )
  const [sortKey, setSortKey] = useState(() => savedData?.sortKey ?? 'employeeNo')
  const [sortOrder, setSortOrder] = useState(() => savedData?.sortOrder ?? 'asc')
  const [gyosekiTeamFilter, setGyosekiTeamFilter] = useState(() =>
    savedData?.gyosekiTeamFilter === 'denture' || savedData?.gyosekiTeamFilter === 'ck'
      ? savedData.gyosekiTeamFilter
      : 'all',
  )
  const [gyosekiRowView, setGyosekiRowView] = useState(() =>
    savedData?.gyosekiRowView === 'simple' ? 'simple' : 'detail',
  )
  const [workspaceView, setWorkspaceView] = useState(() => savedData?.workspaceView ?? 'gyoseki')
  const [settingsTab, setSettingsTab] = useState(() => savedData?.settingsTab ?? 'skill')
  const [activePage, setActivePage] = useState(() => savedData?.activePage ?? 'input')
  const [employeeDirectoryRows, setEmployeeDirectoryRows] = useState(() => {
    const saved = savedData?.employeeDirectoryRows
    const base = Array.isArray(saved) && saved.length > 0 ? saved : defaultEmployeeDirectoryRows
    return normalizeEmployeeDirectoryRows(base)
  })
  const employeeDirectoryDirtyRef = useRef(false)
  const updateEmployeeDirectoryRowsLocal = useCallback((updater) => {
    employeeDirectoryDirtyRef.current = true
    setEmployeeDirectoryRows(updater)
  }, [])
  const employeeGradeByNo = useMemo(() => {
    const out = new Map()
    for (const row of employeeDirectoryRows ?? []) {
      const empNo = normalizeEmployeeNoLinkKey(row?.id)
      const grade = String(row?.grade ?? '').trim()
      if (!empNo || !grade) continue
      out.set(empNo, grade)
    }
    return out
  }, [employeeDirectoryRows])
  const [employeeDeptOptions, setEmployeeDeptOptions] = useState(() => {
    const saved = savedData?.employeeDirectoryRows
    const base = Array.isArray(saved) && saved.length > 0 ? saved : defaultEmployeeDirectoryRows
    const rows = normalizeEmployeeDirectoryRows(base)
    return mergeEmployeeDeptOptionsFromRows(savedData?.employeeDeptOptions, rows)
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

  /** 業績手当の等級はスキル／評価の等級マスタのみ。マスタに無い値は先頭等級へ寄せる */
  const selfEvalStatePeriodRef = useRef('')
  const supervisorEvalStatePeriodRef = useRef('')
  const executiveEvalStatePeriodRef = useRef('')
  const lastSelfEvalSyncPeriodRef = useRef('')
  const lastSupervisorEvalSyncPeriodRef = useRef('')
  const lastExecutiveEvalSyncPeriodRef = useRef('')

  useLayoutEffect(() => {
    const ids = skillGrades.map((g) => g.id).filter(Boolean)
    if (!ids.length) return
    const allowed = new Set(ids)
    setRows((prev) => {
      let changed = false
      const next = prev.map((row) => {
        if (allowed.has(String(row.grade ?? ''))) return row
        changed = true
        return { ...row, grade: ids[0] }
      })
      return changed ? next : prev
    })
  }, [skillGrades])

  /** 業績手当: 社員番号(社員C)が従業員管理に一致する行は、従業員管理の等級へ自動同期する */
  useEffect(() => {
    if (!rows.length || !employeeGradeByNo.size) return
    setRows((prev) => {
      let changed = false
      const next = prev.map((row) => {
        const empNo = normalizeEmployeeNoLinkKey(row.employeeNo)
        if (!empNo) return row
        const linkedGrade = employeeGradeByNo.get(empNo)
        if (!linkedGrade) return row
        if (String(row.grade ?? '').trim() === linkedGrade) return row
        changed = true
        return { ...row, grade: linkedGrade }
      })
      return changed ? next : prev
    })
  }, [rows, employeeGradeByNo])

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
  const [goalsByEmployeePeriod, setGoalsByEmployeePeriod] = useState(() => {
    const periodRaw = normalizeGoalsByEmployeePeriodMap(savedData?.goalsByEmployeePeriod)
    if (Object.keys(periodRaw).length > 0) return periodRaw
    const legacy = savedData?.goalsByEmployee
    if (!legacy || typeof legacy !== 'object' || Array.isArray(legacy)) return {}
    const active = String(__initEvalPeriodState.active ?? '').trim()
    if (!active) return {}
    const out = {}
    for (const [empId, list] of Object.entries(legacy)) {
      const normalized = normalizeGoalList(list, empId)
      if (!normalized.length) continue
      out[empId] = { [active]: normalized }
    }
    return out
  })
  const [goalDirectionByEmployeePeriod, setGoalDirectionByEmployeePeriod] = useState(() => {
    const periodRaw = normalizeGoalDirectionByEmployeePeriodMap(savedData?.goalDirectionByEmployeePeriod)
    if (Object.keys(periodRaw).length > 0) return periodRaw
    const legacy = savedData?.goalDirectionByEmployee
    if (!legacy || typeof legacy !== 'object' || Array.isArray(legacy)) return {}
    const active = String(__initEvalPeriodState.active ?? '').trim()
    if (!active) return {}
    const out = {}
    for (const [empId, value] of Object.entries(legacy)) {
      const v = String(value ?? '').trim()
      if (!empId || !v) continue
      out[empId] = { [active]: v }
    }
    return out
  })
  const [goalFocusMajorByEmployeePeriod, setGoalFocusMajorByEmployeePeriod] = useState(() =>
    normalizeGoalFocusMajorByEmployeePeriodMap(savedData?.goalFocusMajorByEmployeePeriod),
  )
  const [goalSubmissionByEmployee, setGoalSubmissionByEmployee] = useState(() => {
    const raw = savedData?.goalSubmissionByEmployee
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
    const out = {}
    for (const [empId, periods] of Object.entries(raw)) {
      if (!empId || !periods || typeof periods !== 'object' || Array.isArray(periods)) continue
      const periodMap = {}
      for (const [periodKey, state] of Object.entries(periods)) {
        if (!periodKey) continue
        const submittedAt = typeof state?.submittedAt === 'string' ? state.submittedAt.trim() : ''
        const submissionWithdrawalsUsed = clampEvalSubmissionWithdrawalsUsed(state?.submissionWithdrawalsUsed)
        if (submittedAt) {
          periodMap[periodKey] =
            submissionWithdrawalsUsed > 0 ? { submittedAt, submissionWithdrawalsUsed } : { submittedAt }
        } else if (submissionWithdrawalsUsed > 0) {
          periodMap[periodKey] = { submissionWithdrawalsUsed }
        }
      }
      if (Object.keys(periodMap).length) out[empId] = periodMap
    }
    return out
  })
  const [evaluationCriteria, setEvaluationCriteria] = useState(() => {
    const raw = savedData?.evaluationCriteria
    const gradeListForEval =
      Array.isArray(savedData?.skillGrades) && savedData.skillGrades.some((g) => g && g.id)
        ? savedData.skillGrades
        : defaultSkillGrades
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      return normalizeEvaluationCriteriaStore(raw, gradeListForEval)
    }
    return buildDefaultEvaluationCriteriaFromSelfEval(gradeListForEval)
  })
  const [menuVisibilityByRole, setMenuVisibilityByRole] = useState(() => {
    const raw = savedData?.menuVisibilityByRole
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      return normalizeMenuVisibilityByRole(raw)
    }
    return normalizeMenuVisibilityByRole(null)
  })
  const [evalPeriodDefinitions, setEvalPeriodDefinitions] = useState(() => __initEvalPeriodState.defs)
  const [activeEvalPeriodKey, setActiveEvalPeriodKey] = useState(() => __initEvalPeriodState.active)
  const [selfEvalByEmployee, setSelfEvalByEmployee] = useState(() => normalizeEvalByEmployeeMap(savedData?.selfEvalByEmployee))
  const [supervisorEvalByEmployee, setSupervisorEvalByEmployee] = useState(() =>
    normalizeEvalByEmployeeMap(savedData?.supervisorEvalByEmployee),
  )
  const [executiveEvalByEmployee, setExecutiveEvalByEmployee] = useState(() =>
    normalizeExecutiveEvalByEmployeeMap(savedData?.executiveEvalByEmployee),
  )
  const [selfEvalHistoryByEmployee, setSelfEvalHistoryByEmployee] = useState(() => {
    const hist = normalizeEvalHistoryByEmployeeMap(savedData?.selfEvalHistoryByEmployee, normalizeEvalByEmployeeMap)
    if (Object.keys(hist).length) return hist
    const legacy = normalizeEvalByEmployeeMap(savedData?.selfEvalByEmployee)
    const period = __initEvalPeriodState.active
    const out = {}
    for (const [empId, state] of Object.entries(legacy)) {
      out[empId] = { [period]: { ...state, savedAt: new Date().toISOString() } }
    }
    return out
  })
  const [supervisorEvalHistoryByEmployee, setSupervisorEvalHistoryByEmployee] = useState(() => {
    const hist = normalizeEvalHistoryByEmployeeMap(savedData?.supervisorEvalHistoryByEmployee, normalizeEvalByEmployeeMap)
    if (Object.keys(hist).length) return hist
    const legacy = normalizeEvalByEmployeeMap(savedData?.supervisorEvalByEmployee)
    const period = __initEvalPeriodState.active
    const out = {}
    for (const [empId, state] of Object.entries(legacy)) {
      out[empId] = { [period]: { ...state, savedAt: new Date().toISOString() } }
    }
    return out
  })
  const [executiveEvalHistoryByEmployee, setExecutiveEvalHistoryByEmployee] = useState(() => {
    const hist = normalizeEvalHistoryByEmployeeMap(
      savedData?.executiveEvalHistoryByEmployee,
      normalizeExecutiveEvalByEmployeeMap,
    )
    if (Object.keys(hist).length) return hist
    const legacy = normalizeExecutiveEvalByEmployeeMap(savedData?.executiveEvalByEmployee)
    const period = __initEvalPeriodState.active
    const out = {}
    for (const [empId, state] of Object.entries(legacy)) {
      out[empId] = { [period]: { ...state, savedAt: new Date().toISOString() } }
    }
    return out
  })
  const [countCurrent, setCountCurrent] = useState(() => {
    const raw = Number(savedData?.countCurrent)
    return Number.isFinite(raw) ? Math.max(0, Math.trunc(raw)) : 0
  })
  const [countHourlyTarget, setCountHourlyTarget] = useState(() => {
    const raw = Number(savedData?.countHourlyTarget)
    return Number.isFinite(raw) ? Math.max(1, Math.trunc(raw)) : 60
  })
  const [countIsRunning, setCountIsRunning] = useState(() => Boolean(savedData?.countIsRunning))
  const [selectedEvalEmployeeId, setSelectedEvalEmployeeId] = useState(null)
  const [adminSelectedMemberId, setAdminSelectedMemberId] = useState(null)
  const [adminDetailTab, setAdminDetailTab] = useState('skill')
  const [promotionRequests, setPromotionRequests] = useState(() => normalizePromotionRequests(savedData?.promotionRequests))
  const employeeScoreByNo = useMemo(() => {
    const out = new Map()
    for (const row of employeeDirectoryRows ?? []) {
      const empNo = normalizeEmployeeNoLinkKey(row?.id)
      if (!empNo) continue
      const total = overallWeightedScore100ForEmployee(row, {
        skills: skillSettings,
        skillProgress: skillEmployeeProgress,
        selfEvalByEmployee,
        supervisorEvalByEmployee,
        executiveEvalByEmployee,
        evaluationCriteria,
      })
      if (!Number.isFinite(total)) continue
      out.set(empNo, total.toFixed(1))
    }
    return out
  }, [
    employeeDirectoryRows,
    skillSettings,
    skillEmployeeProgress,
    selfEvalByEmployee,
    supervisorEvalByEmployee,
    executiveEvalByEmployee,
    evaluationCriteria,
  ])
  /** 業績手当: 社員番号(社員C)が従業員管理に一致する行は、従業員管理の総合得点へ自動同期する */
  useEffect(() => {
    if (!rows.length || !employeeScoreByNo.size) return
    setRows((prev) => {
      let changed = false
      const next = prev.map((row) => {
        const empNo = normalizeEmployeeNoLinkKey(row.employeeNo)
        if (!empNo) return row
        const linkedScore = employeeScoreByNo.get(empNo)
        if (!linkedScore) return row
        if (String(row.score ?? '').trim() === linkedScore) return row
        changed = true
        return { ...row, score: linkedScore }
      })
      return changed ? next : prev
    })
  }, [rows, employeeScoreByNo])

  const [isCloudReady, setIsCloudReady] = useState(false)
  const [snapshotPeriod, setSnapshotPeriod] = useState(() => savedData?.snapshotPeriod ?? getCurrentPeriod())
  const [snapshotHistory, setSnapshotHistory] = useState([])
  const [snapshotMessage, setSnapshotMessage] = useState('')
  const [syncMessage, setSyncMessage] = useState(
    supabase ? 'Supabase同期を確認中...' : 'Supabase未設定（ローカル保存のみ）',
  )
  const [syncError, setSyncError] = useState('')
  const [isEvalPeriodSwitching, setIsEvalPeriodSwitching] = useState(false)
  const evalPeriodSwitchStartedAtRef = useRef(0)

  useEffect(() => {
    setEvaluationCriteria((prev) => {
      if (!prev || !Array.isArray(prev.sharedMajors) || !prev.minorsByGrade) {
        return normalizeEvaluationCriteriaStore(prev, skillGrades)
      }
      const ids = skillGrades.map((g) => g.id)
      const idSet = new Set(ids)
      const sharedMajors = prev.sharedMajors
      let minorsByGrade = { ...prev.minorsByGrade }
      let changed = false
      for (const gid of ids) {
        const cur = minorsByGrade[gid] && typeof minorsByGrade[gid] === 'object' && !Array.isArray(minorsByGrade[gid])
          ? { ...minorsByGrade[gid] }
          : {}
        let gChanged = !minorsByGrade[gid]
        for (const m of sharedMajors) {
          if (!Array.isArray(cur[m.id])) {
            cur[m.id] = []
            gChanged = true
          }
        }
        if (gChanged) {
          minorsByGrade[gid] = cur
          changed = true
        }
      }
      for (const k of Object.keys(minorsByGrade)) {
        if (!idSet.has(k)) {
          delete minorsByGrade[k]
          changed = true
        }
      }
      return changed ? { ...prev, minorsByGrade } : prev
    })
  }, [skillGrades])

  useEffect(() => {
    const sharedMajors = Array.isArray(evaluationCriteria?.sharedMajors) ? evaluationCriteria.sharedMajors : []
    if (sharedMajors.length === 0) return
    const linkedSections = sharedMajors.map((m) => ({
      id: String(m.id ?? '').trim(),
      label: String(m.title ?? '').trim(),
    })).filter((s) => s.id && s.label)
    if (linkedSections.length === 0) return

    setSkillSections((prev) => {
      const prevNorm = Array.isArray(prev)
        ? prev.map((s) => ({ id: String(s?.id ?? '').trim(), label: String(s?.label ?? '').trim() })).filter((s) => s.id && s.label)
        : []
      const sameLen = prevNorm.length === linkedSections.length
      const sameAll = sameLen && prevNorm.every((s, i) => s.id === linkedSections[i].id && s.label === linkedSections[i].label)
      return sameAll ? prev : linkedSections
    })

    setSkillSettings((prev) => {
      if (!Array.isArray(prev) || prev.length === 0) return prev
      const validIdSet = new Set(linkedSections.map((s) => s.id))
      const prevLabelById = new Map((skillSections ?? []).map((s) => [String(s.id ?? '').trim(), String(s.label ?? '').trim()]))
      const linkedIdByLabel = new Map(linkedSections.map((s) => [s.label, s.id]))
      const fallbackId = linkedSections[0].id
      let changed = false
      const next = prev.map((row) => {
        const currentSectionId = String(row.sectionId ?? '').trim()
        if (validIdSet.has(currentSectionId)) return row
        const currentLabel = prevLabelById.get(currentSectionId) ?? ''
        const mappedId = (currentLabel && linkedIdByLabel.get(currentLabel)) || fallbackId
        if (!mappedId || mappedId === currentSectionId) return row
        changed = true
        return { ...row, sectionId: mappedId }
      })
      return changed ? next : prev
    })
  }, [evaluationCriteria, skillSections])

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
    const grades = skillGrades.length ? skillGrades : defaultSkillGrades
    const defaultGradeId = grades.some((g) => g.id === 'G3') ? 'G3' : grades[0]?.id ?? 'G3'
    setRows((prev) => [...prev, { ...createRow(prev.length), grade: defaultGradeId }])
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
      const adjustmentIdx = headerIndex(['調整'])
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
            adjustment: adjustmentIdx >= 0 ? sanitizeIntegerInput(cols[adjustmentIdx] || '') : '',
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
    setGyosekiCsvModalOpen(true)
  }

  const buildCsvContent = (selectedColumnKeys) => {
    const selectedColumns = gyosekiCsvColumnOrder
      .filter((key) => selectedColumnKeys.includes(key))
      .map((key) => GYOSEKI_CSV_COLUMNS.find((c) => c.key === key))
      .filter(Boolean)
    const headers = selectedColumns.map((c) => c.label)
    const escapeCsvValue = (value) => `"${String(value ?? '').replace(/"/g, '""')}"`
    const rowsForExport = sortGyosekiAllowanceRows(
      computedRows,
      sortKey,
      sortOrder,
      skillGrades.map((g) => g.id),
    ).map((row) =>
      selectedColumns.map((c) => c.value(row)),
    )
    return [headers, ...rowsForExport]
      .map((line) => line.map(escapeCsvValue).join(','))
      .join('\r\n')
  }

  const moveGyosekiCsvColumn = (key, delta) => {
    setGyosekiCsvColumnOrder((prev) => {
      const index = prev.indexOf(key)
      if (index < 0) return prev
      const to = index + delta
      if (to < 0 || to >= prev.length) return prev
      const next = [...prev]
      const [item] = next.splice(index, 1)
      next.splice(to, 0, item)
      return next
    })
  }

  const toggleGyosekiCsvColumn = (key) => {
    setGyosekiCsvColumnEnabled((prev) => ({ ...prev, [key]: !prev[key] }))
  }

  const setAllGyosekiCsvColumnsEnabled = (enabled) => {
    setGyosekiCsvColumnEnabled(Object.fromEntries(GYOSEKI_CSV_COLUMNS.map((c) => [c.key, enabled])))
  }

  const resetGyosekiCsvColumns = () => {
    setGyosekiCsvColumnOrder(GYOSEKI_CSV_COLUMNS.map((c) => c.key))
  }

  const handleConfirmGyosekiCsvExport = () => {
    const selectedKeys = gyosekiCsvColumnOrder.filter((key) => gyosekiCsvColumnEnabled[key])
    if (selectedKeys.length === 0) {
      window.alert('抽出する項目を1つ以上選んでください。')
      return
    }
    const csvContent = buildCsvContent(selectedKeys)
    downloadCsvFile(csvContent)
    setGyosekiCsvModalOpen(false)
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

  const gyosekiFilteredRows = useMemo(() => {
    if (gyosekiTeamFilter === 'all') return computedRows
    return computedRows.filter((row) => row.team === gyosekiTeamFilter)
  }, [computedRows, gyosekiTeamFilter])

  const sortedRows = useMemo(
    () => sortGyosekiAllowanceRows(gyosekiFilteredRows, sortKey, sortOrder, skillGrades.map((g) => g.id)),
    [gyosekiFilteredRows, sortKey, sortOrder, skillGrades],
  )

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
  const evalPeriodFallbackKey = useMemo(
    () => getSuggestedEvalPeriodKey(evalPeriodDefinitions),
    [evalPeriodDefinitions],
  )
  const requestEvalPeriodChange = useCallback(
    (nextKey) => {
      const next = String(nextKey ?? '').trim()
      const current = String(activeEvalPeriodKey ?? evalPeriodFallbackKey ?? '').trim()
      if (!next || next === current) {
        setActiveEvalPeriodKey(next)
        return
      }
      evalPeriodSwitchStartedAtRef.current = Date.now()
      setIsEvalPeriodSwitching(true)
      setActiveEvalPeriodKey(next)
    },
    [activeEvalPeriodKey, evalPeriodFallbackKey],
  )
  const effectiveEvalPeriodKey = activeEvalPeriodKey ?? evalPeriodFallbackKey
  const activeEvalPeriodDef = useMemo(() => {
    const key = String(effectiveEvalPeriodKey ?? '').trim()
    if (!key) return null
    return (evalPeriodDefinitions ?? []).find((d) => String(d?.key ?? '').trim() === key) ?? null
  }, [effectiveEvalPeriodKey, evalPeriodDefinitions])
  const selfEvalDeadlineAt = normalizeDeadlineDate(activeEvalPeriodDef?.selfEvalDeadlineAt)
  const supervisorEvalDeadlineAt = normalizeDeadlineDate(activeEvalPeriodDef?.supervisorEvalDeadlineAt)
  const executiveEvalDeadlineAt = normalizeDeadlineDate(activeEvalPeriodDef?.executiveEvalDeadlineAt)
  const isSelfEvalDeadlineLocked = Number.isFinite(deadlineStartMs(selfEvalDeadlineAt))
    ? Date.now() >= deadlineStartMs(selfEvalDeadlineAt)
    : false
  const isSupervisorEvalDeadlineLocked = Number.isFinite(deadlineStartMs(supervisorEvalDeadlineAt))
    ? Date.now() >= deadlineStartMs(supervisorEvalDeadlineAt)
    : false
  const isExecutiveEvalDeadlineLocked = Number.isFinite(deadlineStartMs(executiveEvalDeadlineAt))
    ? Date.now() >= deadlineStartMs(executiveEvalDeadlineAt)
    : false

  const goalMgmtEmployee = loggedInEmployee
  const goalMgmtPeriodKey = String(activeEvalPeriodKey ?? getSuggestedEvalPeriodKey(evalPeriodDefinitions) ?? '').trim()
  const goalMgmtGoals = useMemo(
    () => (goalMgmtEmployee && goalMgmtPeriodKey ? goalsByEmployeePeriod?.[goalMgmtEmployee.id]?.[goalMgmtPeriodKey] ?? [] : []),
    [goalMgmtEmployee, goalMgmtPeriodKey, goalsByEmployeePeriod],
  )
  const goalMgmtDirection = useMemo(
    () =>
      goalMgmtEmployee && goalMgmtPeriodKey
        ? String(goalDirectionByEmployeePeriod?.[goalMgmtEmployee.id]?.[goalMgmtPeriodKey] ?? '')
        : '',
    [goalMgmtEmployee, goalMgmtPeriodKey, goalDirectionByEmployeePeriod],
  )
  const goalMgmtFocusMajorKey = useMemo(
    () =>
      goalMgmtEmployee && goalMgmtPeriodKey
        ? String(goalFocusMajorByEmployeePeriod?.[goalMgmtEmployee.id]?.[goalMgmtPeriodKey] ?? '')
        : '',
    [goalMgmtEmployee, goalMgmtPeriodKey, goalFocusMajorByEmployeePeriod],
  )
  const goalMgmtSubmittedForActive = useMemo(() => {
    if (!goalMgmtEmployee?.id || !goalMgmtPeriodKey) return false
    return Boolean(
      String(goalSubmissionByEmployee?.[goalMgmtEmployee.id]?.[goalMgmtPeriodKey]?.submittedAt ?? '').trim(),
    )
  }, [goalMgmtEmployee?.id, goalMgmtPeriodKey, goalSubmissionByEmployee])
  const submitGoalsForActivePeriod = useCallback(() => {
    if (!goalMgmtEmployee?.id || !goalMgmtPeriodKey) return
    if (goalMgmtSubmittedForActive) return
    const confirmed = window.confirm(
      `目標管理（${goalMgmtPeriodKey}）を提出しますか？提出後はこの期の目標・方針を編集できません。`,
    )
    if (!confirmed) return
    const now = new Date().toISOString()
    const empId = goalMgmtEmployee.id
    const periodKey = goalMgmtPeriodKey
    setGoalSubmissionByEmployee((prev) => {
      const prevSlot = prev?.[empId]?.[periodKey]
      const w = clampEvalSubmissionWithdrawalsUsed(prevSlot?.submissionWithdrawalsUsed)
      return {
        ...(prev ?? {}),
        [empId]: {
          ...((prev ?? {})[empId] ?? {}),
          [periodKey]: { submittedAt: now, ...(w > 0 ? { submissionWithdrawalsUsed: w } : {}) },
        },
      }
    })
  }, [goalMgmtEmployee?.id, goalMgmtPeriodKey, goalMgmtSubmittedForActive])
  const withdrawGoalsSubmissionForMember = useCallback((employeeId, periodKeyOverride) => {
    const empId = String(employeeId ?? '').trim()
    const periodKey = String(periodKeyOverride ?? '').trim()
    if (!empId || !periodKey) return
    const slot = goalSubmissionByEmployee?.[empId]?.[periodKey]
    if (!String(slot?.submittedAt ?? '').trim()) return
    const used = clampEvalSubmissionWithdrawalsUsed(slot?.submissionWithdrawalsUsed)
    if (used >= MAX_EVAL_SUBMISSION_WITHDRAWALS) {
      window.alert(`この評価期での提出取り消しは${MAX_EVAL_SUBMISSION_WITHDRAWALS}回までです。`)
      return
    }
    const nextUsed = used + 1
    const remaining = MAX_EVAL_SUBMISSION_WITHDRAWALS - nextUsed
    const empLabel =
      String(employeeDirectoryRows.find((r) => String(r?.id ?? '').trim() === empId)?.name ?? '').trim() || empId
    if (
      !window.confirm(
        `${empLabel} の目標管理（${periodKey}）の提出を取り消しますか？\n\n被評価者が再編集できます。取り消しはこの評価期であと${remaining}回行えます（今回で${nextUsed}回目）。`,
      )
    )
      return
    setGoalSubmissionByEmployee((prev) => ({
      ...(prev ?? {}),
      [empId]: {
        ...((prev ?? {})[empId] ?? {}),
        [periodKey]: nextUsed > 0 ? { submissionWithdrawalsUsed: nextUsed } : {},
      },
    }))
  }, [goalSubmissionByEmployee, employeeDirectoryRows])
  const goalMgmtWeightedTotal100 = useMemo(() => {
    return weightedTotal100ForEmployeeAtPeriod(goalMgmtEmployee, goalMgmtPeriodKey)
  }, [
    goalMgmtEmployee,
    goalMgmtPeriodKey,
    weightedTotal100ForEmployeeAtPeriod,
  ])
  const goalMgmtActiveEvalGrade = useMemo(() => {
    if (!goalMgmtEmployee) return ''
    const periodKey = String(activeEvalPeriodKey ?? evalPeriodFallbackKey ?? '').trim()
    const empId = String(goalMgmtEmployee.id ?? '').trim()
    const selfStored = String(selfEvalHistoryByEmployee?.[empId]?.[periodKey]?.evalGrade ?? '').trim()
    const bossStored = String(supervisorEvalHistoryByEmployee?.[empId]?.[periodKey]?.evalGrade ?? '').trim()
    const preferred = selfStored || bossStored || String(goalMgmtEmployee.grade ?? '').trim()
    const byGrade =
      evaluationCriteria?.byGrade &&
      typeof evaluationCriteria.byGrade === 'object' &&
      !Array.isArray(evaluationCriteria.byGrade)
        ? evaluationCriteria.byGrade
        : {}
    const gradeIds = Object.keys(byGrade).filter((k) => Array.isArray(byGrade[k]))
    if (preferred && gradeIds.includes(preferred)) return preferred
    const current = String(goalMgmtEmployee.grade ?? '').trim()
    if (current && gradeIds.includes(current)) return current
    return gradeIds[0] ?? preferred ?? current
  }, [
    goalMgmtEmployee,
    activeEvalPeriodKey,
    evalPeriodFallbackKey,
    selfEvalHistoryByEmployee,
    supervisorEvalHistoryByEmployee,
    evaluationCriteria,
  ])
  const goalMgmtEvalRadarSeries = useMemo(() => {
    if (!goalMgmtEmployee) return []
    const empId = String(goalMgmtEmployee.id ?? '').trim()
    if (!empId) return []
    const activeKey = String(activeEvalPeriodKey ?? evalPeriodFallbackKey ?? '').trim()
    const selfHist = selfEvalHistoryByEmployee?.[empId] ?? {}
    const bossHist = supervisorEvalHistoryByEmployee?.[empId] ?? {}
    const execHist = executiveEvalHistoryByEmployee?.[empId] ?? {}
    const periodKeys = pickRadarPeriodKeys({
      activeKey,
      selfHist,
      bossHist,
      execHist,
      definitions: evalPeriodDefinitions,
      limit: 3,
    })
    if (!periodKeys.length) return []
    const axisMajors = buildEvalCategoriesForGrade(evaluationCriteria, goalMgmtActiveEvalGrade).map((c, idx) => ({
      id: String(c?.id ?? '').trim() || `major-${idx}`,
      title: String(c?.title ?? '').trim() || `大項目${idx + 1}`,
    }))
    if (!axisMajors.length) return []
    const palette = ['#2563eb', '#059669', '#7c3aed']
    return periodKeys
      .map((periodKey, idx) => {
        const selfSubmitted = Boolean(String(selfHist?.[periodKey]?.submittedAt ?? '').trim())
        const bossSubmitted = Boolean(String(bossHist?.[periodKey]?.submittedAt ?? '').trim())
        const execSubmitted = Boolean(String(execHist?.[periodKey]?.submittedAt ?? '').trim())
        if (!selfSubmitted || !bossSubmitted || !execSubmitted) return null
        const periodGrade =
          String(selfHist?.[periodKey]?.evalGrade ?? '').trim() ||
          String(bossHist?.[periodKey]?.evalGrade ?? '').trim() ||
          goalMgmtActiveEvalGrade
        const periodCats = buildEvalCategoriesForGrade(evaluationCriteria, periodGrade)
        const catById = new Map(periodCats.map((c) => [String(c?.id ?? '').trim(), c]))
        const catByTitle = new Map(periodCats.map((c) => [String(c?.title ?? '').trim(), c]))
        const selfScores =
          periodKey === activeKey
            ? {
                ...(selfHist?.[periodKey]?.scores ?? {}),
                ...(selfEvalByEmployee?.[empId]?.scores ?? {}),
              }
            : { ...(selfHist?.[periodKey]?.scores ?? {}) }
        const bossScores =
          periodKey === activeKey
            ? {
                ...(bossHist?.[periodKey]?.scores ?? {}),
                ...(supervisorEvalByEmployee?.[empId]?.scores ?? {}),
              }
            : { ...(bossHist?.[periodKey]?.scores ?? {}) }
        const periodExecState = execHist?.[periodKey] ?? null
        const execScores =
          periodExecState?.scores &&
          typeof periodExecState.scores === 'object' &&
          !Array.isArray(periodExecState.scores)
            ? periodExecState.scores
            : {}
        const execByMajor = executiveEvalCategoryScores100(axisMajors, periodExecState)
        const rows = axisMajors.map((major) => {
          const cat = catById.get(major.id) || catByTitle.get(major.title)
          const self100 = weightedEvalScore100ByItems(cat?.items ?? [], selfScores)
          const boss100 = weightedEvalScore100ByItems(cat?.items ?? [], bossScores)
          const execFromScores = weightedEvalScore100ByItems(cat?.items ?? [], execScores)
          const exec100 = Number.isFinite(execFromScores)
            ? execFromScores
            : Number.isFinite(execByMajor?.[major.id])
              ? execByMajor[major.id]
              : Number.NaN
          const allDone = Number.isFinite(self100) && Number.isFinite(boss100) && Number.isFinite(exec100)
          const total100 = allDone ? (self100 + boss100 + exec100) / 3 : Number.NaN
          return {
            id: major.id,
            title: major.title,
            self100: Number.isFinite(self100) ? self100 : Number.NaN,
            boss100: Number.isFinite(boss100) ? boss100 : Number.NaN,
            exec100,
            total100,
          }
        })
        const hasAllEvalCompleted = rows.some((r) => Number.isFinite(r.total100))
        if (!hasAllEvalCompleted) return null
        return {
          periodKey,
          label: idx === 0 ? `${periodKey}（最新）` : periodKey,
          color: palette[idx] ?? palette[palette.length - 1],
          rows,
        }
      })
      .filter(Boolean)
  }, [
    goalMgmtEmployee,
    activeEvalPeriodKey,
    evalPeriodFallbackKey,
    selfEvalHistoryByEmployee,
    supervisorEvalHistoryByEmployee,
    executiveEvalByEmployee,
    executiveEvalHistoryByEmployee,
    selfEvalByEmployee,
    supervisorEvalByEmployee,
    goalMgmtActiveEvalGrade,
    evaluationCriteria,
    evalPeriodDefinitions,
  ])
  const setGoalMgmtGoals = useCallback(
    (updater) => {
      if (goalMgmtSubmittedForActive) return
      setGoalsByEmployeePeriod((prev) => {
        const emp = goalMgmtEmployee
        const periodKey = String(activeEvalPeriodKey ?? getSuggestedEvalPeriodKey(evalPeriodDefinitions) ?? '').trim()
        if (!emp || !periodKey) return prev
        const cur = prev?.[emp.id]?.[periodKey] ?? []
        const next = typeof updater === 'function' ? updater(cur) : updater
        return {
          ...(prev ?? {}),
          [emp.id]: {
            ...((prev ?? {})[emp.id] ?? {}),
            [periodKey]: Array.isArray(next) ? next : cur,
          },
        }
      })
    },
    [goalMgmtEmployee, activeEvalPeriodKey, evalPeriodDefinitions, goalMgmtSubmittedForActive],
  )
  const setGoalMgmtDirection = useCallback(
    (nextValue) => {
      if (goalMgmtSubmittedForActive) return
      setGoalDirectionByEmployeePeriod((prev) => {
        const emp = goalMgmtEmployee
        const periodKey = String(activeEvalPeriodKey ?? getSuggestedEvalPeriodKey(evalPeriodDefinitions) ?? '').trim()
        if (!emp || !periodKey) return prev
        const v = String(nextValue ?? '').trim()
        if (!v) {
          const currentByEmp = { ...((prev ?? {})[emp.id] ?? {}) }
          delete currentByEmp[periodKey]
          if (Object.keys(currentByEmp).length < 1) {
            const { [emp.id]: _removed, ...rest } = prev ?? {}
            return rest
          }
          return { ...(prev ?? {}), [emp.id]: currentByEmp }
        }
        return {
          ...(prev ?? {}),
          [emp.id]: {
            ...((prev ?? {})[emp.id] ?? {}),
            [periodKey]: v,
          },
        }
      })
    },
    [goalMgmtEmployee, activeEvalPeriodKey, evalPeriodDefinitions, goalMgmtSubmittedForActive],
  )
  const setGoalMgmtFocusMajorKey = useCallback(
    (nextValue) => {
      if (goalMgmtSubmittedForActive) return
      setGoalFocusMajorByEmployeePeriod((prev) => {
        const emp = goalMgmtEmployee
        const periodKey = String(activeEvalPeriodKey ?? getSuggestedEvalPeriodKey(evalPeriodDefinitions) ?? '').trim()
        if (!emp || !periodKey) return prev
        const v = String(nextValue ?? '').trim()
        if (!v) {
          const currentByEmp = { ...((prev ?? {})[emp.id] ?? {}) }
          delete currentByEmp[periodKey]
          if (Object.keys(currentByEmp).length < 1) {
            const { [emp.id]: _removed, ...rest } = prev ?? {}
            return rest
          }
          return { ...(prev ?? {}), [emp.id]: currentByEmp }
        }
        return {
          ...(prev ?? {}),
          [emp.id]: {
            ...((prev ?? {})[emp.id] ?? {}),
            [periodKey]: v,
          },
        }
      })
    },
    [goalMgmtEmployee, activeEvalPeriodKey, evalPeriodDefinitions, goalMgmtSubmittedForActive],
  )
  const evalSubjectEmployee = useMemo(() => {
    if (!employeeDirectoryRows.length) return null
    const byTrimmedId = (targetId) => {
      const t = String(targetId ?? '').trim()
      if (!t) return undefined
      return employeeDirectoryRows.find((row) => String(row?.id ?? '').trim() === t)
    }
    // 上司評価・経営層評価では、管理者ダッシュから指定した対象者を優先する
    if ((workspaceView === 'bossEval' || workspaceView === 'execEval') && selectedEvalEmployeeId) {
      const picked = byTrimmedId(selectedEvalEmployeeId)
      if (picked) return picked
    }
    if (loggedInEmployeeId && loginMode !== 'admin') {
      const own = byTrimmedId(loggedInEmployeeId)
      if (own) return own
    }
    if (selectedEvalEmployeeId) {
      const found = byTrimmedId(selectedEvalEmployeeId)
      if (found) return found
    }
    return employeeDirectoryRows[0] ?? null
  }, [employeeDirectoryRows, selectedEvalEmployeeId, loggedInEmployeeId, loginMode, workspaceView])

  const evalPeriodSelectOptions = useMemo(
    () =>
      buildEvalPeriodSelectOptionList({
        definitions: evalPeriodDefinitions,
        selfEvalHistoryByEmployee,
        supervisorEvalHistoryByEmployee,
        extraPeriods: normalizeExtraEvalPeriodsForEmployee(evalSubjectEmployee),
        forEmployeeId: evalSubjectEmployee?.id,
      }),
    [
      evalPeriodDefinitions,
      selfEvalHistoryByEmployee,
      supervisorEvalHistoryByEmployee,
      evalSubjectEmployee,
    ],
  )

  const evalGradeByEmployeeId = useMemo(() => {
    const map = {}
    for (const row of employeeDirectoryRows ?? []) {
      const id = String(row?.id ?? '').trim()
      if (!id) continue
      map[id] = String(row?.grade ?? '').trim()
    }
    return map
  }, [employeeDirectoryRows])
  const evalFocusMajorKeyForActive = useMemo(() => {
    const empId = String(evalSubjectEmployee?.id ?? '').trim()
    const periodKey = String(effectiveEvalPeriodKey ?? '').trim()
    if (!empId || !periodKey) return ''
    return String(goalFocusMajorByEmployeePeriod?.[empId]?.[periodKey] ?? '').trim()
  }, [evalSubjectEmployee?.id, effectiveEvalPeriodKey, goalFocusMajorByEmployeePeriod])
  function resolveEvalGradeForPeriod(employeeId, periodKey, fallbackGrade = '') {
    const empId = String(employeeId ?? '').trim()
    const pk = String(periodKey ?? '').trim()
    if (!empId || !pk) return String(fallbackGrade ?? '').trim()
    const selfSlot = selfEvalHistoryByEmployee?.[empId]?.[pk]
    const bossSlot = supervisorEvalHistoryByEmployee?.[empId]?.[pk]
    const selfSubmitted = Boolean(String(selfSlot?.submittedAt ?? '').trim())
    const bossSubmitted = Boolean(String(bossSlot?.submittedAt ?? '').trim())
    const selfGrade = String(selfSlot?.evalGrade ?? '').trim()
    const bossGrade = String(bossSlot?.evalGrade ?? '').trim()
    if (selfSubmitted && selfGrade) return selfGrade
    if (bossSubmitted && bossGrade) return bossGrade
    const currentGrade =
      String(
        employeeDirectoryRows.find((row) => String(row?.id ?? '').trim() === empId)?.grade ??
          fallbackGrade ??
          '',
      ).trim()
    return currentGrade
  }
  const selfBossGapForPeriod = useCallback(
    (employeeId, periodKey) => {
      const empId = String(employeeId ?? '').trim()
      const pk = String(periodKey ?? '').trim()
      if (!empId || !pk) return Number.NaN
      const selfState = selfEvalHistoryByEmployee?.[empId]?.[pk] ?? { scores: selfEvalByEmployee?.[empId]?.scores ?? {} }
      const bossState = supervisorEvalByEmployee?.[empId] ?? supervisorEvalHistoryByEmployee?.[empId]?.[pk] ?? { scores: {} }
      const evalGrade = resolveEvalGradeForPeriod(empId, pk, '')
      const categories = buildEvalCategoriesForGrade(evaluationCriteria, evalGrade)
      const self100 = weightedEvalScore100ByCategories(categories, selfState?.scores ?? {})
      const boss100 = weightedEvalScore100ByCategories(categories, bossState?.scores ?? {})
      if (!Number.isFinite(self100) || !Number.isFinite(boss100)) return Number.NaN
      return Math.abs(self100 - boss100)
    },
    [
      selfEvalHistoryByEmployee,
      selfEvalByEmployee,
      supervisorEvalByEmployee,
      supervisorEvalHistoryByEmployee,
      employeeDirectoryRows,
      evaluationCriteria,
    ],
  )
  function weightedTotal100ForEmployeeAtPeriod(employee, periodKey) {
      const empId = String(employee?.id ?? '').trim()
      const pk = String(periodKey ?? '').trim()
      if (!empId || !pk) return Number.NaN
      const selfHistSlot = selfEvalHistoryByEmployee?.[empId]?.[pk]
      const bossHistSlot = supervisorEvalHistoryByEmployee?.[empId]?.[pk]
      const execHistByEmp = executiveEvalHistoryByEmployee?.[empId]
      const isActive = pk === String(effectiveEvalPeriodKey ?? '').trim()
      const selfState = {
        ...(selfHistSlot ?? {}),
        ...(isActive ? (selfEvalByEmployee?.[empId] ?? {}) : {}),
      }
      const bossState = {
        ...(bossHistSlot ?? {}),
        ...(isActive ? (supervisorEvalByEmployee?.[empId] ?? {}) : {}),
      }
      const execState = isActive
        ? (executiveEvalByEmployee?.[empId] ?? execHistByEmp?.[pk] ?? execHistByEmp?.cumulative)
        : (execHistByEmp?.[pk] ?? null)
      const gradeForPeriod = resolveEvalGradeForPeriod(empId, pk, employee?.grade)
      const categories = buildEvalCategoriesForGrade(evaluationCriteria, gradeForPeriod)
      const selfScores = selfState?.scores ?? {}
      const bossScores = bossState?.scores ?? {}
      const hasSelf = Object.keys(selfScores).length > 0
      const hasBoss = Object.keys(bossScores).length > 0
      const hasExec =
        Object.keys(execState?.scores ?? {}).length > 0 ||
        Object.keys(execState?.baseByMajor ?? {}).length > 0 ||
        Number(execState?.baseScore) > 0 ||
        (Array.isArray(execState?.commentHistory) && execState.commentHistory.length > 0)
      const parts = []
      if (hasSelf) parts.push({ score: weightedEvalScore100ByCategories(categories, selfScores), weight: 0.25 })
      if (hasBoss) parts.push({ score: weightedEvalScore100ByCategories(categories, bossScores), weight: 0.35 })
      if (hasExec) parts.push({ score: executiveScore100ForState(execState, evaluationCriteria, gradeForPeriod), weight: 0.4 })
      if (!parts.length) return Number.NaN
      const weightTotal = parts.reduce((sum, x) => sum + x.weight, 0)
      if (!Number.isFinite(weightTotal) || weightTotal <= 0) return Number.NaN
      return parts.reduce((sum, x) => sum + (x.score * x.weight), 0) / weightTotal
  }
  const selfEvalSubmittedRawForActive = Boolean(
    evalSubjectEmployee?.id &&
      String(selfEvalHistoryByEmployee?.[evalSubjectEmployee.id]?.[effectiveEvalPeriodKey]?.submittedAt ?? '').trim(),
  )
  const supervisorEvalSubmittedRawForActive = Boolean(
    evalSubjectEmployee?.id &&
      String(supervisorEvalHistoryByEmployee?.[evalSubjectEmployee.id]?.[effectiveEvalPeriodKey]?.submittedAt ?? '').trim(),
  )
  const executiveEvalSubmittedRawForActive = Boolean(
    evalSubjectEmployee?.id &&
      String(executiveEvalHistoryByEmployee?.[evalSubjectEmployee.id]?.[effectiveEvalPeriodKey]?.submittedAt ?? '').trim(),
  )
  const selfEvalSubmittedForActive = selfEvalSubmittedRawForActive || isSelfEvalDeadlineLocked
  const supervisorEvalSubmittedForActive = supervisorEvalSubmittedRawForActive || isSupervisorEvalDeadlineLocked
  const executiveEvalSubmittedForActive = executiveEvalSubmittedRawForActive || isExecutiveEvalDeadlineLocked

  const supervisorSubmissionWithdrawalsUsed = useMemo(
    () =>
      evalSubjectEmployee?.id && effectiveEvalPeriodKey
        ? clampEvalSubmissionWithdrawalsUsed(
            supervisorEvalHistoryByEmployee?.[evalSubjectEmployee.id]?.[effectiveEvalPeriodKey]
              ?.submissionWithdrawalsUsed,
          )
        : 0,
    [evalSubjectEmployee?.id, effectiveEvalPeriodKey, supervisorEvalHistoryByEmployee],
  )

  const withdrawSelfEvalForMember = useCallback(
    (employeeId, periodKeyOverride) => {
      const empId = String(employeeId ?? '').trim()
      const periodKey = String(periodKeyOverride ?? effectiveEvalPeriodKey ?? '').trim()
      if (!empId || !periodKey) return
      if (isSelfEvalDeadlineLockedForPeriod(evalPeriodDefinitions, periodKey)) {
        window.alert('この評価期の自己評価は締切後のため、提出の取り消しはできません。')
        return
      }
      const slot = selfEvalHistoryByEmployee?.[empId]?.[periodKey]
      if (!String(slot?.submittedAt ?? '').trim()) return
      const used = clampEvalSubmissionWithdrawalsUsed(slot?.submissionWithdrawalsUsed)
      if (used >= MAX_EVAL_SUBMISSION_WITHDRAWALS) {
        window.alert(`この評価期での提出取り消しは${MAX_EVAL_SUBMISSION_WITHDRAWALS}回までです。`)
        return
      }
      const nextUsed = used + 1
      const remaining = MAX_EVAL_SUBMISSION_WITHDRAWALS - nextUsed
      const empLabel =
        String(employeeDirectoryRows.find((r) => String(r?.id ?? '').trim() === empId)?.name ?? '').trim() || empId
      if (
        !window.confirm(
          `${empLabel} の自己評価（${periodKey}）の提出を取り消しますか？\n\n被評価者が再編集できます。取り消しはこの評価期であと${remaining}回行えます（今回で${nextUsed}回目）。`,
        )
      )
        return
      setSelfEvalHistoryByEmployee((prev) => {
        const current = prev?.[empId]?.[periodKey] ?? {}
        return {
          ...(prev ?? {}),
          [empId]: {
            ...((prev ?? {})[empId] ?? {}),
            [periodKey]: {
              ...current,
              submittedAt: '',
              submissionWithdrawalsUsed: nextUsed,
              resubmitRequestedAt: '',
              resubmitReason: '',
            },
          },
        }
      })
    },
    [effectiveEvalPeriodKey, evalPeriodDefinitions, selfEvalHistoryByEmployee, employeeDirectoryRows],
  )

  const withdrawSupervisorEvalForMember = useCallback(
    (employeeId, periodKeyOverride) => {
      const empId = String(employeeId ?? '').trim()
      const periodKey = String(periodKeyOverride ?? effectiveEvalPeriodKey ?? '').trim()
      if (!empId || !periodKey) return
      if (isSupervisorEvalDeadlineLockedForPeriod(evalPeriodDefinitions, periodKey)) {
        window.alert('この評価期の1次評価(上司)は締切後のため、提出の取り消しはできません。')
        return
      }
      const slot = supervisorEvalHistoryByEmployee?.[empId]?.[periodKey]
      if (!String(slot?.submittedAt ?? '').trim()) return
      const used = clampEvalSubmissionWithdrawalsUsed(slot?.submissionWithdrawalsUsed)
      if (used >= MAX_EVAL_SUBMISSION_WITHDRAWALS) {
        window.alert(`この評価期での提出取り消しは${MAX_EVAL_SUBMISSION_WITHDRAWALS}回までです。`)
        return
      }
      const nextUsed = used + 1
      const remaining = MAX_EVAL_SUBMISSION_WITHDRAWALS - nextUsed
      const empLabel =
        String(employeeDirectoryRows.find((r) => String(r?.id ?? '').trim() === empId)?.name ?? '').trim() || empId
      if (
        !window.confirm(
          `${empLabel} の1次評価(上司)（${periodKey}）の提出を取り消しますか？\n\n再編集できます。取り消しはこの評価期であと${remaining}回行えます（今回で${nextUsed}回目）。`,
        )
      )
        return
      setSupervisorEvalHistoryByEmployee((prev) => {
        const current = prev?.[empId]?.[periodKey] ?? {}
        return {
          ...(prev ?? {}),
          [empId]: {
            ...((prev ?? {})[empId] ?? {}),
            [periodKey]: {
              ...current,
              submittedAt: '',
              submissionWithdrawalsUsed: nextUsed,
            },
          },
        }
      })
    },
    [effectiveEvalPeriodKey, evalPeriodDefinitions, supervisorEvalHistoryByEmployee, employeeDirectoryRows],
  )

  const submitSelfEvalForActivePeriod = useCallback(() => {
    if (!evalSubjectEmployee?.id || !effectiveEvalPeriodKey) return
    if (isSelfEvalDeadlineLocked) return
    const confirmed = window.confirm(`自己評価（${effectiveEvalPeriodKey}）を提出しますか？提出後はこの期を編集できません。`)
    if (!confirmed) return
    const now = new Date().toISOString()
    setSelfEvalHistoryByEmployee((prev) => {
      const empId = evalSubjectEmployee.id
      const current = prev?.[empId]?.[effectiveEvalPeriodKey] ?? {}
      return {
        ...(prev ?? {}),
        [empId]: {
          ...((prev ?? {})[empId] ?? {}),
          [effectiveEvalPeriodKey]: {
            ...current,
            submittedAt: now,
            resubmitRequestedAt: '',
            resubmitReason: '',
            submissionWithdrawalsUsed: clampEvalSubmissionWithdrawalsUsed(current.submissionWithdrawalsUsed),
          },
        },
      }
    })
  }, [evalSubjectEmployee?.id, effectiveEvalPeriodKey, selfBossGapForPeriod, isSelfEvalDeadlineLocked])

  const submitSupervisorEvalForActivePeriod = useCallback(() => {
    if (!evalSubjectEmployee?.id || !effectiveEvalPeriodKey) return
    if (isSupervisorEvalDeadlineLocked) return
    const confirmed = window.confirm(`1次評価(上司)（${effectiveEvalPeriodKey}）を提出しますか？提出後はこの期を編集できません。`)
    if (!confirmed) return
    const now = new Date().toISOString()
    setSupervisorEvalHistoryByEmployee((prev) => {
      const empId = evalSubjectEmployee.id
      const current = prev?.[empId]?.[effectiveEvalPeriodKey] ?? {}
      return {
        ...(prev ?? {}),
        [empId]: {
          ...((prev ?? {})[empId] ?? {}),
          [effectiveEvalPeriodKey]: {
            ...current,
            submittedAt: now,
            submissionWithdrawalsUsed: clampEvalSubmissionWithdrawalsUsed(current.submissionWithdrawalsUsed),
          },
        },
      }
    })
    const gap = selfBossGapForPeriod(evalSubjectEmployee.id, effectiveEvalPeriodKey)
    if (Number.isFinite(gap) && gap >= SELF_BOSS_GAP_ALERT_THRESHOLD) {
      const selfLocked = isSelfEvalDeadlineLockedForPeriod(evalPeriodDefinitions, effectiveEvalPeriodKey)
      setSelfEvalHistoryByEmployee((prev) => {
        const empId = evalSubjectEmployee.id
        const current = prev?.[empId]?.[effectiveEvalPeriodKey]
        if (!current) return prev
        return {
          ...(prev ?? {}),
          [empId]: {
            ...((prev ?? {})[empId] ?? {}),
            [effectiveEvalPeriodKey]: {
              ...current,
              ...(selfLocked ? {} : { submittedAt: '' }),
              resubmitRequestedAt: now,
              resubmitReason: `1次評価との乖離が${gap.toFixed(1)}点のため再提出が必要です`,
              submissionWithdrawalsUsed: clampEvalSubmissionWithdrawalsUsed(current?.submissionWithdrawalsUsed),
            },
          },
        }
      })
      if (selfLocked) {
        window.alert(`自己/1次評価の乖離が${gap.toFixed(1)}点です。自己評価締切後のため、提出状態は維持したまま再確認依頼を記録しました。`)
      } else {
        window.alert(`自己/1次評価の乖離が${gap.toFixed(1)}点です。自己評価の再提出を依頼しました。`)
      }
    }
  }, [evalSubjectEmployee?.id, effectiveEvalPeriodKey, isSupervisorEvalDeadlineLocked, evalPeriodDefinitions])
  const submitSupervisorEvalForMember = useCallback(
    (employeeId, periodKeyOverride) => {
      const empId = String(employeeId ?? '').trim()
      const periodKey = String(periodKeyOverride ?? effectiveEvalPeriodKey ?? '').trim()
      if (!empId || !periodKey) return
      if (isSupervisorEvalDeadlineLockedForPeriod(evalPeriodDefinitions, periodKey)) return
      const confirmed = window.confirm(`1次評価(上司)（${periodKey}）を提出しますか？提出後はこの期を編集できません。`)
      if (!confirmed) return
      const now = new Date().toISOString()
      setSupervisorEvalHistoryByEmployee((prev) => {
        const current = prev?.[empId]?.[periodKey] ?? {}
        return {
          ...(prev ?? {}),
          [empId]: {
            ...((prev ?? {})[empId] ?? {}),
            [periodKey]: {
              ...current,
              submittedAt: now,
              submissionWithdrawalsUsed: clampEvalSubmissionWithdrawalsUsed(current.submissionWithdrawalsUsed),
            },
          },
        }
      })
      const gap = selfBossGapForPeriod(empId, periodKey)
      if (Number.isFinite(gap) && gap >= SELF_BOSS_GAP_ALERT_THRESHOLD) {
        const selfLocked = isSelfEvalDeadlineLockedForPeriod(evalPeriodDefinitions, periodKey)
        setSelfEvalHistoryByEmployee((prev) => {
          const current = prev?.[empId]?.[periodKey]
          if (!current) return prev
          return {
            ...(prev ?? {}),
            [empId]: {
              ...((prev ?? {})[empId] ?? {}),
              [periodKey]: {
                ...current,
                ...(selfLocked ? {} : { submittedAt: '' }),
                resubmitRequestedAt: now,
                resubmitReason: `1次評価との乖離が${gap.toFixed(1)}点のため再提出が必要です`,
                submissionWithdrawalsUsed: clampEvalSubmissionWithdrawalsUsed(current?.submissionWithdrawalsUsed),
              },
            },
          }
        })
        if (selfLocked) {
          window.alert(`自己/1次評価の乖離が${gap.toFixed(1)}点です。自己評価締切後のため、提出状態は維持したまま再確認依頼を記録しました。`)
        } else {
          window.alert(`自己/1次評価の乖離が${gap.toFixed(1)}点です。自己評価の再提出を依頼しました。`)
        }
      }
    },
    [effectiveEvalPeriodKey, evalPeriodDefinitions, selfBossGapForPeriod],
  )
  const submitExecutiveEvalForActivePeriod = useCallback(() => {
    if (!evalSubjectEmployee?.id || !effectiveEvalPeriodKey) return
    if (isExecutiveEvalDeadlineLocked) return
    const confirmed = window.confirm(`2次評価(経営層)（${effectiveEvalPeriodKey}）を提出しますか？提出後はこの期を編集できません。`)
    if (!confirmed) return
    const now = new Date().toISOString()
    setExecutiveEvalHistoryByEmployee((prev) => {
      const empId = evalSubjectEmployee.id
      const current = prev?.[empId]?.[effectiveEvalPeriodKey] ?? {}
      return {
        ...(prev ?? {}),
        [empId]: {
          ...((prev ?? {})[empId] ?? {}),
          [effectiveEvalPeriodKey]: {
            ...current,
            submittedAt: now,
          },
        },
      }
    })
  }, [evalSubjectEmployee?.id, effectiveEvalPeriodKey, isExecutiveEvalDeadlineLocked])
  const submitExecutiveEvalForMember = useCallback(
    (employeeId, periodKeyOverride) => {
      const empId = String(employeeId ?? '').trim()
      const periodKey = String(periodKeyOverride ?? effectiveEvalPeriodKey ?? '').trim()
      if (!empId || !periodKey) return
      if (isExecutiveEvalDeadlineLockedForPeriod(evalPeriodDefinitions, periodKey)) return
      const confirmed = window.confirm(`2次評価(経営層)（${periodKey}）を提出しますか？提出後はこの期を編集できません。`)
      if (!confirmed) return
      const now = new Date().toISOString()
      setExecutiveEvalHistoryByEmployee((prev) => {
        const current = prev?.[empId]?.[periodKey] ?? {}
        return {
          ...(prev ?? {}),
          [empId]: {
            ...((prev ?? {})[empId] ?? {}),
            [periodKey]: {
              ...current,
              submittedAt: now,
            },
          },
        }
      })
    },
    [effectiveEvalPeriodKey, evalPeriodDefinitions],
  )

  const cleanupEvalPeriodHistory = useCallback(() => {
    const allowed = new Set(
      (evalPeriodDefinitions ?? []).map((d) => String(d?.key ?? '').trim()).filter(Boolean),
    )
    if (!allowed.size) return 0
    const selfResult = pruneEvalHistoryMapByAllowedKeys(selfEvalHistoryByEmployee, allowed)
    const supervisorResult = pruneEvalHistoryMapByAllowedKeys(supervisorEvalHistoryByEmployee, allowed)
    setSelfEvalHistoryByEmployee(selfResult.next)
    setSupervisorEvalHistoryByEmployee(supervisorResult.next)
    setActiveEvalPeriodKey((prev) => {
      const v = String(prev ?? '').trim()
      if (v && allowed.has(v)) return prev
      return getSuggestedEvalPeriodKey(evalPeriodDefinitions)
    })
    return selfResult.removed + supervisorResult.removed
  }, [
    evalPeriodDefinitions,
    selfEvalHistoryByEmployee,
    supervisorEvalHistoryByEmployee,
  ])
  const removeEvalPeriodKeyEverywhere = useCallback((periodKey) => {
    const target = String(periodKey ?? '').trim()
    if (!target) return 0
    const pruneOneKey = (historyMap) => {
      if (!historyMap || typeof historyMap !== 'object' || Array.isArray(historyMap)) return historyMap
      const next = {}
      for (const [employeeId, periods] of Object.entries(historyMap)) {
        if (!periods || typeof periods !== 'object' || Array.isArray(periods)) continue
        const kept = Object.fromEntries(
          Object.entries(periods).filter(([k]) => String(k ?? '').trim() !== target),
        )
        if (Object.keys(kept).length > 0) next[employeeId] = kept
      }
      return next
    }
    setSelfEvalHistoryByEmployee((prev) => pruneOneKey(prev))
    setSupervisorEvalHistoryByEmployee((prev) => pruneOneKey(prev))
    setExecutiveEvalHistoryByEmployee((prev) => pruneOneKey(prev))
    updateEmployeeDirectoryRowsLocal((prev) =>
      (prev ?? []).map((row) => {
        const current = normalizeExtraEvalPeriodsForEmployee(row)
        const next = current.filter((p) => String(p?.key ?? '').trim() !== target)
        if (next.length === current.length) return row
        return { ...row, extraEvalPeriods: next }
      }),
    )
    setActiveEvalPeriodKey((prev) => (String(prev ?? '').trim() === target ? '' : prev))
    return 1
  }, [updateEmployeeDirectoryRowsLocal])


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
        const currentRaw = prev?.[evalSubjectEmployee.id] ?? { scores: {}, comments: {}, commentHistory: [] }
        const cur = { scores: currentRaw.scores ?? {}, comments: currentRaw.comments ?? {} }
        const next = typeof updater === 'function' ? updater(cur) : updater
        return {
          ...(prev ?? {}),
          [evalSubjectEmployee.id]: {
            ...currentRaw,
            scores: { ...(next?.scores ?? {}) },
            comments: { ...(next?.comments ?? {}) },
          },
        }
      })
    },
    [evalSubjectEmployee],
  )

  const updateExecutiveEvalForSubject = useCallback(
    (updater) => {
      if (!evalSubjectEmployee) return
      setExecutiveEvalByEmployee((prev) => {
        const cur = prev[evalSubjectEmployee.id] ?? { baseScore: 0, baseByMajor: {}, commentHistory: [] }
        const next = typeof updater === 'function' ? updater(cur) : updater
        return { ...prev, [evalSubjectEmployee.id]: next }
      })
    },
    [evalSubjectEmployee],
  )

  useLayoutEffect(() => {
    let timer = null
    const fromHistory = (hist, normalizer) => {
      const perEmp = {}
      for (const [empId, periods] of Object.entries(hist ?? {})) {
        if (!periods || typeof periods !== 'object' || Array.isArray(periods)) continue
        if (!effectiveEvalPeriodKey || !periods[effectiveEvalPeriodKey]) continue
        perEmp[empId] = periods[effectiveEvalPeriodKey]
      }
      return normalizer(perEmp)
    }
    const nextSelf = fromHistory(selfEvalHistoryByEmployee, normalizeEvalByEmployeeMap)
    const nextSupervisor = fromHistory(supervisorEvalHistoryByEmployee, normalizeEvalByEmployeeMap)
    const fromExecutiveHistory = (hist) => {
      const perEmp = {}
      for (const [empId, periods] of Object.entries(hist ?? {})) {
        if (!empId || !periods || typeof periods !== 'object' || Array.isArray(periods)) continue
        if (!effectiveEvalPeriodKey) continue
        const slot = periods[effectiveEvalPeriodKey]
        if (!slot || typeof slot !== 'object' || Array.isArray(slot)) continue
        const normalized = normalizeExecutiveEvalByEmployeeMap({ [empId]: slot })[empId]
        if (normalized) perEmp[empId] = normalized
      }
      return perEmp
    }
    const nextExecutive = fromExecutiveHistory(executiveEvalHistoryByEmployee)
    setSelfEvalByEmployee((prev) => (areEvalStateMapsEqual(prev, nextSelf) ? prev : nextSelf))
    setSupervisorEvalByEmployee((prev) => {
      if (areEvalStateMapsEqual(prev, nextSupervisor)) return prev
      const merged = {}
      for (const [empId, state] of Object.entries(nextSupervisor ?? {})) {
        merged[empId] = {
          ...state,
          commentHistory: Array.isArray(prev?.[empId]?.commentHistory) ? prev[empId].commentHistory : [],
        }
      }
      return merged
    })
    setExecutiveEvalByEmployee((prev) =>
      areExecutiveEvalStateMapsEqual(prev, nextExecutive) ? prev : nextExecutive,
    )
    const periodKey = String(effectiveEvalPeriodKey ?? '').trim()
    selfEvalStatePeriodRef.current = periodKey
    supervisorEvalStatePeriodRef.current = periodKey
    executiveEvalStatePeriodRef.current = periodKey
    if (isEvalPeriodSwitching) {
      const elapsed = Date.now() - Number(evalPeriodSwitchStartedAtRef.current || 0)
      const waitMs = Math.max(0, 220 - elapsed)
      if (waitMs <= 0) {
        setIsEvalPeriodSwitching(false)
      } else {
        timer = window.setTimeout(() => setIsEvalPeriodSwitching(false), waitMs)
      }
    }
    return () => {
      if (timer) window.clearTimeout(timer)
    }
  }, [
    effectiveEvalPeriodKey,
    selfEvalHistoryByEmployee,
    supervisorEvalHistoryByEmployee,
    executiveEvalHistoryByEmployee,
    isEvalPeriodSwitching,
  ])

  useEffect(() => {
    if (workspaceView === 'admin') return
    const now = new Date().toISOString()
    const periodKey = String(effectiveEvalPeriodKey ?? '').trim()
    if (!periodKey) return
    if (lastSelfEvalSyncPeriodRef.current !== periodKey) {
      lastSelfEvalSyncPeriodRef.current = periodKey
      return
    }
    if (selfEvalStatePeriodRef.current !== periodKey) return
    setSelfEvalHistoryByEmployee((prev) => {
      const base = prev ?? {}
      let next = base
      let changed = false
      for (const [empId, state] of Object.entries(selfEvalByEmployee ?? {})) {
        const evalGradeNow = String(evalGradeByEmployeeId[empId] ?? '').trim()
        const prevEmp = base[empId] ?? {}
        const prevSlot = prevEmp[periodKey]
        const isSubmitted = Boolean(String(prevSlot?.submittedAt ?? '').trim())
        const existingGrade = String(prevSlot?.evalGrade ?? '').trim()
        const nextEvalGrade = isSubmitted ? (existingGrade || evalGradeNow || '') : (evalGradeNow || existingGrade || '')
        const sameScores = areShallowStringMapEqual(prevSlot?.scores, state?.scores)
        const sameComments = areShallowStringMapEqual(prevSlot?.comments, state?.comments)
        const sameGrade = String(prevSlot?.evalGrade ?? '') === nextEvalGrade
        if (sameScores && sameComments && sameGrade) continue
        if (!changed) {
          next = { ...base }
          changed = true
        }
        const prevWithdrawals = clampEvalSubmissionWithdrawalsUsed(prevSlot?.submissionWithdrawalsUsed)
        next[empId] = {
          ...prevEmp,
          [periodKey]: {
            ...state,
            savedAt: now,
            ...(nextEvalGrade ? { evalGrade: nextEvalGrade } : {}),
            ...(String(prevSlot?.submittedAt ?? '').trim() ? { submittedAt: prevSlot.submittedAt } : {}),
            ...(prevWithdrawals > 0 ? { submissionWithdrawalsUsed: prevWithdrawals } : {}),
          },
        }
      }
      return changed ? next : prev
    })
  }, [selfEvalByEmployee, evalGradeByEmployeeId, effectiveEvalPeriodKey, workspaceView])

  useEffect(() => {
    if (workspaceView === 'admin') return
    const now = new Date().toISOString()
    const periodKey = String(effectiveEvalPeriodKey ?? '').trim()
    if (!periodKey) return
    if (lastSupervisorEvalSyncPeriodRef.current !== periodKey) {
      lastSupervisorEvalSyncPeriodRef.current = periodKey
      return
    }
    if (supervisorEvalStatePeriodRef.current !== periodKey) return
    setSupervisorEvalHistoryByEmployee((prev) => {
      const base = prev ?? {}
      let next = base
      let changed = false
      for (const [empId, state] of Object.entries(supervisorEvalByEmployee ?? {})) {
        const evalGradeNow = String(evalGradeByEmployeeId[empId] ?? '').trim()
        const prevEmp = base[empId] ?? {}
        const prevSlot = prevEmp[periodKey]
        const isSubmitted = Boolean(String(prevSlot?.submittedAt ?? '').trim())
        const existingGrade = String(prevSlot?.evalGrade ?? '').trim()
        const nextEvalGrade = isSubmitted ? (existingGrade || evalGradeNow || '') : (evalGradeNow || existingGrade || '')
        const sameScores = areShallowStringMapEqual(prevSlot?.scores, state?.scores)
        const sameComments = areShallowStringMapEqual(prevSlot?.comments, state?.comments)
        const sameGrade = String(prevSlot?.evalGrade ?? '') === nextEvalGrade
        if (sameScores && sameComments && sameGrade) continue
        if (!changed) {
          next = { ...base }
          changed = true
        }
        const prevWithdrawals = clampEvalSubmissionWithdrawalsUsed(prevSlot?.submissionWithdrawalsUsed)
        next[empId] = {
          ...prevEmp,
          [periodKey]: {
            ...state,
            savedAt: now,
            ...(nextEvalGrade ? { evalGrade: nextEvalGrade } : {}),
            ...(String(prevSlot?.submittedAt ?? '').trim() ? { submittedAt: prevSlot.submittedAt } : {}),
            ...(prevWithdrawals > 0 ? { submissionWithdrawalsUsed: prevWithdrawals } : {}),
          },
        }
      }
      return changed ? next : prev
    })
  }, [supervisorEvalByEmployee, evalGradeByEmployeeId, effectiveEvalPeriodKey, workspaceView])

  useEffect(() => {
    if (workspaceView === 'admin') return
    const now = new Date().toISOString()
    const periodKey = String(effectiveEvalPeriodKey ?? '').trim()
    if (periodKey && lastExecutiveEvalSyncPeriodRef.current !== periodKey) {
      lastExecutiveEvalSyncPeriodRef.current = periodKey
      return
    }
    if (periodKey && executiveEvalStatePeriodRef.current !== periodKey) return
    setExecutiveEvalHistoryByEmployee((prev) => {
      const next = { ...(prev ?? {}) }
      for (const [empId, state] of Object.entries(executiveEvalByEmployee ?? {})) {
        const prevEmp = next[empId] ?? {}
        const prevSlot = periodKey ? prevEmp?.[periodKey] : null
        next[empId] = {
          ...prevEmp,
          cumulative: { ...state, savedAt: now },
          ...(periodKey
            ? {
                [periodKey]: {
                  ...state,
                  savedAt: now,
                  ...(String(prevSlot?.submittedAt ?? '').trim() ? { submittedAt: prevSlot.submittedAt } : {}),
                },
              }
            : {}),
        }
      }
      return next
    })
  }, [executiveEvalByEmployee, effectiveEvalPeriodKey, workspaceView])

  const renameEmployeeIdInAppState = useCallback((oldId, newId) => {
    const o = String(oldId ?? '').trim()
    const n = String(newId ?? '').trim()
    if (!o || !n || o === n) return
    const moveKey = (prev) => {
      if (!prev || typeof prev !== 'object' || Array.isArray(prev) || !Object.prototype.hasOwnProperty.call(prev, o)) {
        return prev
      }
      const next = { ...prev }
      next[n] = prev[o]
      delete next[o]
      return next
    }
    setSkillEmployeeProgress((prev) => moveKey(prev))
    setSkillProgressUpdatedAtByEmployee((prev) => moveKey(prev))
    setGoalsByEmployee((prev) => moveKey(prev))
    setSelfEvalByEmployee((prev) => moveKey(prev))
    setSupervisorEvalByEmployee((prev) => moveKey(prev))
    setExecutiveEvalByEmployee((prev) => moveKey(prev))
    setSelfEvalHistoryByEmployee((prev) => moveKey(prev))
    setSupervisorEvalHistoryByEmployee((prev) => moveKey(prev))
    setExecutiveEvalHistoryByEmployee((prev) => moveKey(prev))
    setLoggedInEmployeeId((cur) => (cur === o ? n : cur))
    setSelectedEvalEmployeeId((cur) => (cur === o ? n : cur))
    setAdminSelectedMemberId((cur) => (cur === o ? n : cur))
  }, [])

  const deleteKeyedObjectEntryByTrimmedId = useCallback((setter, rawEmployeeId) => {
    const target = String(rawEmployeeId ?? '').trim()
    if (!target) return
    setter((prev) => {
      if (!prev || typeof prev !== 'object') return prev
      const matchKey = Object.keys(prev).find((k) => String(k ?? '').trim() === target)
      if (matchKey === undefined) return prev
      const next = { ...prev }
      delete next[matchKey]
      return next
    })
  }, [])

  const clearSkillProgressForEmployees = useCallback((employeeIds) => {
    if (!Array.isArray(employeeIds) || employeeIds.length === 0) return
    const idSet = new Set(employeeIds.map((x) => String(x ?? '').trim()).filter(Boolean))
    if (idSet.size === 0) return
    const deleteMatches = (prev) => {
      if (!prev || typeof prev !== 'object') return prev
      let changed = false
      const next = { ...prev }
      for (const id of idSet) {
        const matchKey = Object.keys(next).find((k) => String(k ?? '').trim() === id)
        if (matchKey !== undefined) {
          delete next[matchKey]
          changed = true
        }
      }
      return changed ? next : prev
    }
    setSkillEmployeeProgress(deleteMatches)
    setSkillProgressUpdatedAtByEmployee(deleteMatches)
  }, [])

  /** 全従業員のスキル進捗から、指定したスキルIDのキーを削除する（区分削除・スキル一括削除用） */
  const removeSkillProgressKeysGlobally = useCallback((skillIds) => {
    if (!Array.isArray(skillIds) || skillIds.length === 0) return
    const keySet = new Set(skillIds.map((id) => String(id ?? '').trim()).filter(Boolean))
    if (keySet.size === 0) return
    setSkillEmployeeProgress((prev) => {
      if (!prev || typeof prev !== 'object') return prev
      let changed = false
      const next = { ...prev }
      for (const empId of Object.keys(next)) {
        const prog = next[empId]
        if (!prog || typeof prog !== 'object' || Array.isArray(prog)) continue
        const empNext = { ...prog }
        let empChanged = false
        for (const sid of keySet) {
          if (Object.prototype.hasOwnProperty.call(empNext, sid)) {
            delete empNext[sid]
            empChanged = true
          }
        }
        if (empChanged) {
          next[empId] = empNext
          changed = true
        }
      }
      return changed ? next : prev
    })
  }, [])

  const submitPromotionRequest = useCallback((employeeId, employeeName, fromGrade) => {
    const id = String(employeeId ?? '').trim()
    const toGrade = nextPromotionGrade(fromGrade)
    if (!id || !toGrade) {
      window.alert('これ以上昇級できない等級です。')
      return
    }
    let didAdd = false
    setPromotionRequests((prev) => {
      if (prev.some((r) => String(r.employeeId) === id && r.status === 'pending')) return prev
      didAdd = true
      return [
        ...prev,
        {
          id: `promo_${Date.now()}_${id}`,
          employeeId: id,
          employeeName: String(employeeName ?? '').trim() || id,
          fromGrade: normalizeEmployeeGrade(fromGrade),
          toGrade,
          status: 'pending',
          requestedAt: new Date().toISOString(),
          reviewedAt: '',
        },
      ]
    })
    if (didAdd) {
      window.alert(
        '昇級の申請を送信しました。\n\n評価者用に「昇級の申請があります。管理者は許可または却下をしてください。」と表示されます。承認までお待ちください。',
      )
    } else {
      window.alert('この社員にはすでに処理待ちの昇級申請があります。')
    }
  }, [])

  const approvePromotionRequest = useCallback(
    (requestId) => {
      setPromotionRequests((prev) => {
        const req = prev.find((r) => r.id === requestId && r.status === 'pending')
        if (!req) return prev
        return prev.map((r) =>
          r.id === requestId ? { ...r, status: 'approved', reviewedAt: new Date().toISOString() } : r,
        )
      })

      const req = promotionRequests.find((r) => r.id === requestId && r.status === 'pending')
      if (!req) return
      const employeeId = String(req.employeeId ?? '').trim()
      const toGrade = normalizeEmployeeGrade(req.toGrade)
      let matched = false
      updateEmployeeDirectoryRowsLocal((rows) =>
        rows.map((row) => {
          if (String(row.id ?? '').trim() !== employeeId) return row
          matched = true
          return { ...row, grade: toGrade }
        }),
      )
      if (!matched) {
        window.alert(
          '昇級は記録しましたが、従業員一覧に該当する社員Cが見つかりませんでした。社員Cの表記（空白の有無など）が申請時と一致しているか確認してください。',
        )
        return
      }
      clearSkillProgressForEmployees([employeeId])
      deleteKeyedObjectEntryByTrimmedId(setSelfEvalByEmployee, employeeId)
      deleteKeyedObjectEntryByTrimmedId(setSupervisorEvalByEmployee, employeeId)
      window.alert(
        '昇級を許可しました。等級を更新し、スキル進捗・自己評価・上司評価をリセットしました。（役員評価はそのまま残します）',
      )
    },
    [clearSkillProgressForEmployees, deleteKeyedObjectEntryByTrimmedId, promotionRequests, updateEmployeeDirectoryRowsLocal],
  )

  const rejectPromotionRequest = useCallback((requestId) => {
    if (!window.confirm('この昇級申請を却下しますか？')) return
    setPromotionRequests((prev) => {
      const req = prev.find((r) => r.id === requestId && r.status === 'pending')
      if (!req) return prev
      return prev.map((r) =>
        r.id === requestId ? { ...r, status: 'rejected', reviewedAt: new Date().toISOString() } : r,
      )
    })
  }, [])

  const menuRoleKey = useMemo(
    () => resolveMenuRoleKey(email.trim().toLowerCase(), employeeDirectoryRows),
    [email, employeeDirectoryRows],
  )

  const extraVisibleMenuKeysForCurrentUser = useMemo(() => {
    if (loginMode === 'admin') return []
    const employeeId = String(loggedInEmployeeId ?? '').trim()
    if (!employeeId) return []
    const row = employeeDirectoryRows.find((r) => String(r.id ?? '').trim() === employeeId)
    return normalizeEmployeeExtraMenuKeys(row?.extraMenuKeys)
  }, [loginMode, loggedInEmployeeId, employeeDirectoryRows])

  const isWorkspaceMenuVisible = useCallback(
    (key) => {
      if (extraVisibleMenuKeysForCurrentUser.includes(key)) return true
      return isWorkspaceVisibleForRole(key, menuRoleKey, menuVisibilityByRole)
    },
    [menuRoleKey, menuVisibilityByRole, extraVisibleMenuKeysForCurrentUser],
  )

  const visibleWorkspaceTabs = useMemo(
    () => MAIN_WORKSPACE_TAB_ORDER.filter((tab) => isWorkspaceMenuVisible(tab.key)),
    [isWorkspaceMenuVisible],
  )
  const effectiveWorkspaceView = useMemo(() => {
    if (loginMode === 'admin') return workspaceView
    if (isWorkspaceMenuVisible(workspaceView)) return workspaceView
    return visibleWorkspaceTabs[0]?.key ?? 'gyoseki'
  }, [loginMode, workspaceView, isWorkspaceMenuVisible, visibleWorkspaceTabs])

  useEffect(() => {
    if (!isLoggedIn || loginMode === 'admin') return
    if (workspaceView === effectiveWorkspaceView) return
    setWorkspaceView(effectiveWorkspaceView)
  }, [isLoggedIn, loginMode, workspaceView, effectiveWorkspaceView])


  const handleLogin = (event) => {
    event.preventDefault()

    const normalizedLoginId = email.trim().toLowerCase()
    const normalizedPassword = String(password ?? '').trim()
    if (loginMode === 'admin') {
      if (normalizedLoginId === 'admin@example.com' && normalizedPassword === String(adminPassword ?? '').trim()) {
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
          .toLowerCase() === normalizedLoginId && String(row.password ?? '').trim() === normalizedPassword,
    )
    if (matchedEmployee) {
      setIsLoggedIn(true)
      setLoggedInEmployeeId(matchedEmployee.id)
      setLoginError('')
      return
    }
    setLoginError('社員Noまたはパスワードが違います。')
  }

  const closeResetModal = () => {
    setResetModalOpen(false)
    setResetFeedback('')
    setResetFeedbackType('error')
  }

  const handlePasswordReset = (event) => {
    event.preventDefault()
    const id = resetId.trim().toLowerCase()
    const normalizedPrevPassword = String(resetPrevPassword ?? '').trim()
    const normalizedNextPassword = String(resetNextPassword ?? '').trim()
    if (!id || !normalizedPrevPassword || !normalizedNextPassword) {
      setResetFeedbackType('error')
      setResetFeedback('すべての項目を入力してください。')
      return
    }
    if (id === 'admin@example.com') {
      if (normalizedPrevPassword !== String(adminPassword ?? '').trim()) {
        setResetFeedbackType('error')
        setResetFeedback('以前のパスワードが違います。')
        return
      }
      setAdminPassword(normalizedNextPassword)
      setResetFeedbackType('success')
      setResetFeedback('パスワードを変更しました。')
      setPassword('')
      setEmail('admin@example.com')
      setLoginMode('admin')
      setResetId('')
      setResetPrevPassword('')
      setResetNextPassword('')
      return
    }

    const target = employeeDirectoryRows.find((row) => {
      const idMatch =
        String(row.id ?? '')
          .trim()
          .toLowerCase() === id
      const emailMatch =
        String(row.email ?? '')
          .trim()
          .toLowerCase() === id
      return idMatch || emailMatch
    })
    if (!target || String(target.password ?? '').trim() !== normalizedPrevPassword) {
      setResetFeedbackType('error')
      setResetFeedback('以前のパスワードが違います。')
      return
    }
    updateEmployeeDirectoryRowsLocal((prev) =>
      prev.map((row) => (String(row.id ?? '').trim() === String(target.id ?? '').trim() ? { ...row, password: normalizedNextPassword } : row)),
    )
    setResetFeedbackType('success')
    setResetFeedback('パスワードを変更しました。')
    setResetId('')
    setResetPrevPassword('')
    setResetNextPassword('')
  }

  const handleLogout = () => {
    setIsLoggedIn(false)
    setLoggedInEmployeeId(null)
  }

  const saveCloudState = useCallback(async (payload, options = {}) => {
    const { silent = false } = options
    if (!supabase) {
      if (!silent) setSyncMessage('Supabase未設定（ローカル保存のみ）')
      setSyncError('Supabaseが未設定です。.env.local の設定を確認してください。')
      return false
    }
    if (!silent) setSyncMessage('Supabaseに保存中...')
    const { error } = await supabase
      .from('app_state')
      .upsert({ id: CLOUD_STATE_ID, payload }, { onConflict: 'id' })
    if (error) {
      setSyncMessage('Supabase保存失敗（ローカル保存は有効）')
      setSyncError('クラウド保存に失敗しました。ネットワークまたはSupabase設定を確認して再試行してください。')
      return false
    }
    if (!silent) setSyncMessage('Supabaseに保存済み')
    setSyncError('')
    return true
  }, [])

  const handleRetryCloudSync = async () => {
    const payload = buildPersistPayload(true, { includeEvalDrafts: false })
    await saveCloudState(payload)
  }

  const buildPersistPayload = (includeSensitive = true, options = {}) => {
    const { includeEvalDrafts = true, includeUiState = true } = options
    const persistedSelfEvalHistory = includeEvalDrafts
      ? selfEvalHistoryByEmployee
      : filterCommittedEvalHistoryMap(selfEvalHistoryByEmployee)
    const persistedSupervisorEvalHistory = includeEvalDrafts
      ? supervisorEvalHistoryByEmployee
      : filterCommittedEvalHistoryMap(supervisorEvalHistoryByEmployee)
    const persistedExecutiveEvalHistory = includeEvalDrafts
      ? executiveEvalHistoryByEmployee
      : filterCommittedEvalHistoryMap(executiveEvalHistoryByEmployee)
    const payload = {
    rows,
      employeeDirectoryRows: includeSensitive ? employeeDirectoryRows : stripSensitiveEmployeeFields(employeeDirectoryRows),
    skillSettings,
    skillSections,
    skillGrades,
    skillActiveGradeId,
    skillEmployeeProgress,
    skillProgressUpdatedAtByEmployee,
      goalsByEmployeePeriod,
      goalDirectionByEmployeePeriod,
      goalFocusMajorByEmployeePeriod,
      goalSubmissionByEmployee,
    evaluationCriteria,
    menuVisibilityByRole,
      ...(includeUiState ? { activeEvalPeriodKey } : {}),
      evalPeriodDefinitions,
    ...(includeEvalDrafts
      ? {
          selfEvalByEmployee,
          supervisorEvalByEmployee,
          executiveEvalByEmployee,
        }
      : {}),
      selfEvalHistoryByEmployee: persistedSelfEvalHistory,
      supervisorEvalHistoryByEmployee: persistedSupervisorEvalHistory,
      executiveEvalHistoryByEmployee: persistedExecutiveEvalHistory,
      countCurrent,
      countHourlyTarget,
      countIsRunning,
    departmentSalesDenture,
    departmentSalesCk,
    performanceRatePercentDenture,
    performanceRatePercentCk,
    targetSpecialDentureTotal,
    targetSpecialCkTotal,
    ...(includeUiState
      ? {
          sortKey,
          sortOrder,
          gyosekiTeamFilter,
          gyosekiRowView,
          workspaceView,
          settingsTab,
          activePage,
          snapshotPeriod,
        }
      : {}),
      employeeDeptOptions,
      promotionRequests,
    }
    if (includeSensitive) payload.adminPassword = adminPassword
    return payload
  }

  const buildPersistPayloadRef = useRef(() => ({}))
  buildPersistPayloadRef.current = () => buildPersistPayload(true)

  const applyPersistPayload = (payload, options = {}) => {
    const {
      includeUiState = true,
      mergeEvalHistories = false,
      includeEvalDrafts = true,
      includeEmployeeDirectory = true,
      includeSettingsData = true,
      includeEvaluationCriteria = false,
      forceEmployeeDirectory = false,
    } = options
    const cloudRows = Array.isArray(payload.rows) && payload.rows.length > 0 ? payload.rows : null
    if (cloudRows) setRows(cloudRows)
    if (
      includeEmployeeDirectory &&
      (!employeeDirectoryDirtyRef.current || forceEmployeeDirectory) &&
      Array.isArray(payload.employeeDirectoryRows) &&
      payload.employeeDirectoryRows.length > 0
    ) {
      setEmployeeDirectoryRows(normalizeEmployeeDirectoryRows(payload.employeeDirectoryRows))
      employeeDirectoryDirtyRef.current = false
    }
    if (
      includeEmployeeDirectory &&
      (!employeeDirectoryDirtyRef.current || forceEmployeeDirectory) &&
      Array.isArray(payload.employeeDeptOptions)
    ) {
      const rowsForDept =
        Array.isArray(payload.employeeDirectoryRows) && payload.employeeDirectoryRows.length > 0
          ? normalizeEmployeeDirectoryRows(payload.employeeDirectoryRows)
          : undefined
      setEmployeeDeptOptions(mergeEmployeeDeptOptionsFromRows(payload.employeeDeptOptions, rowsForDept))
    } else if (
      includeEmployeeDirectory &&
      (!employeeDirectoryDirtyRef.current || forceEmployeeDirectory) &&
      Array.isArray(payload.employeeDirectoryRows) &&
      payload.employeeDirectoryRows.length > 0
    ) {
      setEmployeeDeptOptions((prev) =>
        mergeEmployeeDeptOptionsFromRows(prev, normalizeEmployeeDirectoryRows(payload.employeeDirectoryRows)),
      )
    }
    if (includeSettingsData && Array.isArray(payload.skillSettings)) {
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
    if (includeSettingsData && Array.isArray(payload.skillGrades) && payload.skillGrades.length > 0) {
      const cleaned = payload.skillGrades.filter(
        (g) => g && typeof g.id === 'string' && typeof g.label === 'string',
      )
      if (cleaned.length > 0) setSkillGrades(cleaned)
    }
    if (includeSettingsData && typeof payload.skillActiveGradeId === 'string' && payload.skillActiveGradeId) {
      setSkillActiveGradeId(payload.skillActiveGradeId)
    }
    if (
      includeSettingsData &&
      payload.skillEmployeeProgress &&
      typeof payload.skillEmployeeProgress === 'object' &&
      !Array.isArray(payload.skillEmployeeProgress)
    ) {
      setSkillEmployeeProgress({ ...defaultSkillEmployeeProgress, ...payload.skillEmployeeProgress })
    }
    if (
      includeSettingsData &&
      payload.skillProgressUpdatedAtByEmployee &&
      typeof payload.skillProgressUpdatedAtByEmployee === 'object' &&
      !Array.isArray(payload.skillProgressUpdatedAtByEmployee)
    ) {
      setSkillProgressUpdatedAtByEmployee({ ...payload.skillProgressUpdatedAtByEmployee })
    }
    const periodGoals = normalizeGoalsByEmployeePeriodMap(payload.goalsByEmployeePeriod)
    if (Object.keys(periodGoals).length > 0) {
      setGoalsByEmployeePeriod(periodGoals)
    } else if (payload.goalsByEmployee && typeof payload.goalsByEmployee === 'object' && !Array.isArray(payload.goalsByEmployee)) {
      const active = String(payload.activeEvalPeriodKey ?? activeEvalPeriodKey ?? '').trim()
      if (active) {
        const legacyConverted = {}
        for (const [empId, list] of Object.entries(payload.goalsByEmployee)) {
          const normalized = normalizeGoalList(list, empId)
          if (!normalized.length) continue
          legacyConverted[empId] = { [active]: normalized }
        }
        setGoalsByEmployeePeriod(legacyConverted)
      }
    }
    const periodDirections = normalizeGoalDirectionByEmployeePeriodMap(payload.goalDirectionByEmployeePeriod)
    if (Object.keys(periodDirections).length > 0) {
      setGoalDirectionByEmployeePeriod(periodDirections)
    } else if (payload.goalDirectionByEmployee && typeof payload.goalDirectionByEmployee === 'object' && !Array.isArray(payload.goalDirectionByEmployee)) {
      const active = String(payload.activeEvalPeriodKey ?? activeEvalPeriodKey ?? '').trim()
      if (active) {
        const legacyConverted = {}
        for (const [empId, value] of Object.entries(payload.goalDirectionByEmployee)) {
          const v = String(value ?? '').trim()
          if (!empId || !v) continue
          legacyConverted[empId] = { [active]: v }
        }
        setGoalDirectionByEmployeePeriod(legacyConverted)
      }
    }
    const periodFocusMajors = normalizeGoalFocusMajorByEmployeePeriodMap(payload.goalFocusMajorByEmployeePeriod)
    if (Object.keys(periodFocusMajors).length > 0) {
      setGoalFocusMajorByEmployeePeriod(periodFocusMajors)
    }
    if (payload.goalSubmissionByEmployee && typeof payload.goalSubmissionByEmployee === 'object' && !Array.isArray(payload.goalSubmissionByEmployee)) {
      const out = {}
      for (const [empId, periods] of Object.entries(payload.goalSubmissionByEmployee)) {
        if (!empId || !periods || typeof periods !== 'object' || Array.isArray(periods)) continue
        const periodMap = {}
        for (const [periodKey, state] of Object.entries(periods)) {
          if (!periodKey) continue
          const submittedAt = typeof state?.submittedAt === 'string' ? state.submittedAt.trim() : ''
          const submissionWithdrawalsUsed = clampEvalSubmissionWithdrawalsUsed(state?.submissionWithdrawalsUsed)
          if (submittedAt) {
            periodMap[periodKey] =
              submissionWithdrawalsUsed > 0 ? { submittedAt, submissionWithdrawalsUsed } : { submittedAt }
          } else if (submissionWithdrawalsUsed > 0) {
            periodMap[periodKey] = { submissionWithdrawalsUsed }
          }
        }
        if (Object.keys(periodMap).length) out[empId] = periodMap
      }
      setGoalSubmissionByEmployee(out)
    }
    if (
      (includeSettingsData || includeEvaluationCriteria) &&
      payload.evaluationCriteria &&
      typeof payload.evaluationCriteria === 'object' &&
      !Array.isArray(payload.evaluationCriteria)
    ) {
      const gradeList =
        Array.isArray(payload.skillGrades) && payload.skillGrades.length > 0
          ? payload.skillGrades.filter((g) => g && typeof g.id === 'string' && typeof g.label === 'string')
          : defaultSkillGrades
      setEvaluationCriteria(normalizeEvaluationCriteriaStore(payload.evaluationCriteria, gradeList))
    }
    if (
      includeSettingsData &&
      payload.menuVisibilityByRole &&
      typeof payload.menuVisibilityByRole === 'object' &&
      !Array.isArray(payload.menuVisibilityByRole)
    ) {
      setMenuVisibilityByRole(normalizeMenuVisibilityByRole(payload.menuVisibilityByRole))
    }
    if (
      includeEvalDrafts &&
      payload.selfEvalByEmployee &&
      typeof payload.selfEvalByEmployee === 'object' &&
      !Array.isArray(payload.selfEvalByEmployee)
    ) {
      setSelfEvalByEmployee(normalizeEvalByEmployeeMap(payload.selfEvalByEmployee))
    }
    if (
      includeEvalDrafts &&
      payload.supervisorEvalByEmployee &&
      typeof payload.supervisorEvalByEmployee === 'object' &&
      !Array.isArray(payload.supervisorEvalByEmployee)
    ) {
      setSupervisorEvalByEmployee(normalizeEvalByEmployeeMap(payload.supervisorEvalByEmployee))
    }
    if (
      includeEvalDrafts &&
      payload.executiveEvalByEmployee &&
      typeof payload.executiveEvalByEmployee === 'object' &&
      !Array.isArray(payload.executiveEvalByEmployee)
    ) {
      setExecutiveEvalByEmployee(normalizeExecutiveEvalByEmployeeMap(payload.executiveEvalByEmployee))
    }
    if (includeUiState && typeof payload.activeEvalPeriodKey === 'string' && payload.activeEvalPeriodKey.trim()) {
      setActiveEvalPeriodKey(payload.activeEvalPeriodKey.trim())
    }
    if (
      includeSettingsData &&
      Array.isArray(payload.evalPeriodDefinitions) &&
      payload.evalPeriodDefinitions.length > 0
    ) {
      // Replace instead of merge so deleted period keys are not resurrected by late cloud/snapshot payloads.
      setEvalPeriodDefinitions(normalizeEvalPeriodDefinitions(payload.evalPeriodDefinitions))
    }
    if (
      payload.selfEvalHistoryByEmployee &&
      typeof payload.selfEvalHistoryByEmployee === 'object' &&
      !Array.isArray(payload.selfEvalHistoryByEmployee)
    ) {
      let normalized = normalizeEvalHistoryByEmployeeMap(payload.selfEvalHistoryByEmployee, normalizeEvalByEmployeeMap)
      if (!includeEvalDrafts) normalized = filterCommittedEvalHistoryMap(normalized)
      if (mergeEvalHistories) {
        setSelfEvalHistoryByEmployee((prev) => mergeEvalHistoryMapBySavedAt(prev, normalized))
      } else {
        setSelfEvalHistoryByEmployee(normalized)
      }
    }
    if (
      payload.supervisorEvalHistoryByEmployee &&
      typeof payload.supervisorEvalHistoryByEmployee === 'object' &&
      !Array.isArray(payload.supervisorEvalHistoryByEmployee)
    ) {
      let normalized = normalizeEvalHistoryByEmployeeMap(payload.supervisorEvalHistoryByEmployee, normalizeEvalByEmployeeMap)
      if (!includeEvalDrafts) normalized = filterCommittedEvalHistoryMap(normalized)
      if (mergeEvalHistories) {
        setSupervisorEvalHistoryByEmployee((prev) => mergeEvalHistoryMapBySavedAt(prev, normalized))
      } else {
        setSupervisorEvalHistoryByEmployee(normalized)
      }
    }
    if (
      payload.executiveEvalHistoryByEmployee &&
      typeof payload.executiveEvalHistoryByEmployee === 'object' &&
      !Array.isArray(payload.executiveEvalHistoryByEmployee)
    ) {
      let normalized = normalizeEvalHistoryByEmployeeMap(
        payload.executiveEvalHistoryByEmployee,
        normalizeExecutiveEvalByEmployeeMap,
      )
      if (!includeEvalDrafts) normalized = filterCommittedEvalHistoryMap(normalized)
      if (mergeEvalHistories) {
        setExecutiveEvalHistoryByEmployee((prev) => mergeEvalHistoryMapBySavedAt(prev, normalized))
      } else {
        setExecutiveEvalHistoryByEmployee(normalized)
      }
    }
    if (typeof payload.adminPassword === 'string' && payload.adminPassword) {
      setAdminPassword(payload.adminPassword)
    }
    if (Array.isArray(payload.promotionRequests)) {
      setPromotionRequests(normalizePromotionRequests(payload.promotionRequests))
    }
    if (includeSettingsData && Array.isArray(payload.skillSections) && payload.skillSections.length > 0) {
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
    if (payload.gyosekiTeamFilter === 'all' || payload.gyosekiTeamFilter === 'denture' || payload.gyosekiTeamFilter === 'ck') {
      setGyosekiTeamFilter(payload.gyosekiTeamFilter)
    }
    if (payload.gyosekiRowView === 'simple' || payload.gyosekiRowView === 'detail') {
      setGyosekiRowView(payload.gyosekiRowView)
    }
    if (
      includeUiState &&
      (
        payload.workspaceView === 'gyoseki' ||
        payload.workspaceView === 'count' ||
        payload.workspaceView === 'honsu' ||
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
      )
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
      includeUiState &&
      (
        payload.settingsTab === 'skill' ||
        payload.settingsTab === 'evalcriteria' ||
        payload.settingsTab === 'evalperiod' ||
        payload.settingsTab === 'menusettings' ||
        payload.settingsTab === 'departments'
      )
    ) {
      setSettingsTab(payload.settingsTab)
    }
    if (includeUiState && (payload.activePage === 'input' || payload.activePage === 'calc')) setActivePage(payload.activePage)
    if (Number.isFinite(Number(payload.countCurrent))) setCountCurrent(Math.max(0, Math.trunc(Number(payload.countCurrent))))
    if (Number.isFinite(Number(payload.countHourlyTarget))) {
      setCountHourlyTarget(Math.max(1, Math.trunc(Number(payload.countHourlyTarget))))
    }
    if (typeof payload.countIsRunning === 'boolean') setCountIsRunning(payload.countIsRunning)
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
    try {
    applyPersistPayload(data.payload, { forceEmployeeDirectory: true })
      setSnapshotMessage(`${period} の履歴を読み込みました`)
    } catch (e) {
      console.warn('[WorkVision] スナップショット適用に失敗しました', e)
      setSnapshotMessage('履歴読込データの適用に失敗しました')
    }
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
        const serialized = JSON.stringify(payload)
        try {
          applyPersistPayload(payload)
          lastCloudPersistRef.current = serialized
          lastCloudAppliedRef.current = serialized
          setSyncMessage('Supabaseから復元済み')
        } catch (e) {
          console.warn('[WorkVision] Supabase復元データの適用に失敗しました', e)
          setSyncMessage('Supabase復元データ適用失敗（ローカル表示を継続）')
        }
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

  const lastLocalPersistRef = useRef('')
  const lastCloudPersistRef = useRef('')
  const lastCloudAppliedRef = useRef('')

  const flushLocalStorageNow = useCallback(() => {
    if (typeof window === 'undefined') return
    try {
      const serialized = JSON.stringify(buildPersistPayloadRef.current())
      if (serialized === lastLocalPersistRef.current) return
      lastLocalPersistRef.current = serialized
      window.localStorage.setItem(STORAGE_KEY, serialized)
    } catch (e) {
      console.warn('[WorkVision] localStorage の保存に失敗しました', e)
    }
  }, [])

  const flushCloudStateBestEffort = useCallback(() => {
    if (!supabase) return
    try {
    const payload = buildPersistPayload(true, { includeEvalDrafts: false, includeUiState: false })
      void saveCloudState(payload, { silent: true })
    } catch (e) {
      console.warn('[WorkVision] Supabase への退避保存に失敗しました', e)
    }
  }, [saveCloudState])

  useEffect(() => {
    if (typeof window === 'undefined') return
    const onPageHide = () => {
      flushLocalStorageNow()
      flushCloudStateBestEffort()
    }
    const onVisibilityChange = () => {
      if (document.visibilityState === 'hidden') flushLocalStorageNow()
    }
    window.addEventListener('pagehide', onPageHide)
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => {
      window.removeEventListener('pagehide', onPageHide)
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [flushLocalStorageNow, flushCloudStateBestEffort])

  useEffect(() => {
    if (typeof window === 'undefined') return
    const timer = window.setTimeout(() => {
      flushLocalStorageNow()
    }, 900)
    return () => {
      window.clearTimeout(timer)
      flushLocalStorageNow()
    }
  }, [
    rows,
    employeeDirectoryRows,
    skillSettings,
    skillSections,
    skillGrades,
    skillActiveGradeId,
    skillEmployeeProgress,
    skillProgressUpdatedAtByEmployee,
    goalsByEmployeePeriod,
    goalDirectionByEmployeePeriod,
    goalFocusMajorByEmployeePeriod,
    goalSubmissionByEmployee,
    evaluationCriteria,
    menuVisibilityByRole,
    evalPeriodDefinitions,
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
    gyosekiTeamFilter,
    gyosekiRowView,
    workspaceView,
    settingsTab,
    activePage,
    snapshotPeriod,
    activeEvalPeriodKey,
    employeeDeptOptions,
    promotionRequests,
    selfEvalHistoryByEmployee,
    supervisorEvalHistoryByEmployee,
    executiveEvalHistoryByEmployee,
  ])

  useEffect(() => {
    if (!supabase || !isCloudReady) return
    const timer = window.setTimeout(async () => {
      const payload = buildPersistPayload(true, { includeEvalDrafts: false, includeUiState: false })
      const serialized = JSON.stringify(payload)
      if (serialized === lastCloudPersistRef.current) return
      const ok = await saveCloudState(payload, { silent: true })
      if (ok) lastCloudPersistRef.current = serialized
    }, CLOUD_SYNC_INTERVAL_MS)
    return () => window.clearTimeout(timer)
  }, [
    selfEvalHistoryByEmployee,
    supervisorEvalHistoryByEmployee,
    executiveEvalHistoryByEmployee,
    goalSubmissionByEmployee,
    isCloudReady,
    saveCloudState,
  ])

  useEffect(() => {
    if (!supabase || !isCloudReady) return
    if (!employeeDirectoryDirtyRef.current) return
    const timer = window.setTimeout(async () => {
      if (!employeeDirectoryDirtyRef.current) return
      const payload = buildPersistPayload(true, { includeEvalDrafts: false, includeUiState: false })
      const serialized = JSON.stringify(payload)
      const ok = await saveCloudState(payload, { silent: true })
      if (!ok) return
      lastCloudPersistRef.current = serialized
      employeeDirectoryDirtyRef.current = false
    }, EMPLOYEE_DIRECTORY_SYNC_DEBOUNCE_MS)
    return () => window.clearTimeout(timer)
  }, [employeeDirectoryRows, isCloudReady, saveCloudState])

  useEffect(() => {
    if (!supabase || !isCloudReady) return
    const timer = window.setTimeout(async () => {
      const payload = buildPersistPayload(true, { includeEvalDrafts: false, includeUiState: false })
      const serialized = JSON.stringify(payload)
      if (serialized === lastCloudPersistRef.current) return
      const ok = await saveCloudState(payload, { silent: true })
      if (ok) lastCloudPersistRef.current = serialized
    }, CLOUD_SYNC_INTERVAL_MS)
    return () => window.clearTimeout(timer)
  }, [
    rows,
    employeeDirectoryRows,
    employeeDeptOptions,
    skillSettings,
    skillSections,
    skillGrades,
    skillActiveGradeId,
    skillEmployeeProgress,
    skillProgressUpdatedAtByEmployee,
    goalsByEmployeePeriod,
    goalDirectionByEmployeePeriod,
    goalFocusMajorByEmployeePeriod,
    goalSubmissionByEmployee,
    evaluationCriteria,
    menuVisibilityByRole,
    evalPeriodDefinitions,
    selfEvalHistoryByEmployee,
    supervisorEvalHistoryByEmployee,
    executiveEvalHistoryByEmployee,
    adminPassword,
    departmentSalesDenture,
    departmentSalesCk,
    performanceRatePercentDenture,
    performanceRatePercentCk,
    targetSpecialDentureTotal,
    targetSpecialCkTotal,
    promotionRequests,
    isCloudReady,
    saveCloudState,
  ])

  useEffect(() => {
    if (!supabase || !isCloudReady) return
    const timer = window.setInterval(async () => {
      try {
        const { data } = await supabase
          .from('app_state')
          .select('payload')
          .eq('id', CLOUD_STATE_ID)
          .maybeSingle()
        const payload = data?.payload
        if (!payload || typeof payload !== 'object') return
        const serialized = JSON.stringify(payload)
        if (!serialized || serialized === lastCloudAppliedRef.current || serialized === lastCloudPersistRef.current) return
        applyPersistPayload(payload, {
          includeUiState: false,
          mergeEvalHistories: true,
          includeEvalDrafts: false,
          includeEmployeeDirectory: false,
          includeSettingsData: false,
          includeEvaluationCriteria: true,
        })
        lastCloudAppliedRef.current = serialized
        lastCloudPersistRef.current = serialized
        setSyncMessage('Supabaseから最新データを反映しました（120秒間隔）')
        setSyncError('')
      } catch (e) {
        console.warn('[WorkVision] Supabase 定期同期データの反映に失敗しました', e)
      }
    }, CLOUD_SYNC_INTERVAL_MS)
    return () => {
      window.clearInterval(timer)
    }
  }, [isCloudReady])

  useEffect(() => {
    setEmployeeDeptOptions((prev) => {
      const next = mergeEmployeeDeptOptionsFromRows(prev, employeeDirectoryRows)
      if (next.length === prev.length && next.every((d, i) => d === prev[i])) return prev
      return next
    })
  }, [employeeDirectoryRows])

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
                      setResetFeedback('')
                      setResetFeedbackType('error')
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
                      ? '部署別スキルと難易度の設定'
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
              <div className="employeeModalOverlay" onClick={closeResetModal}>
                <div className="employeeModal loginResetModal" onClick={(event) => event.stopPropagation()}>
                  <button className="modalClose" type="button" onClick={closeResetModal}>
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
                    {resetFeedback ? (
                      <p className={`loginResetFeedback ${resetFeedbackType === 'success' ? 'isSuccess' : 'isError'}`}>
                        {resetFeedback}
                      </p>
                    ) : null}
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
            <div className="pageTabs pageTabsMain pageTabsMainInline">
              {visibleWorkspaceTabs.map((t) => (
                <button
                  key={t.key}
                  type="button"
                  className={`tabButton tabButtonMain ${effectiveWorkspaceView === t.key ? 'isActive' : ''}`}
                  onClick={() => setWorkspaceView(t.key)}
                >
                  <span className="tabButtonMainIcon" aria-hidden>
                    {MAIN_WORKSPACE_TAB_ICONS[t.key] ?? '•'}
                  </span>
                  <span className="tabButtonMainLabel">{t.label}</span>
                </button>
              ))}
            </div>

            <div style={{ display: effectiveWorkspaceView === 'gyoseki' ? 'block' : 'none' }}>
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
                <div className="actionRow actionRowGyoseki">
                  <div className="sortControls">
                    <label className="sortLabel">
                      <span className="sortLabelText">フィルター</span>
                      <select
                        value={gyosekiTeamFilter}
                        onChange={(event) => setGyosekiTeamFilter(event.target.value)}
                        aria-label="区分で絞り込み"
                      >
                        <option value="all">全</option>
                        <option value="denture">デン</option>
                        <option value="ck">CK</option>
                      </select>
                    </label>
                    <label className="sortLabel">
                      <span className="sortLabelText">ソート</span>
                      <select
                        value={sortKey}
                        onChange={(event) => setSortKey(event.target.value)}
                        aria-label="並び替えの基準"
                      >
                        <option value="employeeNo">番号</option>
                        <option value="employeeName">名前</option>
                        <option value="team">区分</option>
                        <option value="grade">等級</option>
                        <option value="score">スコア</option>
                        <option value="performanceAllowance">業績</option>
                        <option value="thirdBonus">賞与3</option>
                      </select>
                    </label>
                    <button
                      type="button"
                      className="secondaryButton gyosekiToolbarBtn"
                      aria-label={sortOrder === 'asc' ? '昇順（タップで降順）' : '降順（タップで昇順）'}
                      onClick={() => setSortOrder((prev) => (prev === 'asc' ? 'desc' : 'asc'))}
                    >
                      <span className="gyosekiToolbarIcon" aria-hidden>
                        {sortOrder === 'asc' ? <GyosekiIconSortAsc /> : <GyosekiIconSortDesc />}
                      </span>
                      <span className="gyosekiToolbarLabel">{sortOrder === 'asc' ? '昇順' : '降順'}</span>
                    </button>
                  </div>
                  <button type="button" className="primaryButton gyosekiToolbarBtn" aria-label="社員行を追加" onClick={addRow}>
                    <span className="gyosekiToolbarIcon" aria-hidden>
                      <GyosekiIconPlus />
                    </span>
                    <span className="gyosekiToolbarLabel">+ 社員行を追加</span>
                  </button>
                  <label className="csvImportButton gyosekiToolbarBtn" aria-label="CSVインポート">
                    <span className="gyosekiToolbarIcon" aria-hidden>
                      <GyosekiIconDownload />
                    </span>
                    <span className="gyosekiToolbarLabel">CSVインポート</span>
                    <input type="file" accept=".csv" onChange={handleImportCsv} />
                  </label>
                  <button type="button" className="csvExportButton gyosekiToolbarBtn" aria-label="CSVエクスポート" onClick={handleExportCsv}>
                    <span className="gyosekiToolbarIcon" aria-hidden>
                      <GyosekiIconUpload />
                    </span>
                    <span className="gyosekiToolbarLabel">CSVエクスポート</span>
                  </button>
                  <button
                    type="button"
                    className="csvMailButton gyosekiToolbarBtn"
                    aria-label="CSVをメール送信"
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
                    <span className="gyosekiToolbarIcon" aria-hidden>
                      <GyosekiIconMail />
                    </span>
                    <span className="gyosekiToolbarLabel">CSVをメール送信</span>
                  </button>
                </div>
                <p className="syncMessage">{syncMessage}</p>
                <div className="gyosekiViewToggleRow">
                  <button
                    type="button"
                    className="gyosekiViewToggle"
                    onClick={() => setGyosekiRowView((prev) => (prev === 'detail' ? 'simple' : 'detail'))}
                  >
                    {gyosekiRowView === 'detail' ? '簡易表示' : '詳細表示'}
                  </button>
                  <button
                    type="button"
                    className="gyosekiInfoBtn"
                    aria-label="業績手当ロジックの説明を開く"
                    title="業績手当ロジックの説明"
                    onClick={() => setGyosekiInfoModalOpen(true)}
                  >
                    ⓘ
                  </button>
                </div>
                {syncError ? (
                  <div className="syncErrorBanner" role="alert">
                    <p>{syncError}</p>
                    <button type="button" className="syncRetryButton" onClick={handleRetryCloudSync}>
                      再試行
                    </button>
                  </div>
                ) : null}
                {csvMessage ? <p className="csvMessage">{csvMessage}</p> : null}
                {gyosekiInfoModalOpen ? (
                  <div className="employeeModalOverlay" onClick={() => setGyosekiInfoModalOpen(false)}>
                    <div className="employeeModal gyosekiInfoModal" onClick={(event) => event.stopPropagation()}>
                      <button type="button" className="modalClose" onClick={() => setGyosekiInfoModalOpen(false)}>
                        ×
                      </button>
                      <h3>業績手当のロジックメモ</h3>
                      <p>忘れやすい仕様をまとめています。</p>
                      <ul className="gyosekiInfoList">
                        <li>
                          <strong>等級は社員番号リンク:</strong> 業績手当の社員番号（社員C）が従業員管理の社員Cと一致すると、等級は自動同期されます。
                        </li>
                        <li>
                          <strong>リンク中の等級は編集不可:</strong> 一致している行の等級セレクトはロックされ、従業員管理側の等級が正になります。
                        </li>
                        <li>
                          <strong>等級候補は評価と共通:</strong> 等級の候補リストはスキル/評価で使っている等級マスタ（設定）と同一です。
                        </li>
                        <li>
                          <strong>CSV取り込み時のキー:</strong> 社員番号が一致すれば既存行を上書き、無ければ新規追加します。
                        </li>
                        <li>
                          <strong>等級ソート順:</strong> 業績手当の等級ソートは、等級マスタの並び順に従います。
                        </li>
                      </ul>
                    </div>
                  </div>
                ) : null}
                {gyosekiCsvModalOpen ? (
                  <div className="employeeModalOverlay" onClick={() => setGyosekiCsvModalOpen(false)}>
                    <div className="employeeModal gyosekiCsvModal" onClick={(event) => event.stopPropagation()}>
                      <button type="button" className="modalClose" onClick={() => setGyosekiCsvModalOpen(false)}>
                        ×
                      </button>
                      <h3>CSV抽出項目を選択</h3>
                      <p>チェックした項目のみ、下の並び順でCSV出力します。</p>
                      <div className="gyosekiCsvModalToolbar">
                        <span className="gyosekiCsvModalCount">
                          選択中 {gyosekiCsvColumnOrder.filter((key) => gyosekiCsvColumnEnabled[key]).length} / {gyosekiCsvColumnOrder.length}
                        </span>
                        <div className="gyosekiCsvModalQuickActions">
                          <button type="button" onClick={() => setAllGyosekiCsvColumnsEnabled(true)}>
                            全選択
                          </button>
                          <button type="button" onClick={() => setAllGyosekiCsvColumnsEnabled(false)}>
                            全解除
                          </button>
                          <button type="button" onClick={resetGyosekiCsvColumns}>
                            初期順
                          </button>
                        </div>
                      </div>
                      <ul className="gyosekiCsvFieldList">
                        {gyosekiCsvColumnOrder.map((key, idx) => {
                          const col = GYOSEKI_CSV_COLUMNS.find((c) => c.key === key)
                          if (!col) return null
                          const checked = !!gyosekiCsvColumnEnabled[key]
                          return (
                            <li key={key} className="gyosekiCsvFieldItem">
                              <label>
                                <input
                                  type="checkbox"
                                  checked={checked}
                                  onChange={() => toggleGyosekiCsvColumn(key)}
                                />
                                <span>{col.label}</span>
                              </label>
                              <div className="gyosekiCsvFieldSort">
                                <button type="button" onClick={() => moveGyosekiCsvColumn(key, -1)} disabled={idx === 0}>
                                  ↑
                                </button>
                                <button
                                  type="button"
                                  onClick={() => moveGyosekiCsvColumn(key, 1)}
                                  disabled={idx === gyosekiCsvColumnOrder.length - 1}
                                >
                                  ↓
                                </button>
                              </div>
                            </li>
                          )
                        })}
                      </ul>
                      <div className="gyosekiCsvModalActions">
                        <button type="button" className="secondaryButton" onClick={() => setGyosekiCsvModalOpen(false)}>
                          キャンセル
                        </button>
                        <button type="button" className="primaryButton" onClick={handleConfirmGyosekiCsvExport}>
                          この内容で出力
                        </button>
                      </div>
                    </div>
                  </div>
                ) : null}

                <div className="tableWrap">
                  <table className="allowanceTable">
                    <colgroup>
                      {gyosekiRowView === 'detail' ? <col className="colPhoto" /> : null}
                      <col className="colEmployeeInfo" />
                      <col className="colAllowanceInfo" />
                      <col className="colAction" />
                    </colgroup>
                    <thead>
                      <tr>
                        {gyosekiRowView === 'detail' ? <th>顔写真 / 評価スコア</th> : null}
                        <th>社員情報</th>
                        <th>手当情報</th>
                        <th>操作</th>
                      </tr>
                    </thead>
                    <tbody>
                      {sortedRows.map((row) => (
                        <tr key={row.id} className={getGradeRowClass(row.grade)}>
                          {gyosekiRowView === 'detail' ? (
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
                              </div>
                            </td>
                          ) : null}
                          {gyosekiRowView === 'simple' ? (
                            <td colSpan={2}>
                              <div className="gyosekiSimpleRow">
                                <input
                                  className="gyosekiSimpleNo"
                                  type="text"
                                  value={row.employeeNo}
                                  onChange={(event) => updateRow(row.id, 'employeeNo', event.target.value)}
                                  placeholder="1001"
                                  aria-label="社員番号"
                                />
                                <input
                                  className="gyosekiSimpleName"
                                  type="text"
                                  value={row.employeeName}
                                  onChange={(event) => updateRow(row.id, 'employeeName', event.target.value)}
                                  placeholder="山田 太郎"
                                  aria-label="社員名"
                                />
                                <span className="gyosekiSimpleLabel">業</span>
                                <strong className="moneyCell gyosekiSimpleMoney">{formatJPY(row.performanceAllowance)}</strong>
                                <span className="gyosekiSimpleLabel">調</span>
                                <input
                                  className="gyosekiSimpleAdjust"
                                  type="text"
                                  inputMode="numeric"
                                  value={row.adjustment ?? ''}
                                  onChange={(event) =>
                                    updateRow(
                                      row.id,
                                      'adjustment',
                                      sanitizeIntegerInput(event.target.value),
                                    )
                                  }
                                  aria-label="調整"
                                />
                                <span className="gyosekiSimpleLabel">特</span>
                                <input
                                  className="gyosekiSimpleSpecial"
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
                                  aria-label="特別手当"
                                />
                            </div>
                          </td>
                          ) : (
                            <>
                          <td>
                            <div className="employeeInfoCell">
                                  <label className="employeeFieldNo">
                                    <span className="srOnlyFieldLabel">社員番号</span>
                                <input
                                  type="text"
                                  value={row.employeeNo}
                                  onChange={(event) => updateRow(row.id, 'employeeNo', event.target.value)}
                                  placeholder="1001"
                                      aria-label="社員番号"
                                />
                              </label>
                                  <label className="employeeFieldTeam">
                                    <span className="srOnlyFieldLabel">区分</span>
                                <select
                                  value={row.team ?? 'denture'}
                                  onChange={(event) => updateRow(row.id, 'team', event.target.value)}
                                      aria-label="区分"
                                >
                                  <option value="denture">デンチャー</option>
                                  <option value="ck">CK</option>
                                </select>
                              </label>
                                  <label className="employeeFieldGrade">
                                    <span className="srOnlyFieldLabel">等級</span>
                                <select
                                  value={row.grade}
                                  onChange={(event) => updateRow(row.id, 'grade', event.target.value)}
                                      aria-label="等級"
                                      disabled={Boolean(employeeGradeByNo.get(normalizeEmployeeNoLinkKey(row.employeeNo)))}
                                      title={
                                        employeeGradeByNo.get(normalizeEmployeeNoLinkKey(row.employeeNo))
                                          ? '従業員管理の等級と自動同期中（社員番号リンク）'
                                          : '等級'
                                      }
                                    >
                                      {(skillGrades.length ? skillGrades : defaultSkillGrades).map((g) => (
                                        <option key={g.id} value={g.id}>
                                          {g.label ?? g.id}
                                        </option>
                                      ))}
                                </select>
                              </label>
                                  <label className="employeeFieldScore">
                                    <span className="srOnlyFieldLabel">スコア</span>
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
                                      aria-label="スコア"
                                      disabled={Boolean(employeeScoreByNo.get(normalizeEmployeeNoLinkKey(row.employeeNo)))}
                                      title={
                                        employeeScoreByNo.get(normalizeEmployeeNoLinkKey(row.employeeNo))
                                          ? '従業員管理の総合得点と自動同期中（社員番号リンク）'
                                          : 'スコア'
                                      }
                                    />
                                  </label>
                                  <label className="employeeFieldName">
                                    <span className="srOnlyFieldLabel">社員名</span>
                                    <input
                                      type="text"
                                      value={row.employeeName}
                                      onChange={(event) => updateRow(row.id, 'employeeName', event.target.value)}
                                      placeholder="山田 太郎"
                                      aria-label="社員名"
                                    />
                                  </label>
                                  <label className="employeeFieldNote">
                                    <span className="srOnlyFieldLabel">備考</span>
                                    <input
                                      type="text"
                                      value={row.note}
                                      onChange={(event) => updateRow(row.id, 'note', event.target.value)}
                                      placeholder="備考"
                                      aria-label="備考"
                                    />
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
                                    <span>調整</span>
                                    <input
                                      type="text"
                                      inputMode="numeric"
                                      value={row.adjustment ?? ''}
                                      onChange={(event) =>
                                        updateRow(
                                          row.id,
                                          'adjustment',
                                          sanitizeIntegerInput(event.target.value),
                                        )
                                      }
                                    />
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
                            </>
                          )}
                          <td>
                            <button
                              type="button"
                              className="dangerButton"
                              onClick={() => removeRow(row.id)}
                              disabled={rows.length <= 1}
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
            {effectiveWorkspaceView === 'admin' ? (
              <AdminMockPage
                directoryRows={employeeDirectoryRows}
                skills={skillSettings}
                skillProgress={skillEmployeeProgress}
                setSkillEmployeeProgress={setSkillEmployeeProgress}
                skillProgressUpdatedAtByEmployee={skillProgressUpdatedAtByEmployee}
                selfEvalByEmployee={selfEvalByEmployee}
                supervisorEvalByEmployee={supervisorEvalByEmployee}
                setSupervisorEvalByEmployee={setSupervisorEvalByEmployee}
                executiveEvalByEmployee={executiveEvalByEmployee}
                setExecutiveEvalByEmployee={setExecutiveEvalByEmployee}
                selfEvalHistoryByEmployee={selfEvalHistoryByEmployee}
                supervisorEvalHistoryByEmployee={supervisorEvalHistoryByEmployee}
                setSupervisorEvalHistoryByEmployee={setSupervisorEvalHistoryByEmployee}
                executiveEvalHistoryByEmployee={executiveEvalHistoryByEmployee}
                setExecutiveEvalHistoryByEmployee={setExecutiveEvalHistoryByEmployee}
                goalsByEmployeePeriod={goalsByEmployeePeriod}
                goalDirectionByEmployeePeriod={goalDirectionByEmployeePeriod}
                goalFocusMajorByEmployeePeriod={goalFocusMajorByEmployeePeriod}
                evaluationCriteria={evaluationCriteria}
                hideGradeSelfEvalAndGradeStats={menuRoleKey === MENU_ROLE_YAKUIN}
                canViewExecutiveCommentEval={menuRoleKey === MENU_ROLE_YAKUIN || menuRoleKey === MENU_ROLE_ADMIN}
                forcedSelectedMemberId={adminSelectedMemberId}
                forcedDetailTab={adminDetailTab}
                onSelectMember={(employeeId) => setAdminSelectedMemberId(employeeId)}
                onChangeDetailTab={(tabId) => setAdminDetailTab(tabId)}
                promotionRequests={promotionRequests}
                canApprovePromotions={menuRoleKey === MENU_ROLE_ADMIN}
                onApprovePromotionRequest={approvePromotionRequest}
                onRejectPromotionRequest={rejectPromotionRequest}
                activeEvalPeriodKey={activeEvalPeriodKey}
                setActiveEvalPeriodKey={requestEvalPeriodChange}
                evalPeriodDefinitions={evalPeriodDefinitions}
                evalPeriodFallbackKey={evalPeriodFallbackKey}
                onSubmitSupervisorEvaluation={submitSupervisorEvalForMember}
                onWithdrawSupervisorEvaluation={withdrawSupervisorEvalForMember}
                onWithdrawSelfEvaluation={withdrawSelfEvalForMember}
                onWithdrawGoalSubmissionForMember={withdrawGoalsSubmissionForMember}
                goalSubmissionByEmployee={goalSubmissionByEmployee}
                onSubmitExecutiveEvaluation={submitExecutiveEvalForMember}
              />
            ) : null}
            {effectiveWorkspaceView === 'count' ? (
              <CountWorkspacePage
                count={countCurrent}
                setCount={setCountCurrent}
                hourlyTarget={countHourlyTarget}
                setHourlyTarget={setCountHourlyTarget}
                isRunning={countIsRunning}
                setIsRunning={setCountIsRunning}
              />
            ) : null}
            {effectiveWorkspaceView === 'honsu' ? (
              <HonsuWorkspacePage />
            ) : null}
            {effectiveWorkspaceView === 'employee' ? (
      <EmployeeManagePage
                rows={employeeDirectoryRows}
                setRows={updateEmployeeDirectoryRowsLocal}
                deptOptions={employeeDeptOptions}
                skills={skillSettings}
                skillProgress={skillEmployeeProgress}
                selfEvalByEmployee={selfEvalByEmployee}
                supervisorEvalByEmployee={supervisorEvalByEmployee}
                executiveEvalByEmployee={executiveEvalByEmployee}
                evaluationCriteria={evaluationCriteria}
                hideGradeAndTotalScore={menuRoleKey === MENU_ROLE_YAKUIN}
                onEmployeeIdRename={renameEmployeeIdInAppState}
                onClearSkillProgressForEmployees={clearSkillProgressForEmployees}
              />
            ) : null}
            {effectiveWorkspaceView === 'settings' ? (
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
                    className={`settingsHubTab ${settingsTab === 'evalperiod' ? 'isActive' : ''}`}
                    onClick={() => setSettingsTab('evalperiod')}
                  >
                    評価期
                  </button>
                  <button
                    type="button"
                    className={`settingsHubTab ${settingsTab === 'menusettings' ? 'isActive' : ''}`}
                    onClick={() => setSettingsTab('menusettings')}
                  >
                    表示設定
                  </button>
                  <button
                    type="button"
                    className={`settingsHubTab ${settingsTab === 'departments' ? 'isActive' : ''}`}
                    onClick={() => setSettingsTab('departments')}
                  >
                    部署マスタ
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
                    deptChoices={employeeDeptOptions}
                    onRemoveSkillProgressKeysGlobally={removeSkillProgressKeysGlobally}
                  />
                ) : null}
                {settingsTab === 'evalcriteria' ? (
                  <EvaluationCriteriaPage grades={skillGrades} criteria={evaluationCriteria} setCriteria={setEvaluationCriteria} />
                ) : null}
                {settingsTab === 'evalperiod' ? (
                  <EvalPeriodSettingsPage
                    definitions={evalPeriodDefinitions}
                    setDefinitions={setEvalPeriodDefinitions}
                    onSelectActivePeriod={setActiveEvalPeriodKey}
                    onCleanupHistory={cleanupEvalPeriodHistory}
                    onRemovePeriodKey={removeEvalPeriodKeyEverywhere}
                  />
                ) : null}
                {settingsTab === 'menusettings' ? (
                  <MenuDisplaySettingsPage menuVisibilityByRole={menuVisibilityByRole} setMenuVisibilityByRole={setMenuVisibilityByRole} />
                ) : null}
                {settingsTab === 'departments' ? (
                  <DepartmentSettingsPage
                    deptOptions={employeeDeptOptions}
                    setDeptOptions={setEmployeeDeptOptions}
                    employeeDirectoryRows={employeeDirectoryRows}
                    skillSettings={skillSettings}
                  />
                ) : null}
              </section>
            ) : null}
            {effectiveWorkspaceView === 'skillup' ? (
              <SkillUpPage
                employees={loggedInEmployee ? [loggedInEmployee] : employeeDirectoryRows}
                skills={skillSettings}
                sections={skillSections}
                progress={skillEmployeeProgress}
              />
            ) : null}
            {effectiveWorkspaceView === 'selfeval' ? (
              <SelfEvaluationPage
                key={`selfeval-${String(evalSubjectEmployee?.id ?? '')}-${String(activeEvalPeriodKey ?? evalPeriodFallbackKey ?? '')}`}
                employees={evalSubjectEmployee ? [evalSubjectEmployee] : []}
                evalState={evalSubjectEmployee ? selfEvalByEmployee[evalSubjectEmployee.id] : undefined}
                setEvalState={updateSelfEvalForSubject}
                evaluationCriteria={evaluationCriteria}
                activeEvalPeriodKey={activeEvalPeriodKey}
                setActiveEvalPeriodKey={requestEvalPeriodChange}
                selfEvalHistoryByEmployee={selfEvalHistoryByEmployee}
                evalPeriodSelectOptions={evalPeriodSelectOptions}
                evalPeriodFallbackKey={evalPeriodFallbackKey}
                isSubmittedForPeriod={selfEvalSubmittedForActive}
                onSubmitEvaluation={submitSelfEvalForActivePeriod}
                focusMajorKey={evalFocusMajorKeyForActive}
                isPeriodSwitching={isEvalPeriodSwitching}
              />
            ) : null}
            {effectiveWorkspaceView === 'goals' ? (
              <GoalManagementPage
                employee={goalMgmtEmployee}
                goals={goalMgmtGoals}
                setGoals={setGoalMgmtGoals}
                periodDirectionGoal={goalMgmtDirection}
                setPeriodDirectionGoal={setGoalMgmtDirection}
                periodFocusMajorKey={goalMgmtFocusMajorKey}
                setPeriodFocusMajorKey={setGoalMgmtFocusMajorKey}
                radarSeries={goalMgmtEvalRadarSeries}
                radarGradeLabel={goalMgmtActiveEvalGrade}
                radarHeadlineScore={goalMgmtWeightedTotal100}
                activeEvalPeriodKey={activeEvalPeriodKey}
                setActiveEvalPeriodKey={requestEvalPeriodChange}
                evalPeriodSelectOptions={evalPeriodSelectOptions}
                evalPeriodFallbackKey={evalPeriodFallbackKey}
                isSubmittedForPeriod={goalMgmtSubmittedForActive}
                onSubmitGoalManagement={submitGoalsForActivePeriod}
              />
            ) : null}
            
            {effectiveWorkspaceView === 'bossEval' ? (
              <SupervisorEvaluationPage
                key={`bosseval-${String(evalSubjectEmployee?.id ?? '')}-${String(activeEvalPeriodKey ?? evalPeriodFallbackKey ?? '')}`}
                employees={evalSubjectEmployee ? [evalSubjectEmployee] : []}
                evalState={evalSubjectEmployee ? supervisorEvalByEmployee[evalSubjectEmployee.id] : undefined}
                setEvalState={updateSupervisorEvalForSubject}
                peerSelfEval={evalSubjectEmployee ? selfEvalByEmployee[evalSubjectEmployee.id] : undefined}
                evaluationCriteria={evaluationCriteria}
                activeEvalPeriodKey={activeEvalPeriodKey}
                setActiveEvalPeriodKey={requestEvalPeriodChange}
                evalPeriodSelectOptions={evalPeriodSelectOptions}
                evalPeriodFallbackKey={evalPeriodFallbackKey}
                supervisorEvalHistoryByEmployee={supervisorEvalHistoryByEmployee}
                isSubmittedForPeriod={supervisorEvalSubmittedForActive}
                onSubmitEvaluation={submitSupervisorEvalForActivePeriod}
                submissionWithdrawalsUsed={supervisorSubmissionWithdrawalsUsed}
                onWithdrawSubmission={() =>
                  withdrawSupervisorEvalForMember(evalSubjectEmployee?.id, effectiveEvalPeriodKey)
                }
                withdrawBlockedByDeadline={isSupervisorEvalDeadlineLockedForPeriod(
                  evalPeriodDefinitions,
                  effectiveEvalPeriodKey,
                )}
                canEvaluate
                blockedReason="自己評価の提出後に1次評価(上司)を入力できます。"
                focusMajorKey={evalFocusMajorKeyForActive}
                isPeriodSwitching={isEvalPeriodSwitching}
              />
            ) : null}
            {effectiveWorkspaceView === 'execEval' ? (
              <ExecutiveEvaluationPage
                key={`execeval-${String(evalSubjectEmployee?.id ?? '')}-${String(activeEvalPeriodKey ?? evalPeriodFallbackKey ?? '')}`}
                employee={evalSubjectEmployee}
                evalState={evalSubjectEmployee ? executiveEvalByEmployee[evalSubjectEmployee.id] : undefined}
                setEvalState={updateExecutiveEvalForSubject}
                evaluationCriteria={evaluationCriteria}
                activeEvalPeriodKey={activeEvalPeriodKey}
                setActiveEvalPeriodKey={requestEvalPeriodChange}
                evalPeriodSelectOptions={evalPeriodSelectOptions}
                evalPeriodFallbackKey={evalPeriodFallbackKey}
                executiveEvalHistoryByEmployee={executiveEvalHistoryByEmployee}
                isSubmittedForPeriod={executiveEvalSubmittedForActive}
                onSubmitEvaluation={submitExecutiveEvalForActivePeriod}
                peerSelfEval={evalSubjectEmployee ? selfEvalByEmployee[evalSubjectEmployee.id] : undefined}
                peerSupervisorEval={evalSubjectEmployee ? supervisorEvalByEmployee[evalSubjectEmployee.id] : undefined}
                canEvaluate
                blockedReason="自己評価と1次評価(上司)の提出後に2次評価(経営層)を入力できます。"
                focusMajorKey={evalFocusMajorKeyForActive}
                isPeriodSwitching={isEvalPeriodSwitching}
              />
            ) : null}
          </>
        )}
      </section>
      {isLoggedIn ? (
        <section className="mobileBottomNavCard" aria-label="メインメニュー">
          <div className="pageTabs pageTabsMain">
            {visibleWorkspaceTabs.map((t) => (
              <button
                key={t.key}
                type="button"
                className={`tabButton tabButtonMain ${effectiveWorkspaceView === t.key ? 'isActive' : ''}`}
                onClick={() => setWorkspaceView(t.key)}
              >
                <span className="tabButtonMainIcon" aria-hidden>
                  {MAIN_WORKSPACE_TAB_ICONS[t.key] ?? '•'}
                </span>
                <span className="tabButtonMainLabel">{t.label}</span>
              </button>
            ))}
          </div>
        </section>
      ) : null}
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

/** カウント画面下部デモ用（Amazon風カラー選択UI・コーヒー系ビジュアル） */
const COUNT_CATALOG_IMG = (id, w) =>
  `https://images.unsplash.com/${id}?ixlib=rb-4.0.3&auto=format&fit=crop&w=${w}&h=${w}&q=85`

const COUNT_CATALOG_VARIANTS = [
  {
    id: 'classic',
    name: 'クラシックロースト',
    image: COUNT_CATALOG_IMG('photo-1447933601403-0c6688de566e', 800),
    thumb: COUNT_CATALOG_IMG('photo-1447933601403-0c6688de566e', 320),
  },
  {
    id: 'fullcity',
    name: 'フルシティロースト',
    image: COUNT_CATALOG_IMG('photo-1514432324607-a09d9b4aefdd', 800),
    thumb: COUNT_CATALOG_IMG('photo-1514432324607-a09d9b4aefdd', 320),
  },
  {
    id: 'single',
    name: 'シングルオリジン',
    image: COUNT_CATALOG_IMG('photo-1495474472287-4d71bcdd2085', 800),
    thumb: COUNT_CATALOG_IMG('photo-1495474472287-4d71bcdd2085', 320),
  },
  {
    id: 'house',
    name: 'ハウスブレンド',
    image: COUNT_CATALOG_IMG('photo-1461023058943-07fc492165a3', 800),
    thumb: COUNT_CATALOG_IMG('photo-1461023058943-07fc492165a3', 320),
  },
  {
    id: 'morning',
    name: 'モーニングブレンド',
    image: COUNT_CATALOG_IMG('photo-1504630082624-a235ab6a70e7', 800),
    thumb: COUNT_CATALOG_IMG('photo-1504630082624-a235ab6a70e7', 320),
  },
]

const COUNT_CATALOG_PRICE = '¥5,500'

function CountWorkspacePage({ count, setCount, hourlyTarget, setHourlyTarget, isRunning, setIsRunning }) {
  const today = useMemo(
    () =>
      new Date().toLocaleDateString('ja-JP', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }),
    [],
  )

  const [catalogSelectedIndex, setCatalogSelectedIndex] = useState(0)
  const catalogCardRefs = useRef([])
  const catalogScrollSkipRef = useRef(true)

  useEffect(() => {
    if (catalogScrollSkipRef.current) {
      catalogScrollSkipRef.current = false
      return
    }
    const el = catalogCardRefs.current[catalogSelectedIndex]
    el?.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' })
  }, [catalogSelectedIndex])

  const decrement = () => setCount((prev) => Math.max(0, Number(prev || 0) - 1))
  const increment = () => setCount((prev) => Math.max(0, Number(prev || 0) + 1))
  const handleTargetChange = (event) => {
    const next = Math.max(1, Number(event.target.value) || 1)
    setHourlyTarget(Math.trunc(next))
  }

  const catalogActive = COUNT_CATALOG_VARIANTS[catalogSelectedIndex] ?? COUNT_CATALOG_VARIANTS[0]

  return (
    <section className="countPage">
      <header className="countPageHeader">
        <h2>カウントアプリ</h2>
        <span className="countDate">{today}</span>
      </header>

      <p className="countTargetLabel">1時間当たりの製作目標個数</p>
      <div className="countTargetRow">
        <input
          className="countTargetInput"
          type="number"
          min={1}
          step={1}
          value={hourlyTarget}
          onChange={handleTargetChange}
        />
        <span className="countTargetUnit">個/時間</span>
      </div>

      <div className="countCounterRow">
        <button type="button" className="countButton countButtonMinus" onClick={decrement}>
          －
        </button>
        <div className="countCurrent">{count}</div>
        <button type="button" className="countButton countButtonPlus" onClick={increment}>
          ＋
        </button>
      </div>

      <button
        type="button"
        className={`countToggleButton ${isRunning ? 'isStop' : 'isStart'}`}
        onClick={() => setIsRunning((prev) => !prev)}
      >
        {isRunning ? '終了' : '開始'}
      </button>

      <div className="countCatalogShop" aria-label="カラーバリエーション（デモ表示）">
        <div className="countCatalogHeroBleed">
          <div className="countCatalogMainFrame">
            <img
              className="countCatalogMainImg"
              src={catalogActive.image}
              alt={`${catalogActive.name}の商品画像`}
              width={800}
              height={800}
              decoding="async"
              loading="eager"
              referrerPolicy="no-referrer"
            />
          </div>
          <div className="countCatalogDots" role="tablist" aria-label="バリエーションの切り替え">
            {COUNT_CATALOG_VARIANTS.map((v, i) => (
              <button
                key={v.id}
                type="button"
                role="tab"
                aria-selected={i === catalogSelectedIndex}
                className={`countCatalogDot ${i === catalogSelectedIndex ? 'isActive' : ''}`}
                aria-label={`${v.name}を表示`}
                onClick={() => setCatalogSelectedIndex(i)}
              />
            ))}
          </div>
        </div>

        <div className="countCatalogBelow">
          <p className="countCatalogStyleLine">
            <span className="countCatalogStyleLabel">スタイル:</span>{' '}
            <strong className="countCatalogStyleValue">{catalogActive.name}</strong>
          </p>

          <ul className="countCatalogScroll">
            {COUNT_CATALOG_VARIANTS.map((v, i) => (
              <li key={v.id} className="countCatalogScrollItem">
                <button
                  type="button"
                  ref={(el) => {
                    catalogCardRefs.current[i] = el
                  }}
                  className={`countCatalogCard ${i === catalogSelectedIndex ? 'isSelected' : ''}`}
                  aria-pressed={i === catalogSelectedIndex}
                  aria-label={`${v.name} ${COUNT_CATALOG_PRICE}`}
                  onClick={() => setCatalogSelectedIndex(i)}
                >
                  <span className="countCatalogCardThumb">
                    <img
                      src={v.thumb}
                      alt=""
                      width={320}
                      height={320}
                      loading="lazy"
                      decoding="async"
                      referrerPolicy="no-referrer"
                    />
                  </span>
                  <span className="countCatalogCardBody">
                    <span className="countCatalogCardName">{v.name}</span>
                    <span className="countCatalogCardPrice">{COUNT_CATALOG_PRICE}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  )
}

function HonsuWorkspacePage() {
  const HONSU_TABS = [
    { key: 'nightguard', label: 'ナイトガード' },
    { key: 'cadOno', label: 'CAD小野さん' },
    { key: 'cadEto', label: 'CAD衛藤さん' },
  ]
  const [activeTab, setActiveTab] = useState(HONSU_TABS[0].key)
  const activeLabel = HONSU_TABS.find((tab) => tab.key === activeTab)?.label ?? HONSU_TABS[0].label

  return (
    <section className="honsuPage">
      <header className="honsuHeader">
        <h2>本数表</h2>
        <p>項目を切り替えて内容を管理します。</p>
      </header>

      <div className="pageTabs pageTabsSub honsuTabs" role="tablist" aria-label="本数表の切り替え">
        {HONSU_TABS.map((tab) => (
          <button
            key={tab.key}
            type="button"
            role="tab"
            aria-selected={activeTab === tab.key}
            className={`tabButton ${activeTab === tab.key ? 'isActive' : ''}`}
            onClick={() => setActiveTab(tab.key)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <section className="honsuPanel">
        <h3>{activeLabel}</h3>
        <p>このタブの中身は次に一緒に作っていきましょう。</p>
      </section>
    </section>
  )
}

function DepartmentSettingsPage({ deptOptions, setDeptOptions, employeeDirectoryRows, skillSettings }) {
  const [newDept, setNewDept] = useState('')

  const deptUsage = useMemo(() => {
    const map = new Map()
    for (const d of deptOptions) map.set(d, { employees: 0, skills: 0 })
    for (const row of employeeDirectoryRows || []) {
      const d = String(row?.dept ?? '').trim()
      if (!map.has(d)) continue
      map.get(d).employees += 1
    }
    for (const sk of skillSettings || []) {
      const deps = sk.departments || []
      if (deps.includes('all')) continue
      for (const d of deps) {
        if (!map.has(d)) continue
        map.get(d).skills += 1
      }
    }
    return map
  }, [deptOptions, employeeDirectoryRows, skillSettings])

  const handleAdd = () => {
    const v = newDept.trim()
    if (!v) return
    if (deptOptions.includes(v)) {
      window.alert('同じ名前の部署がすでにあります。')
      return
    }
    setDeptOptions((prev) => [...prev, v])
    setNewDept('')
  }

  const handleRemove = (name) => {
    if (deptOptions.length <= 1) {
      window.alert('部署は1つ以上残してください。')
      return
    }
    const u = deptUsage.get(name) ?? { employees: 0, skills: 0 }
    if (u.employees > 0 || u.skills > 0) {
      window.alert(
        `「${name}」は使用中のため削除できません。\n・従業員: ${u.employees}人\n・スキル設定（対象部署）: ${u.skills}件\n先に従業員の部署やスキルの対象部署を変更してください。`,
      )
      return
    }
    setDeptOptions((prev) => prev.filter((d) => d !== name))
  }

  return (
    <section className="deptSettingsPage">
      <header className="deptSettingsHeader">
        <h2>部署マスタ</h2>
        <p className="deptSettingsLead">
          従業員管理・スキル設定の「部署」に使う名前を登録します。追加した部署はすぐにプルダウンに反映されます。
        </p>
      </header>

      <div className="deptSettingsAddRow">
        <label className="deptSettingsAddLabel">
          <span>部署名を追加</span>
          <input
            type="text"
            value={newDept}
            onChange={(e) => setNewDept(e.target.value)}
            placeholder="例: 開発"
            maxLength={40}
          />
        </label>
        <button type="button" className="deptSettingsAddBtn" onClick={handleAdd}>
          追加
        </button>
      </div>

      <ul className="deptSettingsList">
        {deptOptions.map((name) => {
          const u = deptUsage.get(name) ?? { employees: 0, skills: 0 }
          const inUse = u.employees > 0 || u.skills > 0
          return (
            <li key={name} className="deptSettingsItem">
              <span className="deptSettingsName">{name}</span>
              <span className="deptSettingsMeta">
                {inUse ? `使用中（従業員 ${u.employees}人 / スキル ${u.skills}件）` : '未使用'}
              </span>
              <button
                type="button"
                className="deptSettingsRemoveBtn"
                onClick={() => handleRemove(name)}
                disabled={deptOptions.length <= 1}
              >
                削除
              </button>
            </li>
          )
        })}
      </ul>
    </section>
  )
}

const MENU_DISPLAY_ROLE_CARDS = [
  { key: MENU_ROLE_IPPAN, badge: '一般', title: '一般従業員', cardClass: 'menuDispCardIppan' },
  { key: MENU_ROLE_JOUSHI, badge: '上司', title: '上司', cardClass: 'menuDispCardJoushi' },
  { key: MENU_ROLE_YAKUIN, badge: '役員', title: '役員', cardClass: 'menuDispCardYakuin' },
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

function EvalPeriodSettingsPage({ definitions, setDefinitions, onSelectActivePeriod, onCleanupHistory, onRemovePeriodKey }) {
  const currentYear = new Date().getFullYear()
  const [draftYear, setDraftYear] = useState(String(currentYear))
  const [draftMonth, setDraftMonth] = useState('03')
  const [draftLabel, setDraftLabel] = useState('')
  const [draftOnlyForIds, setDraftOnlyForIds] = useState('')
  const [draftSelfEvalDeadlineAt, setDraftSelfEvalDeadlineAt] = useState('')
  const [draftSupervisorEvalDeadlineAt, setDraftSupervisorEvalDeadlineAt] = useState('')
  const [draftExecutiveEvalDeadlineAt, setDraftExecutiveEvalDeadlineAt] = useState('')
  const [draggingPeriodKey, setDraggingPeriodKey] = useState('')
  const [dragOverPeriodKey, setDragOverPeriodKey] = useState('')
  const rowRefs = useRef({})
  const prevRowRectsRef = useRef(new Map())

  useLayoutEffect(() => {
    const nextRects = new Map()
    for (const row of definitions) {
      const key = String(row?.key ?? '').trim()
      if (!key) continue
      const el = rowRefs.current[key]
      if (!el) continue
      const rect = el.getBoundingClientRect()
      nextRects.set(key, rect)
      const prevRect = prevRowRectsRef.current.get(key)
      if (!prevRect) continue
      const dx = prevRect.left - rect.left
      const dy = prevRect.top - rect.top
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue
      el.style.transition = 'none'
      el.style.transform = `translate(${dx}px, ${dy}px)`
      requestAnimationFrame(() => {
        el.style.transition = 'transform 220ms cubic-bezier(0.2, 0, 0, 1)'
        el.style.transform = 'translate(0, 0)'
      })
    }
    prevRowRectsRef.current = nextRects
  }, [definitions])

  const resetMarSep = () => {
    if (!window.confirm('評価期一覧を「毎年3月・9月」のデフォルト（前後数年分）に置き換えますか？')) return
    setDefinitions(buildDefaultMarSepEvalPeriods())
  }

  const addRow = () => {
    const year = String(draftYear ?? '').trim()
    if (!/^\d{4}$/.test(year)) {
      window.alert('年は4桁で入力してください（例: 2027）')
      return
    }
    const month = String(draftMonth ?? '').trim()
    if (month !== '03' && month !== '09') return
    const key = `${year}-${month}`
    if (definitions.some((d) => d.key === key)) {
      window.alert('同じキーの行が既にあります。')
      return
    }
    const onlyForEmployeeIds = parseCommaSeparatedEmployeeIds(draftOnlyForIds)
    const defaultLabel = `${year}年${Number(month)}月期`
    const label = draftLabel.trim() || defaultLabel
    const selfEvalDeadlineAt = normalizeDeadlineDate(draftSelfEvalDeadlineAt)
    const supervisorEvalDeadlineAt = normalizeDeadlineDate(draftSupervisorEvalDeadlineAt)
    const executiveEvalDeadlineAt = normalizeDeadlineDate(draftExecutiveEvalDeadlineAt)
    const row = onlyForEmployeeIds.length > 0 ? { key, label, onlyForEmployeeIds } : { key, label }
    if (selfEvalDeadlineAt) row.selfEvalDeadlineAt = selfEvalDeadlineAt
    if (supervisorEvalDeadlineAt) row.supervisorEvalDeadlineAt = supervisorEvalDeadlineAt
    if (executiveEvalDeadlineAt) row.executiveEvalDeadlineAt = executiveEvalDeadlineAt
    setDefinitions((prev) => {
      if (prev.some((d) => d.key === key)) return prev
      return [row, ...prev]
    })
    onSelectActivePeriod?.(key)
    setDraftYear(String(currentYear))
    setDraftMonth('03')
    setDraftLabel('')
    setDraftOnlyForIds('')
    setDraftSelfEvalDeadlineAt('')
    setDraftSupervisorEvalDeadlineAt('')
    setDraftExecutiveEvalDeadlineAt('')
  }

  const removeRow = (key) => {
    if (
      !window.confirm(
        `「${key}」を一覧から削除しますか？この期の履歴データと旧「この人のみ」設定も同時に整理します。`,
      )
    ) {
      return
    }
    setDefinitions((defs) => defs.filter((d) => d.key !== key))
    onRemovePeriodKey?.(key)
  }

  const moveRowByKey = useCallback((sourceKey, targetKey) => {
    if (!sourceKey || !targetKey || sourceKey === targetKey) return
    setDefinitions((prev) => {
      const from = prev.findIndex((d) => d.key === sourceKey)
      const to = prev.findIndex((d) => d.key === targetKey)
      if (from < 0 || to < 0 || from === to) return prev
      const next = [...prev]
      const [picked] = next.splice(from, 1)
      next.splice(to, 0, picked)
      return next
    })
  }, [setDefinitions])

  const handleDragStart = (event, key) => {
    setDraggingPeriodKey(key)
    setDragOverPeriodKey('')
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData('text/plain', key)
  }

  const handleDropOnRow = (event, targetKey) => {
    event.preventDefault()
    const sourceKey = String(event.dataTransfer.getData('text/plain') || draggingPeriodKey || '').trim()
    moveRowByKey(sourceKey, targetKey)
    setDraggingPeriodKey('')
    setDragOverPeriodKey('')
  }

  const handleCleanupHistory = () => {
    if (!onCleanupHistory) return
    if (!window.confirm('評価期マスタに無い期キーを、自己評価/上司評価の履歴から削除します。実行しますか？')) return
    const removed = Number(onCleanupHistory()) || 0
    window.alert(removed > 0 ? `${removed}件の履歴キーを整理しました。` : '削除対象はありませんでした。')
  }

  return (
    <section className="evalPeriodSettingsPage">
      <h2 className="evalPeriodSettingsTitle">評価期マスタ</h2>
      <p className="evalPeriodSettingsLead">
        評価の単位となる「期」を定義します。必要な期を手動で追加してください。全社で使う臨時期はそのまま追加し、
        <strong>特定の社員だけ</strong>の期は「適用社員C」に社員Cをカンマ区切りで入力してください（空欄のときは全員に表示されます）。
      </p>
      <p className="evalPeriodSettingsNote evalPeriodSettingsNote--drag">
        期の行をドラッグ&ドロップすると並び順を変更できます（この順でレーダーの表示期を優先します）。
      </p>
      <ul className="evalPeriodSettingsList">
        {definitions.map((row) => (
          <li
            key={row.key}
            className={`evalPeriodSettingsRow${draggingPeriodKey === row.key ? ' isDragging' : ''}${
              dragOverPeriodKey === row.key ? ' isDragOver' : ''
            }`}
            draggable
            ref={(el) => {
              if (el) rowRefs.current[row.key] = el
              else delete rowRefs.current[row.key]
            }}
            onDragStart={(event) => handleDragStart(event, row.key)}
            onDragOver={(event) => {
              event.preventDefault()
              if (dragOverPeriodKey !== row.key) setDragOverPeriodKey(row.key)
            }}
            onDragEnter={() => setDragOverPeriodKey(row.key)}
            onDrop={(event) => handleDropOnRow(event, row.key)}
            onDragEnd={() => {
              setDraggingPeriodKey('')
              setDragOverPeriodKey('')
            }}
          >
            <div className="evalPeriodSettingsRowMain">
              <span className="evalPeriodSettingsKey">{row.key}</span>
              <span className="evalPeriodSettingsLabel">{row.label}</span>
              <span className="evalPeriodSettingsScope">
                {row.onlyForEmployeeIds?.length
                  ? `指定社員: ${row.onlyForEmployeeIds.join(', ')}`
                  : '全員'}
              </span>
              <span className="evalPeriodSettingsScope">
                自己締切: {row.selfEvalDeadlineAt || '未設定'} / 上司締切: {row.supervisorEvalDeadlineAt || '未設定'} / 経営層締切:{' '}
                {row.executiveEvalDeadlineAt || '未設定'}
              </span>
            </div>
            <div className="evalPeriodSettingsRowActions">
              <button type="button" className="evalPeriodSettingsRemove" onClick={() => removeRow(row.key)}>
                削除
              </button>
            </div>
          </li>
        ))}
      </ul>
      <div className="evalPeriodSettingsAdd">
        <h3 className="evalPeriodSettingsSubheading">期の追加</h3>
        <div className="evalPeriodSettingsAddGrid">
          <label className="evalPeriodSettingsAddField">
            年
            <input
              type="number"
              min="2000"
              max="2099"
              step="1"
              value={draftYear}
              onChange={(e) => setDraftYear(e.target.value)}
              placeholder="2027"
            />
          </label>
          <label className="evalPeriodSettingsAddField">
            月
            <select value={draftMonth} onChange={(e) => setDraftMonth(e.target.value)}>
              <option value="03">3月</option>
              <option value="09">9月</option>
            </select>
          </label>
          <label className="evalPeriodSettingsAddField evalPeriodSettingsAddField--wide">
            表示名（任意）
            <input
              value={draftLabel}
              onChange={(e) => setDraftLabel(e.target.value)}
              placeholder="未入力なら「YYYY年M月期」で自動作成"
            />
          </label>
          <label className="evalPeriodSettingsAddField evalPeriodSettingsAddField--wide">
            適用社員C（任意・空欄=全員）
            <input
              value={draftOnlyForIds}
              onChange={(e) => setDraftOnlyForIds(e.target.value)}
              placeholder="例: e1, 0001（カンマ・スペース区切り）"
            />
          </label>
          <label className="evalPeriodSettingsAddField evalPeriodSettingsAddField--wide">
            自己評価締切（任意）
            <input type="date" value={draftSelfEvalDeadlineAt} onChange={(e) => setDraftSelfEvalDeadlineAt(e.target.value)} />
          </label>
          <label className="evalPeriodSettingsAddField evalPeriodSettingsAddField--wide">
            上司評価締切（任意）
            <input
              type="date"
              value={draftSupervisorEvalDeadlineAt}
              onChange={(e) => setDraftSupervisorEvalDeadlineAt(e.target.value)}
            />
          </label>
          <label className="evalPeriodSettingsAddField evalPeriodSettingsAddField--wide">
            経営層評価締切（任意）
            <input
              type="date"
              value={draftExecutiveEvalDeadlineAt}
              onChange={(e) => setDraftExecutiveEvalDeadlineAt(e.target.value)}
            />
          </label>
      </div>
        <button type="button" className="evalPeriodSettingsAddBtn" onClick={addRow}>
          追加
        </button>
      </div>
      <div className="evalPeriodSettingsFooter">
        <button type="button" className="evalPeriodSettingsResetBtn" onClick={resetMarSep}>
          3月・9月のデフォルト一覧に戻す
        </button>
        <button type="button" className="evalPeriodSettingsCleanupBtn" onClick={handleCleanupHistory}>
          マスタ外の履歴期を整理
        </button>
      </div>
      <p className="evalPeriodSettingsNote">
        初回や保存がないときの「おすすめの期」は、今日の日付から見て直近の開始月（マスタの各期の月1日）を基準に自動で選ばれます。
      </p>
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
  const evalCritCsvFileRef = useRef(null)
  const [evalCritCsvMessage, setEvalCritCsvMessage] = useState('')

  useEffect(() => {
    if (!grades.some((g) => g.id === activeGradeId)) {
      setActiveGradeId(grades[0]?.id ?? 'G1')
    }
  }, [grades, activeGradeId])

  const sharedMajors = criteria?.sharedMajors ?? []
  const minorsForGrade = useMemo(() => {
    const blob = criteria?.minorsByGrade?.[activeGradeId]
    return blob && typeof blob === 'object' && !Array.isArray(blob) ? blob : {}
  }, [criteria, activeGradeId])

  const majors = useMemo(
    () =>
      sharedMajors.map((sm) => ({
        id: sm.id,
        title: sm.title,
        minors: Array.isArray(minorsForGrade[sm.id]) ? minorsForGrade[sm.id] : [],
      })),
    [sharedMajors, minorsForGrade],
  )

  const gradeLabel = grades.find((g) => g.id === activeGradeId)?.label ?? activeGradeId
  const totalWeightPct = useMemo(
    () =>
      majors.reduce(
        (sum, major) =>
          sum + major.minors.reduce((s, mi) => s + Math.max(0, Number(mi?.weightPct) || 0), 0),
        0,
      ),
    [majors],
  )
  const isWeightTotalValid = Math.abs(totalWeightPct - 100) < 0.001

  const updateMinorsPatch = (majorId, nextList) => {
    setCriteria((prev) => ({
      ...prev,
      minorsByGrade: {
        ...(prev.minorsByGrade ?? {}),
        [activeGradeId]: {
          ...((prev.minorsByGrade ?? {})[activeGradeId] ?? {}),
          [majorId]: nextList,
        },
      },
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
      const id = newEvaluationId('maj')
      setCriteria((prev) => {
        const nextShared = [...(prev.sharedMajors ?? []), { id, title: t }]
        const nextMinors = { ...(prev.minorsByGrade ?? {}) }
        for (const g of grades) {
          const gid = g.id
          const cur = { ...(nextMinors[gid] ?? {}) }
          cur[id] = []
          nextMinors[gid] = cur
        }
        return { ...prev, sharedMajors: nextShared, minorsByGrade: nextMinors }
      })
    } else {
      setCriteria((prev) => ({
        ...prev,
        sharedMajors: (prev.sharedMajors ?? []).map((m) =>
          m.id === majorModal.majorId ? { ...m, title: t } : m,
        ),
      }))
    }
    closeMajorModal()
  }

  const deleteMajor = (majorId) => {
    if (!window.confirm('この大項目と、全等級の配下小項目をすべて削除しますか？')) return
    setCriteria((prev) => {
      const nextShared = (prev.sharedMajors ?? []).filter((m) => m.id !== majorId)
      const nextMinors = {}
      for (const [gid, blob] of Object.entries(prev.minorsByGrade ?? {})) {
        if (typeof blob !== 'object' || Array.isArray(blob)) continue
        const cur = { ...blob }
        delete cur[majorId]
        nextMinors[gid] = cur
      }
      return { ...prev, sharedMajors: nextShared, minorsByGrade: nextMinors }
    })
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
    const curMinors = majors.find((m) => m.id === minorModal.majorId)?.minors ?? []
    if (minorModal.mode === 'add') {
      updateMinorsPatch(minorModal.majorId, [
        ...curMinors,
        { id: newEvaluationId('min'), title: t, weightPct, scoreCriteria: scores },
      ])
    } else {
      updateMinorsPatch(
        minorModal.majorId,
        curMinors.map((mi) =>
              mi.id === minorModal.minorId ? { ...mi, title: t, weightPct, scoreCriteria: scores } : mi,
            ),
      )
    }
    closeMinorModal()
  }

  const deleteMinor = (majorId, minorId) => {
    if (!window.confirm('この小項目を削除しますか？')) return
    const curMinors = majors.find((m) => m.id === majorId)?.minors ?? []
    updateMinorsPatch(majorId, curMinors.filter((mi) => mi.id !== minorId))
  }

  const toggleMajorOpen = (majorId) => {
    setOpenMajors((prev) => ({ ...prev, [majorId]: !prev[majorId] }))
  }

  const handleExportCriteriaCsv = () => {
    const headers = [
      '等級ID',
      '等級名',
      '大項目ID',
      '大項目名',
      '小項目ID',
      '小項目名',
      'ウェイト',
      '1点基準',
      '2点基準',
      '3点基準',
      '4点基準',
      '5点基準',
    ]
    const gradeLabelById = Object.fromEntries(grades.map((g) => [g.id, g.label ?? g.id]))
    const sm = criteria?.sharedMajors ?? []
    const byGrade = criteria?.minorsByGrade ?? {}
    const body = []
    for (const g of grades) {
      const gradeId = g.id
      const gradeBlob = byGrade[gradeId] && typeof byGrade[gradeId] === 'object' && !Array.isArray(byGrade[gradeId])
        ? byGrade[gradeId]
        : {}
      for (const major of sm) {
        const minors = Array.isArray(gradeBlob[major.id]) ? gradeBlob[major.id] : []
        if (minors.length === 0) {
          body.push(
            [
              escapeCsvField(gradeId),
              escapeCsvField(gradeLabelById[gradeId] ?? gradeId),
              escapeCsvField(major.id),
              escapeCsvField(major.title),
              escapeCsvField(''),
              escapeCsvField(''),
              escapeCsvField(''),
              escapeCsvField(''),
              escapeCsvField(''),
              escapeCsvField(''),
              escapeCsvField(''),
              escapeCsvField(''),
            ].join(','),
          )
          continue
        }
        for (const minor of minors) {
          const scoreCriteria = [...(minor.scoreCriteria ?? []), '', '', '', '', ''].slice(0, 5)
          body.push(
            [
              escapeCsvField(gradeId),
              escapeCsvField(gradeLabelById[gradeId] ?? gradeId),
              escapeCsvField(major.id),
              escapeCsvField(major.title),
              escapeCsvField(minor.id),
              escapeCsvField(minor.title),
              escapeCsvField(minor.weightPct ?? 0),
              escapeCsvField(scoreCriteria[0]),
              escapeCsvField(scoreCriteria[1]),
              escapeCsvField(scoreCriteria[2]),
              escapeCsvField(scoreCriteria[3]),
              escapeCsvField(scoreCriteria[4]),
            ].join(','),
          )
        }
      }
    }
    const csvContent = [headers.map(escapeCsvField).join(','), ...body].join('\r\n')
    const bom = '\uFEFF'
    const blob = new Blob([bom + csvContent], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    const date = new Date().toISOString().slice(0, 10)
    link.href = url
    link.download = `evaluation_criteria_${date}.csv`
    link.click()
    URL.revokeObjectURL(url)
    setEvalCritCsvMessage(`${body.length}件をCSVエクスポートしました。`)
  }

  const handleExportCriteriaTemplateCsv = () => {
    const headers = [
      '等級ID',
      '等級名',
      '大項目ID',
      '大項目名',
      '小項目ID',
      '小項目名',
      'ウェイト',
      '1点基準',
      '2点基準',
      '3点基準',
      '4点基準',
      '5点基準',
    ]
    const csvContent = headers.map(escapeCsvField).join(',')
    const bom = '\uFEFF'
    const blob = new Blob([bom + csvContent], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = 'evaluation_criteria_template.csv'
    link.click()
    URL.revokeObjectURL(url)
    setEvalCritCsvMessage('ヘッダー行のみのテンプレートをダウンロードしました。2行目以降にデータを入力してインポートしてください。')
  }

  const handleImportCriteriaCsv = async (event) => {
    const file = event.target.files?.[0]
    if (!file) return
    try {
      const content = await file.text()
      const lines = content
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line !== '')
      if (lines.length < 2) {
        setEvalCritCsvMessage('CSVにデータ行がありません。')
        return
      }
      const headers = parseCsvLine(lines[0])
      const gradeIdIdx = findHeaderIndex(headers, ['等級ID', 'gradeId'])
      const majorTitleIdx = findHeaderIndex(headers, ['大項目名', 'majorTitle'])
      const majorIdIdx = findHeaderIndex(headers, ['大項目ID', 'majorId'])
      const minorTitleIdx = findHeaderIndex(headers, ['小項目名', 'minorTitle'])
      const minorIdIdx = findHeaderIndex(headers, ['小項目ID', 'minorId'])
      const weightIdx = findHeaderIndex(headers, ['ウェイト', 'weightPct'])
      const s1Idx = findHeaderIndex(headers, ['1点基準', 'score1'])
      const s2Idx = findHeaderIndex(headers, ['2点基準', 'score2'])
      const s3Idx = findHeaderIndex(headers, ['3点基準', 'score3'])
      const s4Idx = findHeaderIndex(headers, ['4点基準', 'score4'])
      const s5Idx = findHeaderIndex(headers, ['5点基準', 'score5'])
      if (gradeIdIdx < 0 || majorTitleIdx < 0) {
        setEvalCritCsvMessage('CSVヘッダーに「等級ID」「大項目名」が必要です。')
        return
      }

      const byGrade = {}
      let importedMinorCount = 0
      let importedMajorCount = 0

      for (let i = 1; i < lines.length; i++) {
        const cols = parseCsvLine(lines[i])
        const gradeIdRaw = String(cols[gradeIdIdx] ?? '').trim()
        const majorTitle = String(cols[majorTitleIdx] ?? '').trim()
        if (!gradeIdRaw || !majorTitle) continue

        const gradeId = grades.some((g) => g.id === gradeIdRaw) ? gradeIdRaw : null
        if (!gradeId) continue

        if (!byGrade[gradeId]) byGrade[gradeId] = new Map()
        const majorId = String(cols[majorIdIdx] ?? '').trim() || `maj_csv_${majorTitle}`
        if (!byGrade[gradeId].has(majorId)) {
          byGrade[gradeId].set(majorId, { id: majorId, title: majorTitle, minors: [] })
          importedMajorCount += 1
        } else {
          const existingMajor = byGrade[gradeId].get(majorId)
          existingMajor.title = majorTitle
        }

        const minorTitle = minorTitleIdx >= 0 ? String(cols[minorTitleIdx] ?? '').trim() : ''
        if (!minorTitle) continue

        const minorId = String(cols[minorIdIdx] ?? '').trim() || `min_csv_${minorTitle}`
        const weightPct = Math.min(100, Math.max(0, Number(cols[weightIdx] ?? 0) || 0))
        const scores = [
          String(cols[s1Idx] ?? '').trim(),
          String(cols[s2Idx] ?? '').trim(),
          String(cols[s3Idx] ?? '').trim(),
          String(cols[s4Idx] ?? '').trim(),
          String(cols[s5Idx] ?? '').trim(),
        ]
        const majorRef = byGrade[gradeId].get(majorId)
        const idx = majorRef.minors.findIndex((m) => m.id === minorId)
        const nextMinor = { id: minorId, title: minorTitle, weightPct, scoreCriteria: scores }
        if (idx >= 0) majorRef.minors[idx] = nextMinor
        else majorRef.minors.push(nextMinor)
        importedMinorCount += 1
      }

      const importedGradeIds = Object.keys(byGrade)
      if (importedGradeIds.length === 0) {
        setEvalCritCsvMessage('取り込める評価基準データがありませんでした。')
        return
      }

      setCriteria((prev) => {
        const prevNorm = normalizeEvaluationCriteriaStore(prev, grades)
        const legacy = {}
        for (const g of grades) {
          const gid = g.id
          if (importedGradeIds.includes(gid)) {
            legacy[gid] = Array.from(byGrade[gid].values())
          } else {
            legacy[gid] = prevNorm.sharedMajors.map((sm) => ({
              id: sm.id,
              title: sm.title,
              minors: [...(prevNorm.minorsByGrade[gid]?.[sm.id] ?? [])],
            }))
          }
        }
        return migrateLegacyEvaluationCriteriaToShared(legacy, grades)
      })
      setEvalCritCsvMessage(
        `${importedGradeIds.length}等級 / 大項目${importedMajorCount}件 / 小項目${importedMinorCount}件をCSVインポートしました。`,
      )
    } catch {
      setEvalCritCsvMessage('CSVの読み込みに失敗しました。形式を確認してください。')
    } finally {
      event.target.value = ''
    }
  }

  return (
    <section className="evalCritPage">
      <header className="evalCritHeader">
        <h2>評価基準設定</h2>
        <p className="evalCritLead">
          大項目（評価の大目標）は等級によらず共通です（G1〜G6で同じ構成になります）。小項目・ウエイト・1〜5点の基準は、等級を切り替えて等級ごとに設定します。
        </p>
      </header>

      <div className="evalCritToolbar">
        <div className="evalCritToolbarLeft evalCritToolbarLeftStack">
          <button type="button" className="evalCritAddMajorBtn" onClick={openAddMajor}>
            + 大項目を追加（全等級共通）
          </button>
        <label className="evalCritGradeSelect">
            小項目・ウエイトを編集する等級
          <select value={activeGradeId} onChange={(event) => setActiveGradeId(event.target.value)}>
            {grades.map((g) => (
              <option key={g.id} value={g.id}>
                {g.label ?? g.id}
              </option>
            ))}
          </select>
        </label>
        </div>
        <div className="evalCritToolbarRight">
          <button type="button" className="btn export" onClick={handleExportCriteriaCsv}>
            CSVエクスポート
        </button>
          <button type="button" className="btn import" onClick={() => evalCritCsvFileRef.current?.click()}>
            CSVインポート
          </button>
          <button type="button" className="btn template" onClick={handleExportCriteriaTemplateCsv}>
            CSVテンプレート
          </button>
          <input
            ref={evalCritCsvFileRef}
            type="file"
            accept=".csv,text/csv"
            className="employeeCsvHiddenInput"
            onChange={handleImportCriteriaCsv}
          />
        </div>
      </div>
      {evalCritCsvMessage ? <p className="evalCritCsvMessage">{evalCritCsvMessage}</p> : null}

      <p className="evalCritGradeEditHint">
        表示中: <strong>{gradeLabel}</strong> の小項目・ウエイト・評価基準を編集しています。
      </p>
      <div className={`evalCritWeightSummary ${isWeightTotalValid ? 'isValid' : 'isInvalid'}`}>
        合計ウエイト: <strong>{totalWeightPct.toFixed(1)}%</strong>
        {isWeightTotalValid ? '（OK）' : '（100%になるよう調整してください）'}
      </div>

      <div className="evalCritBoard">
        {majors.length === 0 ? (
          <p className="evalCritEmpty">
            大項目がありません。「+ 大項目を追加（全等級共通）」から追加してください。
          </p>
        ) : (
          <div className="evalCritMajorList">
            {majors.map((maj) => {
              const open = !!openMajors[maj.id]
              const majorTone = maj.superGroup === 'interpersonal' ? 'interpersonal' : 'business'
              return (
                <article key={maj.id} className={`evalCritMajorCard evalCritMajorCard--${majorTone}`}>
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
            <p className="evalCritModalSub">全等級で共通の大目標（大項目）です。名称の変更はすべての等級に反映されます。</p>
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
            <p className="evalCritModalSub">
              等級「{gradeLabel}」向けの小項目です。ウエイトと1〜5点の基準は等級ごとに変えられます。
            </p>
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

function weightedEvalScore100ByCategories(categories, scoresMap, superGroupFilter = null) {
  let weightedNormSum = 0
  let weightSum = 0
  for (const cat of categories ?? []) {
    if (superGroupFilter && cat?.superGroup !== superGroupFilter) continue
    for (const it of cat?.items ?? []) {
      const score = Number(scoresMap?.[it.id])
      if (!Number.isFinite(score) || score < 1 || score > 5) continue
      const weight = Math.max(0, Number(it?.weightPct) || 0)
      if (!weight) continue
      const normalized01 = (score - 1) / 4
      weightedNormSum += normalized01 * weight
      weightSum += weight
    }
  }
  if (weightSum <= 0) return null
  return (weightedNormSum / weightSum) * 100
}

function selfEvalHistoryDeltaLabel(now, prev) {
  if (!Number.isFinite(now) || !Number.isFinite(prev)) return '—'
  const d = now - prev
  if (Math.abs(d) < 0.05) return '±0.0'
  return `${d > 0 ? '+' : ''}${d.toFixed(1)}`
}

function evalHistoryDeltaToneClass(label) {
  const s = String(label ?? '')
  if (s.startsWith('+')) return 'isUp'
  if (s.startsWith('-')) return 'isDown'
  return ''
}

function selfEvalSuperGroupStats100(criteriaStore, gradeId, state) {
  const cats = buildEvalCategoriesForGrade(criteriaStore, gradeId)
  const scores = state?.scores ?? {}
  return {
    business100: weightedEvalScore100ByCategories(cats, scores, 'business'),
    interpersonal100: weightedEvalScore100ByCategories(cats, scores, 'interpersonal'),
  }
}

function weightedEvalScore100ByItems(items, scoresMap) {
  let weightedNormSum = 0
  let weightSum = 0
  for (const it of items ?? []) {
    const score = Number(scoresMap?.[it.id])
    if (!Number.isFinite(score) || score < 1 || score > 5) continue
    const weight = Math.max(0, Number(it?.weightPct) || 0)
    if (!weight) continue
    const normalized01 = (score - 1) / 4
    weightedNormSum += normalized01 * weight
    weightSum += weight
  }
  if (weightSum <= 0) return null
  return (weightedNormSum / weightSum) * 100
}

function buildMajorOptionsAndWeightsForGrade(evaluationCriteria, gradeId) {
  const cats = buildEvalCategoriesForGrade(evaluationCriteria, gradeId)
  if (!Array.isArray(cats) || !cats.length) return []
  return cats.map((cat, idx) => {
    const id = String(cat?.id ?? '').trim() || `major-${idx}`
    const title = String(cat?.title ?? '').trim() || `大項目${idx + 1}`
    const weightPct = (cat?.items ?? []).reduce((sum, it) => sum + Math.max(0, Number(it?.weightPct) || 0), 0)
    return { id, title, weightPct }
  })
}

function normalizeExecutiveBaseLevel(value) {
  const n = Number(value)
  if (!Number.isFinite(n)) return Number.NaN
  if (n > 5) return Math.max(1, Math.min(5, Math.round(n / 20)))
  return Math.max(1, Math.min(5, Math.round(n)))
}

function executiveBaseLevelToScore100(level) {
  const lv = normalizeExecutiveBaseLevel(level)
  if (!Number.isFinite(lv)) return Number.NaN
  return lv * 20
}

function executiveEvalCategoryScores100(axisMajors, execState) {
  const majors = Array.isArray(axisMajors) ? axisMajors : []
  if (!majors.length) return null
  const baseByMajorRaw =
    execState?.baseByMajor && typeof execState.baseByMajor === 'object' && !Array.isArray(execState.baseByMajor)
      ? execState.baseByMajor
      : {}
  const out = Object.fromEntries(majors.map((m) => [m.id, 0]))
  let hasMajorBase = false
  for (const m of majors) {
    const n = executiveBaseLevelToScore100(baseByMajorRaw?.[m.id])
    if (Number.isFinite(n)) {
      out[m.id] = n
      hasMajorBase = true
    }
  }
  if (!hasMajorBase) {
    const baseScore = Math.max(0, Math.min(100, Number(execState?.baseScore ?? 0) || 0))
    const baseShare = baseScore / majors.length
    for (const m of majors) out[m.id] = baseShare
  }
  const majorIdSet = new Set(majors.map((m) => m.id))
  const history = Array.isArray(execState?.commentHistory) ? execState.commentHistory : []
  for (const row of history) {
    const key = String(row?.majorCategoryKey ?? '').trim()
    const delta = Number(row?.delta) || 0
    if (key && majorIdSet.has(key)) {
      out[key] = (Number(out[key]) || 0) + delta
      continue
    }
    // 旧データ（大項目未紐付け）救済: 全大項目へ均等配分して総合評価に反映する
    const spread = delta / majors.length
    for (const m of majors) {
      out[m.id] = (Number(out[m.id]) || 0) + spread
    }
  }
  for (const m of majors) {
    out[m.id] = Math.max(0, Math.min(100, Number(out[m.id]) || 0))
  }
  return out
}

function executiveEvalOverallBaseScore(execState, axisMajors = []) {
  const byMajor =
    execState?.baseByMajor && typeof execState.baseByMajor === 'object' && !Array.isArray(execState.baseByMajor)
      ? execState.baseByMajor
      : {}
  const ids = (Array.isArray(axisMajors) ? axisMajors : []).map((m) => String(m?.id ?? '').trim()).filter(Boolean)
  const vals = (ids.length ? ids.map((id) => Number(byMajor[id])) : Object.values(byMajor).map((v) => Number(v))).filter((v) =>
    Number.isFinite(v),
  )
  if (vals.length) return vals.reduce((sum, v) => sum + v, 0) / vals.length
  return Math.max(0, Math.min(100, Number(execState?.baseScore ?? 0) || 0))
}

function executiveEvalOverallScore100(execState, axisMajors, majorWeightById = {}) {
  const majors = Array.isArray(axisMajors) ? axisMajors : []
  if (!majors.length) return Math.max(0, Math.min(100, Number(execState?.baseScore ?? 0) || 0))
  const byMajor = executiveEvalCategoryScores100(majors, execState)
  if (!byMajor) return Math.max(0, Math.min(100, Number(execState?.baseScore ?? 0) || 0))
  let weightedSum = 0
  let weightTotal = 0
  for (const major of majors) {
    const v = Number(byMajor?.[major.id])
    if (!Number.isFinite(v)) continue
    const w = Math.max(0, Number(majorWeightById?.[major.id]) || 0)
    const effW = w > 0 ? w : 1
    weightedSum += v * effW
    weightTotal += effW
  }
  if (weightTotal <= 0) return 0
  return Math.max(0, Math.min(100, weightedSum / weightTotal))
}

function quantizeExecutiveScore100(value) {
  const clamped = Math.max(0, Math.min(100, Number(value) || 0))
  return Math.max(0, Math.min(100, Math.round(clamped / 20) * 20))
}

function evalEntryForEmployeeId(evalMap, employeeId) {
  if (!evalMap || typeof evalMap !== 'object') return undefined
  const t = String(employeeId ?? '').trim()
  if (!t) return undefined
  const key = Object.keys(evalMap).find((k) => String(k ?? '').trim() === t)
  return key !== undefined ? evalMap[key] : undefined
}

function weightedEvalScore100ForEmployee(evalMap, employee, evaluationCriteria) {
  const categories = buildEvalCategoriesForGrade(evaluationCriteria, employee?.grade)
  const scores = evalEntryForEmployeeId(evalMap, employee?.id)?.scores ?? {}
  const weighted = weightedEvalScore100ByCategories(categories, scores)
  return Number.isFinite(weighted) ? weighted : 0
}

function skillProgressScore100ForEmployee(employee, skills, skillProgress) {
  const gradeSkills = (skills ?? []).filter((s) => s.gradeId === employee?.grade)
  if (!gradeSkills.length) return 0
  const prog = skillProgress?.[employee?.id] ?? {}
  const ratioAvg =
    gradeSkills.reduce((sum, s) => {
      const cur = Math.max(0, Number(prog[s.id] ?? 0))
      const max = Math.max(1, Number(s.stages) || 1)
      return sum + Math.min(1, cur / max)
    }, 0) / gradeSkills.length
  return ratioAvg * 100
}

function executiveScore100ForEmployee(employee, executiveEvalByEmployee, evaluationCriteria) {
  const employeeId = String(employee?.id ?? '').trim()
  const gradeId = String(employee?.grade ?? '').trim()
  if (!employeeId) return 0
  const ex = evalEntryForEmployeeId(executiveEvalByEmployee, employeeId)
  if (!ex) return 0
  const scoreMap = ex?.scores && typeof ex.scores === 'object' && !Array.isArray(ex.scores) ? ex.scores : {}
  if (Object.keys(scoreMap).length) {
    const cats = buildEvalCategoriesForGrade(evaluationCriteria, gradeId)
    const weighted = weightedEvalScore100ByCategories(cats, scoreMap)
    if (Number.isFinite(weighted)) return weighted
  }
  const majors = buildMajorOptionsAndWeightsForGrade(evaluationCriteria, gradeId)
  const weightById = Object.fromEntries(majors.map((m) => [m.id, Math.max(0, Number(m.weightPct) || 0)]))
  return quantizeExecutiveScore100(executiveEvalOverallScore100(ex, majors, weightById))
}

function executiveScore100ForState(execState, evaluationCriteria, gradeId) {
  if (!execState) return 0
  const scoreMap =
    execState?.scores && typeof execState.scores === 'object' && !Array.isArray(execState.scores) ? execState.scores : {}
  if (Object.keys(scoreMap).length) {
    const cats = buildEvalCategoriesForGrade(evaluationCriteria, gradeId)
    const weighted = weightedEvalScore100ByCategories(cats, scoreMap)
    if (Number.isFinite(weighted)) return weighted
  }
  const majors = buildMajorOptionsAndWeightsForGrade(evaluationCriteria, gradeId)
  const weightById = Object.fromEntries(majors.map((m) => [m.id, Math.max(0, Number(m.weightPct) || 0)]))
  return quantizeExecutiveScore100(executiveEvalOverallScore100(execState, majors, weightById))
}

function overallWeightedScore100ForEmployee(employee, ctx) {
  if (!employee) return Number.NaN
  const empId = String(employee?.id ?? '').trim()
  if (!empId) return Number.NaN
  const selfEntry = evalEntryForEmployeeId(ctx.selfEvalByEmployee, empId)
  const bossEntry = evalEntryForEmployeeId(ctx.supervisorEvalByEmployee, empId)
  const execEntry = evalEntryForEmployeeId(ctx.executiveEvalByEmployee, empId)
  const hasSelf = Object.keys(selfEntry?.scores ?? {}).length > 0
  const hasBoss = Object.keys(bossEntry?.scores ?? {}).length > 0
  const hasExec =
    Object.keys(execEntry?.scores ?? {}).length > 0 ||
    Object.keys(execEntry?.baseByMajor ?? {}).length > 0 ||
    Number(execEntry?.baseScore) > 0 ||
    (Array.isArray(execEntry?.commentHistory) && execEntry.commentHistory.length > 0)

  const parts = []
  if (hasSelf) parts.push({ score: weightedEvalScore100ForEmployee(ctx.selfEvalByEmployee, employee, ctx.evaluationCriteria), weight: 0.25 })
  if (hasBoss) parts.push({ score: weightedEvalScore100ForEmployee(ctx.supervisorEvalByEmployee, employee, ctx.evaluationCriteria), weight: 0.35 })
  if (hasExec) parts.push({ score: executiveScore100ForEmployee(employee, ctx.executiveEvalByEmployee, ctx.evaluationCriteria), weight: 0.4 })
  if (!parts.length) return Number.NaN

  const weightTotal = parts.reduce((sum, x) => sum + x.weight, 0)
  if (!Number.isFinite(weightTotal) || weightTotal <= 0) return Number.NaN
  return parts.reduce((sum, x) => sum + (x.score * x.weight), 0) / weightTotal
}

function topSelfBossMajorGaps(employee, evaluationCriteria, selfEvalByEmployee, supervisorEvalByEmployee, limit = 2) {
  if (!employee) return []
  const cats = buildEvalCategoriesForGrade(evaluationCriteria, employee.grade)
  if (!Array.isArray(cats) || !cats.length) return []
  const selfScores = evalEntryForEmployeeId(selfEvalByEmployee, employee.id)?.scores ?? {}
  const bossScores = evalEntryForEmployeeId(supervisorEvalByEmployee, employee.id)?.scores ?? {}
  const rows = cats
    .map((cat) => {
      const self100 = weightedEvalScore100ByItems(cat?.items ?? [], selfScores)
      const boss100 = weightedEvalScore100ByItems(cat?.items ?? [], bossScores)
      if (!Number.isFinite(self100) || !Number.isFinite(boss100)) return null
      const gap = Math.abs(self100 - boss100)
      if (!Number.isFinite(gap)) return null
      return {
        title: String(cat?.title ?? '').trim() || '大項目',
        gap,
      }
    })
    .filter(Boolean)
    .sort((a, b) => b.gap - a.gap)
    .slice(0, Math.max(1, limit))
  return rows
}

/** 基本評価（100/80/60/40/20）の段階色と経営層スコアカードを揃える（未設定時は最終スコアから帯を推定） */
function executiveEvalScoreCardToneClass(baseScore, finalScore) {
  const b = Math.max(0, Math.min(100, Number(baseScore) || 0))
  const f = Math.max(0, Math.min(100, Number(finalScore) || 0))
  const fromFinal = () => {
    if (f >= 90) return 'execEvalToneBase100'
    if (f >= 70) return 'execEvalToneBase80'
    if (f >= 50) return 'execEvalToneBase60'
    if (f >= 30) return 'execEvalToneBase40'
    return 'execEvalToneBase20'
  }
  if (b === 100) return 'execEvalToneBase100'
  if (b === 80) return 'execEvalToneBase80'
  if (b === 60) return 'execEvalToneBase60'
  if (b === 40) return 'execEvalToneBase40'
  if (b === 20) return 'execEvalToneBase20'
  if (b > 0) return fromFinal()
  return f > 0 ? fromFinal() : 'execEvalToneNeutral'
}

/** レーダー軸の大項目名：長い場合は2行＋省略（見切れ対策） */
function splitRadarCategoryLabel(title, maxFirstLine) {
  const raw = String(title ?? '').trim()
  if (!raw) return ['']
  const max1 = Math.max(4, Math.min(16, maxFirstLine))
  if (raw.length <= max1) return [raw]
  const breakBefore = (i) => {
    if (i <= 0) return false
    const ch = raw[i - 1]
    return /[ 　・／/\u3000-\u303f]/.test(ch) || ch === '(' || ch === '（' || ch === '['
  }
  let cut = max1
  for (let i = Math.min(max1, raw.length - 1); i >= Math.max(4, Math.floor(max1 * 0.5)); i--) {
    if (breakBefore(i)) {
      cut = i
      break
    }
  }
  const line1 = raw.slice(0, cut).trimEnd()
  let line2 = raw.slice(cut).trimStart()
  const max2 = max1 + 4
  if (line2.length > max2) {
    line2 = `${line2.slice(0, Math.max(1, max2 - 1))}…`
  }
  return line2 ? [line1, line2] : [line1]
}

const MemberEvalRadarChart = memo(function MemberEvalRadarChart({
  series,
  compact = false,
  headlineName = '',
  gradeLabel = '',
  headlineScore = Number.NaN,
  activePeriodKey = '',
  showWeightedFormula = true,
  highlightMajorKey = '',
}) {
  const usableSeries = useMemo(
    () =>
      (Array.isArray(series) ? series : [])
        .filter((s) => Array.isArray(s?.rows) && s.rows.length >= 3)
        .slice(0, 3),
    [series],
  )
  const axisRows = usableSeries[0]?.rows ?? []
  if (!axisRows.length) return null
  const n = axisRows.length
  const size = compact ? 292 : 328
  const center = size / 2
  const radius = compact ? 52 : 72
  const labelRadius = radius + (compact ? 30 : 28)
  const ringLevels = [20, 40, 60, 80, 100]
  const angleAt = (index) => (-Math.PI / 2) + ((Math.PI * 2 * index) / n)
  const toPoint = (index, value100, r = radius) => {
    const angle = angleAt(index)
    const vv = Math.max(0, Math.min(100, Number(value100) || 0))
    const rr = (vv / 100) * r
    return { x: center + Math.cos(angle) * rr, y: center + Math.sin(angle) * rr }
  }
  const labelPoint = (index) => {
    const angle = angleAt(index)
    return { x: center + Math.cos(angle) * labelRadius, y: center + Math.sin(angle) * labelRadius, angle }
  }
  const plottedSeries = useMemo(() => {
    const out = []
    for (let i = 0; i < usableSeries.length; i += 1) {
      const s = usableSeries[i]
      const baseKey = String(s?.periodKey ?? i)
      out.push({
        key: `${baseKey}-total`,
        label: s.label,
        color: s.color ?? '#2563eb',
        dashed: false,
        values: axisRows.map((a) => {
          const row = s.rows.find((r) => r.id === a.id)
          return Number.isFinite(row?.total100) ? row.total100 : Number.NaN
        }),
      })
    }
    return out
  }, [usableSeries, axisRows])
  const axisEnds = axisRows.map((_, idx) => toPoint(idx, 100))
  const defaultOpacityForIndex = (idx) => (idx === 0 ? 0.88 : idx === 1 ? 0.56 : 0.34)
  const [opacityBySeries, setOpacityBySeries] = useState({})
  useEffect(() => {
    setOpacityBySeries((prev) => {
      const next = { ...prev }
      let changed = false
      for (let i = 0; i < plottedSeries.length; i += 1) {
        const key = plottedSeries[i].key
        if (!Object.prototype.hasOwnProperty.call(next, key)) {
          next[key] = defaultOpacityForIndex(i)
          changed = true
        }
      }
      for (const k of Object.keys(next)) {
        if (!plottedSeries.some((s) => s.key === k)) {
          delete next[k]
          changed = true
        }
      }
      return changed ? next : prev
    })
  }, [plottedSeries])
  const latestAvg = useMemo(() => {
    const latest = usableSeries[0]
    if (!latest) return NaN
    const vals = latest.rows.map((r) => Number(r?.total100)).filter((v) => Number.isFinite(v))
    if (!vals.length) return NaN
    return vals.reduce((sum, v) => sum + v, 0) / vals.length
  }, [usableSeries])
  const shownScore = Number.isFinite(headlineScore) ? headlineScore : latestAvg
  const targetSeriesForMajorList = useMemo(() => {
    const activeKey = String(activePeriodKey ?? '').trim()
    if (activeKey) {
      const found = usableSeries.find((s) => String(s?.periodKey ?? '').trim() === activeKey)
      if (found) return found
    }
    return usableSeries[0] ?? null
  }, [usableSeries, activePeriodKey])
  const latestMajorScores = useMemo(() => {
    if (!targetSeriesForMajorList || !Array.isArray(targetSeriesForMajorList.rows)) return []
    return targetSeriesForMajorList.rows
      .map((row) => ({
        id: String(row?.id ?? ''),
        title: String(row?.title ?? '').trim() || '大項目',
        score: Number(row?.total100),
      }))
      .filter((row) => Number.isFinite(row.score))
  }, [targetSeriesForMajorList])
  const latestPeriodKey = String(usableSeries[0]?.periodKey ?? '').trim()
  const shownActivePeriodKey = String(activePeriodKey ?? '').trim()
  const highlightedMajorKey = String(highlightMajorKey ?? '').trim()
  const modeTitle = '総合得点（一覧式）3期レーダー'
  const wrapperClass = `memberEvalRadar${compact ? ' isCompact' : ''}`
  return (
    <section className={wrapperClass}>
      {compact ? (
        <div className="memberEvalRadarHead">
          {String(headlineName ?? '').trim() ? <p className="memberEvalRadarMemberName">{String(headlineName).trim()}</p> : null}
          <h4>{modeTitle}</h4>
          <p>
            {Number.isFinite(shownScore) ? `${shownScore.toFixed(1)}点` : '—'}
            {String(gradeLabel ?? '').trim() ? ` / 等級 ${String(gradeLabel).trim()}` : ''}
          </p>
          {(shownActivePeriodKey || latestPeriodKey) ? (
            <small className="memberEvalRadarPeriodMeta">
              {shownActivePeriodKey ? `表示期: ${shownActivePeriodKey}` : ''}
              {shownActivePeriodKey && latestPeriodKey ? ' / ' : ''}
              {latestPeriodKey ? `3期比較の最新: ${latestPeriodKey}` : ''}
            </small>
          ) : null}
          {showWeightedFormula ? (
            <small className="memberEvalRadarFormula">式: 自己25% + 上司35% + 経営40%</small>
          ) : null}
        </div>
      ) : (
        <div className="memberEvalRadarHead">
          <h4>{modeTitle}</h4>
          <p>一覧式の総合得点: {Number.isFinite(shownScore) ? `${shownScore.toFixed(1)}点` : '—'}</p>
          {(shownActivePeriodKey || latestPeriodKey) ? (
            <small className="memberEvalRadarPeriodMeta">
              {shownActivePeriodKey ? `表示期: ${shownActivePeriodKey}` : ''}
              {shownActivePeriodKey && latestPeriodKey ? ' / ' : ''}
              {latestPeriodKey ? `3期比較の最新: ${latestPeriodKey}` : ''}
            </small>
          ) : null}
          {showWeightedFormula ? (
            <small className="memberEvalRadarFormula">式: 自己25% + 上司35% + 経営40%</small>
          ) : null}
        </div>
      )}
      <div className="memberEvalRadarBody">
        <svg viewBox={`0 0 ${size} ${size}`} role="img" aria-label="3期レーダーチャート">
          {ringLevels.map((lv) => (
            <circle key={lv} cx={center} cy={center} r={(lv / 100) * radius} className="memberEvalRadarRing" />
          ))}
          {axisEnds.map((pt, idx) => (
            <line
              key={`axis-${axisRows[idx].id}`}
              x1={center}
              y1={center}
              x2={pt.x}
              y2={pt.y}
              className={`memberEvalRadarAxis${
                highlightedMajorKey && String(axisRows[idx].id ?? '').trim() === highlightedMajorKey ? ' isFocus' : ''
              }`}
            />
          ))}
          {plottedSeries.map((s, sIdx) => {
            const opacity = Math.max(0.1, Math.min(1, Number(opacityBySeries[s.key] ?? defaultOpacityForIndex(sIdx)) || defaultOpacityForIndex(sIdx)))
            const points = s.values.map((v, idx) => {
              const p = toPoint(idx, v)
              return `${p.x},${p.y}`
            })
            return (
              <polygon
                key={`poly-${s.key}`}
                points={points.join(' ')}
                className="memberEvalRadarPolyPeriod"
                style={{
                  '--radar-series-color': s.color,
                  '--radar-series-opacity': opacity,
                  '--radar-series-dash': s.dashed ? '6 4' : 'none',
                }}
              />
            )
          })}
          {axisRows.map((row, idx) => {
            const { x, y, angle } = labelPoint(idx)
            const c = Math.cos(angle)
            let textAnchor = 'middle'
            if (c > 0.25) textAnchor = 'start'
            else if (c < -0.25) textAnchor = 'end'
            const s = Math.sin(angle)
            const singleDy = s > 0.35 ? '0.42em' : s < -0.35 ? '-0.12em' : '0.28em'
            const lines = splitRadarCategoryLabel(row.title, compact ? 8 : 11)
            const lineGap = compact ? '0.95em' : '1.08em'
            const twoLineFirstDy = s > 0.35 ? '-0.18em' : s < -0.35 ? '-0.72em' : s > 0 ? '0.05em' : '-0.42em'
            return (
              <text
                key={`label-${row.id}`}
                x={x}
                y={y}
                textAnchor={textAnchor}
                className={`memberEvalRadarLabel${compact ? ' isCompact' : ''}${
                  highlightedMajorKey && String(row.id ?? '').trim() === highlightedMajorKey ? ' isFocus' : ''
                }`}
              >
                <title>{row.title}</title>
                <tspan x={x} dy={lines.length < 2 ? singleDy : twoLineFirstDy}>{lines[0]}</tspan>
                {lines[1] ? <tspan x={x} dy={lineGap}>{lines[1]}</tspan> : null}
              </text>
            )
          })}
        </svg>
        <div className="memberEvalRadarLegend memberEvalRadarLegend--period">
          {plottedSeries.map((s, sIdx) => {
            const value = Math.round((Number(opacityBySeries[s.key] ?? defaultOpacityForIndex(sIdx)) || defaultOpacityForIndex(sIdx)) * 100)
            return (
              <label key={`legend-${s.key}`} className="memberEvalRadarLegendRow">
                <span
                  className={`memberEvalRadarLegendSwatch ${s.dashed ? 'isBoss' : 'isSelf'}`}
                  style={{ '--radar-series-color': s.color }}
                >
                  {s.label}
                </span>
                <input
                  type="range"
                  min="15"
                  max="100"
                  step="1"
                  value={value}
                  onChange={(event) => {
                    const n = Math.max(15, Math.min(100, Number(event.target.value) || 15))
                    setOpacityBySeries((prev) => ({ ...prev, [s.key]: n / 100 }))
                  }}
                  aria-label={`${s.label}の透明度`}
                />
              </label>
            )
          })}
        </div>
        {latestMajorScores.length ? (
          <ul className="memberEvalRadarMajorList" aria-label="大項目スコア">
            {latestMajorScores.map((row) => (
              <li
                key={row.id || row.title}
                className={`memberEvalRadarMajorItem${
                  highlightedMajorKey && row.id === highlightedMajorKey ? ' isFocus' : ''
                }`}
              >
                <span className="memberEvalRadarMajorTitle">{row.title}</span>
                <strong className="memberEvalRadarMajorScore">{row.score.toFixed(1)}点</strong>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </section>
  )
})

function EvalQuestionnairePage({
  variant,
  employees,
  evalState,
  setEvalState,
  peerSelfEval,
  peerSupervisorEval,
  evaluationCriteria,
  activeEvalPeriodKey,
  setActiveEvalPeriodKey,
  selfEvalHistoryByEmployee,
  evalHistoryByEmployee,
  evalPeriodSelectOptions,
  evalPeriodFallbackKey,
  isSubmittedForPeriod = false,
  onSubmitEvaluation,
  canEvaluate = true,
  blockedReason = '',
  focusMajorKey = '',
  isPeriodSwitching = false,
  submissionWithdrawalsUsed = 0,
  onWithdrawSubmission,
  withdrawBlockedByDeadline = false,
}) {
  const isBoss = variant === 'boss'
  const isExec = variant === 'exec'
  const evalTitle = isExec ? '2次評価(経営層)' : isBoss ? '1次評価(上司)' : '自己評価'
  const employee = useMemo(() => (employees.length ? employees[0] : null), [employees])

  const scores = evalState?.scores ?? {}
  const comments = evalState?.comments ?? {}
  const peerScores = peerSelfEval?.scores ?? {}
  const peerBossScores = peerSupervisorEval?.scores ?? {}

  const patchScore = (itemId, value) => {
    if (!canEvaluate) return
    setEvalState((prev) => {
      const currentValue = String(prev?.scores?.[itemId] ?? '')
      if (currentValue === String(value ?? '')) return prev
      return {
        scores: { ...(prev.scores ?? {}), [itemId]: value },
        comments: { ...(prev.comments ?? {}) },
      }
    })
  }

  const patchComment = (itemId, value) => {
    if (!canEvaluate) return
    setEvalState((prev) => ({
      scores: { ...(prev.scores ?? {}) },
      comments: { ...(prev.comments ?? {}), [itemId]: value },
    }))
  }

  const viewingEvalGrade = useMemo(() => {
    const empId = String(employee?.id ?? '').trim()
    const activeKey = String(activeEvalPeriodKey ?? evalPeriodFallbackKey ?? '').trim()
    if (!empId || !activeKey) return String(employee?.grade ?? '').trim()
    const slot = evalHistoryByEmployee?.[empId]?.[activeKey]
    const stored = String(slot?.evalGrade ?? '').trim()
    const isSubmitted = Boolean(String(slot?.submittedAt ?? '').trim())
    return isSubmitted ? (stored || String(employee?.grade ?? '').trim()) : String(employee?.grade ?? '').trim()
  }, [employee?.id, employee?.grade, evalHistoryByEmployee, activeEvalPeriodKey, evalPeriodFallbackKey])

  const resolvedEvalGradeForItems = useMemo(() => {
    const byGrade =
      evaluationCriteria?.byGrade &&
      typeof evaluationCriteria.byGrade === 'object' &&
      !Array.isArray(evaluationCriteria.byGrade)
        ? evaluationCriteria.byGrade
        : {}
    const available = Object.keys(byGrade).filter((k) => Array.isArray(byGrade[k]))
    const preferred = String(viewingEvalGrade ?? '').trim()
    if (preferred && available.includes(preferred)) return preferred
    const current = String(employee?.grade ?? '').trim()
    if (current && available.includes(current)) return current
    return available[0] ?? preferred ?? current
  }, [evaluationCriteria, viewingEvalGrade, employee?.grade])

  const categories = useMemo(
    () => buildEvalCategoriesForGrade(evaluationCriteria, resolvedEvalGradeForItems),
    [evaluationCriteria, resolvedEvalGradeForItems],
  )
  const allItems = useMemo(() => categories.flatMap((c) => c.items), [categories])
  const totalCount = allItems.length

  const superGroupedCategories = useMemo(() => {
    const blocks = []
    for (const cat of categories) {
      const key = cat.superGroup === 'interpersonal' ? 'interpersonal' : 'business'
      const tail = blocks[blocks.length - 1]
      if (tail && tail.key === key) tail.cats.push(cat)
      else blocks.push({ key, cats: [cat] })
    }
    return blocks
  }, [categories])

  const [openCats, setOpenCats] = useState(() =>
    Object.fromEntries(categories.map((c) => [c.id, true])),
  )
  useEffect(() => {
    setOpenCats((prev) => {
      const next = {}
      categories.forEach((cat) => {
        next[cat.id] = Object.prototype.hasOwnProperty.call(prev, cat.id) ? prev[cat.id] : true
      })
      return next
    })
  }, [categories])
  const [detailItem, setDetailItem] = useState(null)
  const [selfEvalHistoryDetail, setSelfEvalHistoryDetail] = useState(null)
  const [selfEvalRecordAccordionOpen, setSelfEvalRecordAccordionOpen] = useState(false)

  const evaluatedCount = useMemo(
    () => allItems.filter((it) => String(scores[it.id] ?? '').trim() !== '').length,
    [allItems, scores],
  )

  const categoryDoneCount = (cat) =>
    cat.items.filter((it) => String(scores[it.id] ?? '').trim() !== '').length

  const allComplete = evaluatedCount >= totalCount
  const bulkCopySourceLabel = isExec ? '1次評価(上司)' : isBoss ? '自己評価' : ''
  const bulkCopyTargetLabel = isExec ? '2次評価(経営層)' : isBoss ? '1次評価(上司)' : ''
  const bulkCopyFromCurrentPeriod = useCallback(() => {
    if (!canEvaluate || isSubmittedForPeriod) return
    if (!isBoss && !isExec) return
    const sourceScores = isExec ? peerBossScores : peerScores
    const nextScores = {}
    for (const it of allItems) {
      const v = String(sourceScores?.[it.id] ?? '').trim()
      if (!v) continue
      nextScores[it.id] = v
    }
    if (!Object.keys(nextScores).length) {
      window.alert(`この評価期でコピー可能な${bulkCopySourceLabel}の点数がありません。`)
      return
    }
    const confirmed = window.confirm(
      `選択中の評価期の${bulkCopySourceLabel}を、${bulkCopyTargetLabel}へ一括コピーしますか？`,
    )
    if (!confirmed) return
    setEvalState((prev) => ({
      scores: {
        ...(prev?.scores ?? {}),
        ...nextScores,
      },
      comments: { ...(prev?.comments ?? {}) },
    }))
  }, [
    canEvaluate,
    isSubmittedForPeriod,
    isBoss,
    isExec,
    peerBossScores,
    peerScores,
    allItems,
    bulkCopySourceLabel,
    bulkCopyTargetLabel,
    setEvalState,
  ])

  const selfEvalPersonalHistoryRows = useMemo(() => {
    if (isBoss || !employee?.id || !selfEvalHistoryByEmployee) return []
    const empId = employee.id
    const activeKey = activeEvalPeriodKey ?? evalPeriodFallbackKey
    const histKeys = Object.keys(selfEvalHistoryByEmployee[empId] ?? {})
    const periodKeys = [...new Set([...histKeys, activeKey])].sort(compareEvalPeriodDesc)
    const mergedStateForPeriod = (periodKey) => {
      const fromHist = selfEvalHistoryByEmployee[empId]?.[periodKey]
      if (periodKey === activeKey && evalState) {
        return {
          scores: { ...(fromHist?.scores ?? {}), ...(evalState.scores ?? {}) },
          comments: { ...(fromHist?.comments ?? {}), ...(evalState.comments ?? {}) },
        }
      }
      return {
        scores: { ...(fromHist?.scores ?? {}) },
        comments: { ...(fromHist?.comments ?? {}) },
      }
    }
    const gradeForCategories = (periodKey, fromHist) => {
      const stored = String(fromHist?.evalGrade ?? '').trim()
      if (stored) return stored
      if (periodKey === activeKey) return String(employee?.grade ?? '').trim()
      return ''
    }
    const rawRows = periodKeys.map((periodKey) => {
      const fromHist = selfEvalHistoryByEmployee[empId]?.[periodKey]
      const merged = mergedStateForPeriod(periodKey)
      const gradeCat = gradeForCategories(periodKey, fromHist)
      const storedGrade = String(fromHist?.evalGrade ?? '').trim()
      const evalGradeLabel =
        storedGrade || (periodKey === activeKey ? String(employee?.grade ?? '').trim() || '—' : '—')
      const cats = buildEvalCategoriesForGrade(evaluationCriteria, gradeCat)
      const self100 = weightedEvalScore100ByCategories(cats, merged?.scores ?? {})
      const sg = selfEvalSuperGroupStats100(evaluationCriteria, gradeCat, merged)
      const business100 = sg.business100
      const inter100 = sg.interpersonal100
      return {
        periodKey,
        evalGradeLabel,
        self100,
        business100,
        inter100,
        selfLabel: self100 == null ? '—' : `${self100.toFixed(1)}点`,
        businessLabel: business100 == null ? '—' : `${business100.toFixed(1)}点`,
        interLabel: inter100 == null ? '—' : `${inter100.toFixed(1)}点`,
      }
    })
    return rawRows.map((row, i) => {
      const prev = rawRows[i + 1]
      return {
        ...row,
        selfDelta: prev ? selfEvalHistoryDeltaLabel(row.self100, prev.self100) : '—',
        businessDelta: prev ? selfEvalHistoryDeltaLabel(row.business100, prev.business100) : '—',
        interDelta: prev ? selfEvalHistoryDeltaLabel(row.inter100, prev.inter100) : '—',
      }
    })
  }, [
    isBoss,
    employee?.id,
    employee?.grade,
    selfEvalHistoryByEmployee,
    evaluationCriteria,
    activeEvalPeriodKey,
    evalPeriodFallbackKey,
    evalState,
  ])

  const openSelfEvalHistoryDetail = useCallback(
    (periodKey) => {
      if (!employee?.id || !selfEvalHistoryByEmployee) return
      const empId = employee.id
      const activeKey = activeEvalPeriodKey ?? evalPeriodFallbackKey
      const fromHist = selfEvalHistoryByEmployee[empId]?.[periodKey]
      const scores =
        periodKey === activeKey && evalState
          ? { ...(fromHist?.scores ?? {}), ...(evalState.scores ?? {}) }
          : { ...(fromHist?.scores ?? {}) }
      const comments =
        periodKey === activeKey && evalState
          ? { ...(fromHist?.comments ?? {}), ...(evalState.comments ?? {}) }
          : { ...(fromHist?.comments ?? {}) }
      const stored = String(fromHist?.evalGrade ?? '').trim()
      const evalGradeLabel =
        stored || (periodKey === activeKey ? String(employee?.grade ?? '').trim() || '—' : '—')
      const gradeForItems = stored || (periodKey === activeKey ? String(employee?.grade ?? '').trim() : '')
      setSelfEvalHistoryDetail({
        periodKey,
        scores,
        comments,
        gradeForItems,
        evalGradeLabel,
        savedAt: typeof fromHist?.savedAt === 'string' ? fromHist.savedAt.trim() : '',
        hadStoredGrade: !!stored,
      })
    },
    [employee, selfEvalHistoryByEmployee, activeEvalPeriodKey, evalPeriodFallbackKey, evalState],
  )

  const selfEvalPersonalHistorySummary = useMemo(() => {
    const rows = selfEvalPersonalHistoryRows
    if (rows.length < 1) return null
    const latest = rows[0]
    const prev = rows[1]
    const trend = (delta) => {
      const s = String(delta ?? '')
      if (s === '—' || !s.trim()) return '—'
      if (s.startsWith('±')) return '横ばい'
      const n = Number(s.replace('+', ''))
      if (!Number.isFinite(n)) return '—'
      if (Math.abs(n) < 0.05) return '横ばい'
      return n > 0 ? '上昇' : '低下'
    }
    return {
      latestPeriod: latest.periodKey,
      previousPeriod: prev?.periodKey ?? null,
      trend: trend(latest.selfDelta),
    }
  }, [selfEvalPersonalHistoryRows])
  const selfResubmitRequestNote = useMemo(() => {
    if (isBoss || isExec || !employee?.id) return ''
    const activeKey = String(activeEvalPeriodKey ?? evalPeriodFallbackKey ?? '').trim()
    if (!activeKey) return ''
    const slot = evalHistoryByEmployee?.[employee.id]?.[activeKey]
    const reason = String(slot?.resubmitReason ?? '').trim()
    const requestedAt = String(slot?.resubmitRequestedAt ?? '').trim()
    if (!reason && !requestedAt) return ''
    const atText = requestedAt ? `（依頼: ${new Date(requestedAt).toLocaleString('ja-JP')}）` : ''
    return `${reason || '1次評価との乖離が大きいため、自己評価の再提出が必要です。'}${atText}`
  }, [isBoss, isExec, employee?.id, evalHistoryByEmployee, activeEvalPeriodKey, evalPeriodFallbackKey])

  const pageToneClass = isExec ? ' secondEvalPage' : isBoss ? ' bossEvalPage' : ''

  if (!employee) {
    return (
      <section className={`selfEvalPage${pageToneClass}`}>
        <p className="skillUpEmpty">従業員が登録されていません。従業員管理から登録してください。</p>
      </section>
    )
  }

  const guideLinesSelf = [
    '各項目について、1～5点で自己評価してください',
    '点数の基準は「詳細を表示」ボタンで確認できます',
  ]

  const guideLinesBoss = [
    '各項目について、1～5点で評価してください',
    '被評価者の自己評価点数は各項目に参考として表示されます（自己評価タブで入力）',
    '評価の根拠やコメントを入力してください',
  ]

  const guideLines = isExec ? guideLinesBoss : isBoss ? guideLinesBoss : guideLinesSelf

  return (
    <section className={`selfEvalPage${pageToneClass}${!canEvaluate ? ' isBlockedByFlow' : ''}`}>
      <header className="selfEvalHeader">
        <h2>{evalTitle}</h2>
        <p className="selfEvalTarget">
          {isBoss || isExec ? '評価対象' : '対象者'}: {employee.name}（{employee.dept}）
        </p>
        <label className="selfEvalPeriodField">
          評価期
          <span className="selfEvalPeriodFieldControl">
            <select
              value={activeEvalPeriodKey ?? evalPeriodFallbackKey ?? ''}
              onChange={(event) => setActiveEvalPeriodKey?.(event.target.value)}
            >
              {(evalPeriodSelectOptions ?? []).map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
            {isPeriodSwitching ? <span className="evalPeriodSwitchSpinner" aria-label="評価期切替中" /> : null}
          </span>
        </label>
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
      {!canEvaluate ? (
        <p className="selfEvalFlowLockNotice" role="status" aria-live="polite">
          {blockedReason || '前段の提出が完了するまで評価できません。'}
        </p>
      ) : null}

      <div className="selfEvalSummaryCard">
        <div>
          {isBoss ? <p className="bossEvalProgressLabel">評価進捗</p> : null}
          <p className="selfEvalSummaryRatio">
            {evaluatedCount} / {totalCount} 項目
          </p>
          <p className={`selfEvalSummaryHint ${isSubmittedForPeriod ? 'isDone' : ''}`}>
            {isSubmittedForPeriod ? '提出済み' : '未提出'}
          </p>
          <p className={`selfEvalSummaryHint ${allComplete ? 'isDone' : ''}`}>
            {allComplete ? 'すべての項目の評価が完了しています' : 'すべての項目を評価してください'}
          </p>
        </div>
      </div>
      {selfResubmitRequestNote ? (
        <p className="selfEvalFlowLockNotice" role="status" aria-live="polite">
          再提出依頼: {selfResubmitRequestNote}
        </p>
      ) : null}

      {typeof onSubmitEvaluation === 'function' && (isBoss || isExec) ? (
        <div className="selfEvalSubmitBar">
          <button
            type="button"
            className="selfEvalSubmitBtn"
            onClick={bulkCopyFromCurrentPeriod}
            disabled={isSubmittedForPeriod || !canEvaluate}
          >
            {bulkCopySourceLabel}をこの期に一括コピー
          </button>
        </div>
      ) : null}

      <div className="selfEvalCategories">
        {superGroupedCategories.map((block) => {
          const meta = SELF_EVAL_SUPER_GROUP[block.key]
          return (
            <div key={block.key} className={`selfEvalSuperGroup selfEvalSuperGroup--${block.key}`}>
              <div className="selfEvalSuperGroupLabel">
                <span className="selfEvalSuperGroupTitle">{meta.label}</span>
                <span className="selfEvalSuperGroupDesc">{meta.description}</span>
              </div>
              <div className="selfEvalSuperGroupInner">
                {block.cats.map((cat) => {
          const done = categoryDoneCount(cat)
          const open = !!openCats[cat.id]
          return (
                    <section
                      key={cat.id}
                      className={`selfEvalCategory selfEvalCategory--${block.key}${
                        String(focusMajorKey ?? '').trim() === String(cat.id ?? '').trim() ? ' isFocusMajor' : ''
                      }`}
                    >
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
                                {isExec ? (
                                  <>
                                    <p className="bossEvalSelfNote">
                                      自己評価の点数: {selfPts ? `${selfPts}点` : '（未入力）'}
                                    </p>
                                    <p className="bossEvalSelfNote">
                                      1次評価(上司)の点数:{' '}
                                      {String(peerBossScores[it.id] ?? '').trim()
                                        ? `${String(peerBossScores[it.id]).trim()}点`
                                        : '（未入力）'}
                                    </p>
                                  </>
                                ) : null}
                                <div className={`selfEvalItemGrid${isBoss ? '' : ' isSingleField'}`}>
                          <label className="selfEvalFieldLabel">
                                    <span className="selfEvalFieldHead">
                                      <span>{isExec ? '2次評価(経営層)の点数' : isBoss ? '1次評価(上司)の点数' : '評価点数'}</span>
                                      <button
                                        type="button"
                                        className="selfEvalDetailLink"
                                        onClick={() => setDetailItem((prev) => (prev?.id === it.id ? null : it))}
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
                                        const isSelfMarked = (isBoss || isExec) && String(peerScores[it.id] ?? '') === value
                                        const isBossMarked = isExec && String(peerBossScores[it.id] ?? '') === value
                                        return (
                                          <button
                                            key={n}
                                            type="button"
                                            className={`selfEvalScorePill${selected ? ' isActive' : ''}${
                                              isSelfMarked ? ' isPeerSelfMarked' : ''
                                            }${isBossMarked ? ' isPeerBossMarked' : ''}`}
                                            disabled={isSubmittedForPeriod || !canEvaluate}
                                            onClick={() => patchScore(it.id, value)}
                                            aria-pressed={selected}
                                          >
                                            {n}
                                            {isSelfMarked ? <span className="selfEvalPeerMark selfEvalPeerMark--self">自己</span> : null}
                                            {isBossMarked ? <span className="selfEvalPeerMark selfEvalPeerMark--boss">1次</span> : null}
                                          </button>
                                        )
                                      })}
                                    </div>
                                    {detailItem?.id === it.id ? (
                                      <div className="selfEvalDetailBody selfEvalDetailBody--inline">
                                        <h4>点数の目安（1～5点）</h4>
                                        <pre className="selfEvalDetailCriteria">{it.criteria}</pre>
                                      </div>
                                    ) : null}
                          </label>
                                  {isBoss || isExec ? (
                          <label className="selfEvalFieldLabel">
                                      <span>コメント（評価の根拠など）</span>
                            <input
                              type="text"
                              value={comments[it.id] ?? ''}
                                        disabled={isSubmittedForPeriod || !canEvaluate}
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
            </div>
          )
        })}
      </div>

      {typeof onSubmitEvaluation === 'function' ? (
        <div className="selfEvalSubmitBar">
          <button
            type="button"
            className={`selfEvalSubmitBtn${isSubmittedForPeriod ? ' isLocked' : ''}`}
            onClick={() => onSubmitEvaluation?.()}
            disabled={isSubmittedForPeriod || !allComplete || !canEvaluate}
          >
            {isExec ? '2次評価(経営層)を提出' : isBoss ? '1次評価(上司)を提出' : '自己評価を提出'}
          </button>
          <p className="selfEvalSubmitHint">
            {!canEvaluate
              ? blockedReason || '前段の提出が完了するまで評価できません。'
              : isSubmittedForPeriod
                ? `提出済みです。この評価期は閲覧のみです。`
                : allComplete
                  ? '提出すると、この評価期は閲覧のみになり編集できません。'
                  : '全項目の評価を完了すると提出できます。'}
          </p>
          {typeof onWithdrawSubmission === 'function' && !isExec && isSubmittedForPeriod && !withdrawBlockedByDeadline && submissionWithdrawalsUsed < MAX_EVAL_SUBMISSION_WITHDRAWALS ? (
            <>
              <button type="button" className="selfEvalWithdrawBtn" onClick={() => onWithdrawSubmission?.()}>
                提出を取り消す（あと{MAX_EVAL_SUBMISSION_WITHDRAWALS - submissionWithdrawalsUsed}回）
              </button>
              <p className="selfEvalSubmitHint selfEvalWithdrawHint">
                入力ミスなどに備え、提出の取り消しはこの評価期で最大{MAX_EVAL_SUBMISSION_WITHDRAWALS}回まで行えます。
              </p>
            </>
          ) : null}
          {typeof onWithdrawSubmission === 'function' && !isExec && isSubmittedForPeriod && submissionWithdrawalsUsed >= MAX_EVAL_SUBMISSION_WITHDRAWALS ? (
            <p className="selfEvalSubmitHint">この評価期での提出取り消しは上限（{MAX_EVAL_SUBMISSION_WITHDRAWALS}回）に達しています。</p>
          ) : null}
          {typeof onWithdrawSubmission === 'function' && !isExec && isSubmittedForPeriod && withdrawBlockedByDeadline ? (
            <p className="selfEvalSubmitHint">締切後のため提出の取り消しはできません。</p>
          ) : null}
        </div>
      ) : null}

      {selfEvalHistoryDetail ? (
        <div className="employeeModalOverlay" onClick={() => setSelfEvalHistoryDetail(null)}>
          <div
            className="employeeModal selfEvalHistorySnapshotModal"
            onClick={(event) => event.stopPropagation()}
          >
            <button type="button" className="modalClose" onClick={() => setSelfEvalHistoryDetail(null)}>
              ×
            </button>
            <h3>{selfEvalHistoryDetail.periodKey} の自己評価</h3>
            <p className="selfEvalHistorySnapshotLead">
              <span className="selfEvalHistorySnapshotBadge">閲覧のみ</span>
              等級（記録）: <strong>{selfEvalHistoryDetail.evalGradeLabel}</strong>
              {selfEvalHistoryDetail.savedAt ? (
                <>
                  {' '}
                  · 最終保存:{' '}
                  {(() => {
                    const d = new Date(selfEvalHistoryDetail.savedAt)
                    if (Number.isNaN(d.getTime())) return selfEvalHistoryDetail.savedAt
                    return d.toLocaleString('ja-JP')
                  })()}
                </>
              ) : null}
            </p>
            {!selfEvalHistoryDetail.hadStoredGrade &&
            selfEvalHistoryDetail.periodKey !== (activeEvalPeriodKey ?? evalPeriodFallbackKey) ? (
              <p className="selfEvalHistorySnapshotNote">
                この期の等級がデータに含まれていません。下の項目一覧はデフォルトの構成で表示しています。点数は保存された項目IDに紐づけて表示します。
              </p>
            ) : null}
            <div className="selfEvalHistorySnapshotBody">
              {(() => {
                const cats = buildEvalCategoriesForGrade(
                  evaluationCriteria,
                  selfEvalHistoryDetail.gradeForItems,
                )
                const known = new Set(cats.flatMap((c) => c.items.map((it) => it.id)))
                const scores = selfEvalHistoryDetail.scores ?? {}
                const comments = selfEvalHistoryDetail.comments ?? {}
                const orphanIds = Object.keys(scores).filter((id) => !known.has(id))
                return (
                  <>
                    {cats.map((cat) => (
                      <section key={cat.id} className="selfEvalHistorySnapshotCategory">
                        <h4 className="selfEvalHistorySnapshotCategoryTitle">{cat.title}</h4>
                        <ul className="selfEvalHistorySnapshotItemList">
                          {cat.items.map((it) => {
                            const v = String(scores[it.id] ?? '').trim()
                            const cm = String(comments[it.id] ?? '').trim()
                            return (
                              <li key={it.id} className="selfEvalHistorySnapshotItem">
                                <span className="selfEvalHistorySnapshotItemTitle">{it.title}</span>
                                <span className="selfEvalHistorySnapshotItemScore">{v ? `${v}点` : '—'}</span>
                                {cm ? (
                                  <span className="selfEvalHistorySnapshotItemComment">{cm}</span>
                                ) : null}
                              </li>
                            )
                          })}
                        </ul>
                      </section>
                    ))}
                    {orphanIds.length ? (
                      <section className="selfEvalHistorySnapshotCategory selfEvalHistorySnapshotCategory--orphan">
                        <h4 className="selfEvalHistorySnapshotCategoryTitle">その他の保存項目（項目マスタ外のID）</h4>
                        <p className="selfEvalHistorySnapshotOrphanNote">
                          等級変更などで項目が入れ替わった場合でも、当時保存された点数はここに残ります。
                        </p>
                        <ul className="selfEvalHistorySnapshotItemList">
                          {orphanIds
                            .filter((id) => {
                              const v = String(scores[id] ?? '').trim()
                              const cm = String(comments[id] ?? '').trim()
                              return !!(v || cm)
                            })
                            .map((id) => {
                              const v = String(scores[id] ?? '').trim()
                              const cm = String(comments[id] ?? '').trim()
                              return (
                                <li key={id} className="selfEvalHistorySnapshotItem">
                                  <span className="selfEvalHistorySnapshotItemTitle">
                                    <code>{id}</code>
                                  </span>
                                  <span className="selfEvalHistorySnapshotItemScore">{v ? `${v}点` : '—'}</span>
                                  {cm ? (
                                    <span className="selfEvalHistorySnapshotItemComment">{cm}</span>
                                  ) : null}
                                </li>
                              )
                            })}
                        </ul>
                      </section>
                    ) : null}
                  </>
                )
              })()}
            </div>
          </div>
        </div>
      ) : null}
    </section>
  )
}

function SelfEvaluationPage({
  employees,
  evalState,
  setEvalState,
  evaluationCriteria,
  activeEvalPeriodKey,
  setActiveEvalPeriodKey,
  selfEvalHistoryByEmployee,
  evalPeriodSelectOptions,
  evalPeriodFallbackKey,
  isSubmittedForPeriod,
  onSubmitEvaluation,
  focusMajorKey = '',
  isPeriodSwitching = false,
}) {
  return (
    <EvalQuestionnairePage
      variant="self"
      employees={employees}
      evalState={evalState}
      setEvalState={setEvalState}
      evaluationCriteria={evaluationCriteria}
      activeEvalPeriodKey={activeEvalPeriodKey}
      setActiveEvalPeriodKey={setActiveEvalPeriodKey}
      selfEvalHistoryByEmployee={selfEvalHistoryByEmployee}
      evalHistoryByEmployee={selfEvalHistoryByEmployee}
      evalPeriodSelectOptions={evalPeriodSelectOptions}
      evalPeriodFallbackKey={evalPeriodFallbackKey}
      isSubmittedForPeriod={isSubmittedForPeriod}
      onSubmitEvaluation={onSubmitEvaluation}
      focusMajorKey={focusMajorKey}
      isPeriodSwitching={isPeriodSwitching}
    />
  )
}

function SupervisorEvaluationPage({
  employees,
  evalState,
  setEvalState,
  peerSelfEval,
  evaluationCriteria,
  activeEvalPeriodKey,
  setActiveEvalPeriodKey,
  evalPeriodSelectOptions,
  evalPeriodFallbackKey,
  supervisorEvalHistoryByEmployee,
  isSubmittedForPeriod,
  onSubmitEvaluation,
  submissionWithdrawalsUsed = 0,
  onWithdrawSubmission,
  withdrawBlockedByDeadline = false,
  canEvaluate,
  blockedReason,
  focusMajorKey = '',
  isPeriodSwitching = false,
}) {
  return (
    <EvalQuestionnairePage
      variant="boss"
      employees={employees}
      evalState={evalState}
      setEvalState={setEvalState}
      peerSelfEval={peerSelfEval}
      evaluationCriteria={evaluationCriteria}
      activeEvalPeriodKey={activeEvalPeriodKey}
      setActiveEvalPeriodKey={setActiveEvalPeriodKey}
      evalHistoryByEmployee={supervisorEvalHistoryByEmployee}
      evalPeriodSelectOptions={evalPeriodSelectOptions}
      evalPeriodFallbackKey={evalPeriodFallbackKey}
      isSubmittedForPeriod={isSubmittedForPeriod}
      onSubmitEvaluation={onSubmitEvaluation}
      submissionWithdrawalsUsed={submissionWithdrawalsUsed}
      onWithdrawSubmission={onWithdrawSubmission}
      withdrawBlockedByDeadline={withdrawBlockedByDeadline}
      canEvaluate={canEvaluate}
      blockedReason={blockedReason}
      focusMajorKey={focusMajorKey}
      isPeriodSwitching={isPeriodSwitching}
    />
  )
}

function ExecutiveEvaluationPage({
  employee,
  evalState,
  setEvalState,
  evaluationCriteria,
  activeEvalPeriodKey,
  setActiveEvalPeriodKey,
  evalPeriodSelectOptions,
  evalPeriodFallbackKey,
  executiveEvalHistoryByEmployee,
  isSubmittedForPeriod,
  onSubmitEvaluation,
  peerSelfEval,
  peerSupervisorEval,
  canEvaluate,
  blockedReason,
  focusMajorKey = '',
  isPeriodSwitching = false,
}) {
  const normalizedEvalState = {
    scores: evalState?.scores ?? {},
    comments: evalState?.comments ?? {},
  }
    return (
    <EvalQuestionnairePage
      variant="exec"
      employees={employee ? [employee] : []}
      evalState={normalizedEvalState}
      setEvalState={(updater) => {
        setEvalState((prev) => {
          const current = {
            scores: prev?.scores ?? {},
            comments: prev?.comments ?? {},
          }
          const next = typeof updater === 'function' ? updater(current) : updater
          return {
            ...(prev ?? {}),
            scores: { ...(next?.scores ?? {}) },
            comments: { ...(next?.comments ?? {}) },
          }
        })
      }}
      peerSelfEval={peerSelfEval}
      peerSupervisorEval={peerSupervisorEval}
      evaluationCriteria={evaluationCriteria}
      activeEvalPeriodKey={activeEvalPeriodKey}
      setActiveEvalPeriodKey={setActiveEvalPeriodKey}
      selfEvalHistoryByEmployee={null}
      evalHistoryByEmployee={executiveEvalHistoryByEmployee}
      evalPeriodSelectOptions={evalPeriodSelectOptions}
      evalPeriodFallbackKey={evalPeriodFallbackKey}
      isSubmittedForPeriod={Boolean(isSubmittedForPeriod)}
      onSubmitEvaluation={onSubmitEvaluation}
      canEvaluate={canEvaluate}
      blockedReason={blockedReason}
      focusMajorKey={focusMajorKey}
      isPeriodSwitching={isPeriodSwitching}
    />
  )
}

function GoalManagementPage({
  employee,
  goals,
  setGoals,
  periodDirectionGoal = '',
  setPeriodDirectionGoal,
  periodFocusMajorKey = '',
  setPeriodFocusMajorKey,
  radarSeries = [],
  radarGradeLabel = '',
  radarHeadlineScore = Number.NaN,
  activeEvalPeriodKey,
  setActiveEvalPeriodKey,
  evalPeriodSelectOptions,
  evalPeriodFallbackKey,
  isSubmittedForPeriod = false,
  onSubmitGoalManagement,
}) {
  const [addOpen, setAddOpen] = useState(false)
  const [showDraftCadetail, setShowDraftCadetail] = useState(false)
  const [draftPlan, setDraftPlan] = useState('')
  const [draftDo, setDraftDo] = useState('')
  const [draftCheck, setDraftCheck] = useState('')
  const [draftAction, setDraftAction] = useState('')
  const [draftDeadline, setDraftDeadline] = useState('')

  const buildPdcaDetailText = useCallback((doText, checkText, actionText) => {
    return [
      `D（実行）: ${String(doText ?? '').trim() || '（未入力）'}`,
      `C（評価）: ${String(checkText ?? '').trim() || '（未入力）'}`,
      `A（改善）: ${String(actionText ?? '').trim() || '（未入力）'}`,
    ].join('\n')
  }, [])
  const normalizePdcaFreeText = useCallback((value) => {
    const s = String(value ?? '').trim()
    if (!s) return ''
    const normalized = s.replace(/[()（）\s]/g, '')
    if (normalized === '未入力') return ''
    return s
  }, [])

  const normalizeGoalPdca = useCallback((goal) => {
    const plan = String(goal?.plan ?? goal?.title ?? '').trim()
    const lines = String(goal?.detail ?? '').split(/\r?\n/)
    const readLine = (prefix) => {
      const line = lines.find((x) => String(x ?? '').trim().startsWith(prefix))
      return line ? String(line).replace(prefix, '').trim() : ''
    }
    const doText = normalizePdcaFreeText(
      String(goal?.doText ?? '').trim() ||
        readLine('D（実行）:') ||
        (lines.length <= 1 ? String(goal?.detail ?? '').trim() : ''),
    )
    const checkText = normalizePdcaFreeText(String(goal?.checkText ?? '').trim() || readLine('C（評価）:'))
    const actionText = normalizePdcaFreeText(String(goal?.actionText ?? '').trim() || readLine('A（改善）:'))
    const isAchievedAuto = Boolean(plan && doText && checkText && actionText)
    return {
      id: goal?.id,
      plan,
      doText,
      checkText,
      actionText,
      deadline: String(goal?.deadline ?? '').trim(),
      achieved: isAchievedAuto,
      detail: buildPdcaDetailText(doText, checkText, actionText),
    }
  }, [buildPdcaDetailText, normalizePdcaFreeText])

  const normalizedGoals = useMemo(() => goals.map(normalizeGoalPdca), [goals, normalizeGoalPdca])
  const total = normalizedGoals.length
  const achieved = useMemo(() => normalizedGoals.filter((g) => g.achieved).length, [normalizedGoals])
  const ratePct = total === 0 ? 0 : Math.round((achieved / total) * 100)
  const isGoalMgmtLocked = Boolean(isSubmittedForPeriod)
  const focusMajorOptions = useMemo(() => {
    const latestRows = Array.isArray(radarSeries?.[0]?.rows) ? radarSeries[0].rows : []
    return latestRows
      .map((row) => ({
        value: String(row?.id ?? '').trim(),
        label: String(row?.title ?? '').trim() || '大項目',
      }))
      .filter((row) => row.value)
  }, [radarSeries])

  const openAddModal = () => {
    if (isGoalMgmtLocked) return
    setShowDraftCadetail(false)
    setDraftPlan('')
    setDraftDo('')
    setDraftCheck('')
    setDraftAction('')
    setDraftDeadline('')
    setAddOpen(true)
  }

  const closeAddModal = () => setAddOpen(false)
  const handlePeriodDirectionBlur = useCallback(
    (value) => {
      setPeriodDirectionGoal?.(String(value ?? '').trim())
    },
    [setPeriodDirectionGoal],
  )

  const handleCreateGoal = () => {
    if (isGoalMgmtLocked) return
    const plan = draftPlan.trim()
    const doText = draftDo.trim()
    const checkText = normalizePdcaFreeText(draftCheck.trim())
    const actionText = normalizePdcaFreeText(draftAction.trim())
    const deadline = draftDeadline.trim()
    if (!plan || !doText || !deadline) {
      window.alert('必須項目（P: Plan・D: Do・目標期日）を入力してください。')
      return
    }
    const title = plan
    const detail = buildPdcaDetailText(doText, checkText, actionText)
    const achievedAuto = Boolean(plan && doText && checkText && actionText)
    const id = `goal-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
    setGoals((prev) => [
      ...prev,
      {
        id,
        title,
        detail,
        deadline,
        achieved: achievedAuto,
        plan,
        doText,
        checkText,
        actionText,
      },
    ])
    closeAddModal()
  }

  const updateGoalPdcaField = useCallback(
    (id, field, value) => {
      if (isGoalMgmtLocked) return
      setGoals((prev) =>
        prev.map((g) => {
          if (g.id !== id) return g
          const current = normalizeGoalPdca(g)
          const next = {
            ...current,
            [field]: normalizePdcaFreeText(value),
          }
          const achievedAuto = Boolean(
            String(next.plan).trim() &&
              String(next.doText).trim() &&
              String(next.checkText).trim() &&
              String(next.actionText).trim(),
          )
          return {
            ...g,
            title: String(next.plan ?? '').trim(),
            detail: buildPdcaDetailText(next.doText, next.checkText, next.actionText),
            achieved: achievedAuto,
            plan: next.plan,
            doText: next.doText,
            checkText: next.checkText,
            actionText: next.actionText,
          }
        }),
      )
    },
    [setGoals, normalizeGoalPdca, buildPdcaDetailText, normalizePdcaFreeText, isGoalMgmtLocked],
  )

  const removeGoal = (id) => {
    if (isGoalMgmtLocked) return
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
        <label className="selfEvalPeriodField">
          評価期
          <select
            value={activeEvalPeriodKey ?? evalPeriodFallbackKey ?? ''}
            onChange={(event) => setActiveEvalPeriodKey?.(event.target.value)}
          >
            {(evalPeriodSelectOptions ?? []).map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </label>
      </header>
      {Array.isArray(radarSeries) && radarSeries.length > 0 ? (
        <section className="goalMgmtRadarCard">
          <MemberEvalRadarChart
            series={radarSeries}
            compact
            gradeLabel={radarGradeLabel}
            headlineScore={radarHeadlineScore}
            activePeriodKey={activeEvalPeriodKey ?? evalPeriodFallbackKey ?? ''}
            showWeightedFormula={false}
            highlightMajorKey={periodFocusMajorKey}
          />
        </section>
      ) : null}

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
      {typeof onSubmitGoalManagement === 'function' ? (
        <div className="selfEvalSubmitBar goalMgmtSubmitBar">
          <button
            type="button"
            className={`selfEvalSubmitBtn${isGoalMgmtLocked ? ' isLocked' : ''}`}
            onClick={() => onSubmitGoalManagement?.()}
            disabled={isGoalMgmtLocked}
          >
            目標管理を提出
          </button>
          <p className="selfEvalSubmitHint">
            {isGoalMgmtLocked
              ? '提出済みです。この評価期の目標・方針は閲覧のみです。評価責任者が管理画面から提出の取り消しを行うと、再編集できるようになります。'
              : '提出すると、この評価期の目標・方針は編集できなくなります。'}
          </p>
        </div>
      ) : null}
      <section className="goalMgmtDirectionCard">
        <h3>今期の方針目標を決めましょう！</h3>
        <p className="goalMgmtDirectionHint">
          まず今期の方向性を１つ定め、その達成に向けて下のPDCAを回しましょう。
        </p>
        {focusMajorOptions.length ? (
          <label className="selfEvalPeriodField">
            今期の重点大項目
            <select
              value={String(periodFocusMajorKey ?? '').trim()}
              onChange={(event) => setPeriodFocusMajorKey?.(event.target.value)}
              disabled={isGoalMgmtLocked}
            >
              <option value="">選択しない</option>
              {focusMajorOptions.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <textarea
          value={periodDirectionGoal}
          onChange={(event) => {
            if (isGoalMgmtLocked) return
            setPeriodDirectionGoal?.(event.target.value)
          }}
          onBlur={(event) => {
            if (isGoalMgmtLocked) return
            handlePeriodDirectionBlur(event.target.value)
          }}
          disabled={isGoalMgmtLocked}
          placeholder="例:自分の持ち場だけでなく、周囲にも目を配り、手助けが必要な場面では積極的にサポートを行う。また、後輩へ適切なアドバイスを行い、チーム全体の生産効率向上に貢献していく。"
          rows={3}
        />
      </section>

      <div className="goalMgmtToolbar">
        <button type="button" className="goalMgmtAddBtn" onClick={openAddModal} disabled={isGoalMgmtLocked}>
          + 新しい目標を追加
        </button>
      </div>

      <div className="goalMgmtMainBox">
        <p className="goalMgmtListGuide">
          目標を実行したら、その結果の確認（C）と改善（A）を行いましょう。C/Aをすべて入力すると達成済みになります。
        </p>
        {total === 0 ? (
          <div className="goalMgmtEmpty">
            <p>目標が設定されていません。</p>
            <p>「新しい目標を追加」ボタンから目標を設定してください。</p>
          </div>
        ) : (
          <ul className="goalMgmtList">
            {normalizedGoals.map((g) => (
              <li key={g.id} className={`goalMgmtListItem${g.achieved ? ' isAchieved' : ''}`}>
                <div className="goalMgmtListHead">
                  <label className="goalMgmtCheckLabel">
                    <span className={g.achieved ? 'goalMgmtListTitle isAchieved' : 'goalMgmtListTitle'}>
                      {g.plan}
                    </span>
                  </label>
                  <button
                    type="button"
                    className="goalMgmtDeleteBtn"
                    onClick={() => removeGoal(g.id)}
                    disabled={isGoalMgmtLocked}
                  >
                    削除
                  </button>
                </div>
                <p className="goalMgmtListDeadline">期日: {deadlineLabel(g.deadline)}</p>
                <p className="goalMgmtListDetail">{`D（実行）: ${g.doText || '（未入力）'}`}</p>
                <label className="goalMgmtPdcaInlineField">
                  C（Check: 評価）
                  <textarea
                    value={g.checkText}
                    onChange={(event) => updateGoalPdcaField(g.id, 'checkText', event.target.value)}
                    disabled={isGoalMgmtLocked}
                    placeholder="結果の確認・評価"
                    rows={2}
                  />
                </label>
                <label className="goalMgmtPdcaInlineField">
                  A（Action: 改善）
                  <textarea
                    value={g.actionText}
                    onChange={(event) => updateGoalPdcaField(g.id, 'actionText', event.target.value)}
                    disabled={isGoalMgmtLocked}
                    placeholder="次の改善アクション"
                    rows={2}
                  />
                </label>
              </li>
            ))}
          </ul>
        )}
      </div>

      {addOpen ? (
        <div className="employeeModalOverlay goalMgmtModalOverlay" onClick={closeAddModal}>
          <div className="employeeModal goalMgmtFormModal" onClick={(event) => event.stopPropagation()}>
            <button type="button" className="modalClose" onClick={closeAddModal}>
              ×
            </button>
            <h3>新しい目標を追加（PDCA）</h3>
            <p className="goalMgmtModalSub">まず P（計画）と D（実行）を決め、C/A は後から追記できます。</p>
            <div className="goalMgmtFormFields">
              <label className="goalMgmtFormLabel">
                P（Plan: 目標） <span className="goalMgmtReq">*</span>
                <textarea
                  value={draftPlan}
                  onChange={(event) => setDraftPlan(event.target.value)}
                  placeholder="例:自分の持ち場以外の工程を理解するために、1つ前の工程を覚え、人手が足りない時にサポートできるようにする。"
                  autoComplete="off"
                  rows={3}
                />
              </label>
              <label className="goalMgmtFormLabel">
                D（Do: 実行）
                <span className="goalMgmtReq">*</span>
                <textarea
                  value={draftDo}
                  onChange={(event) => setDraftDo(event.target.value)}
                  placeholder="まずは簡単な作業から覚え、実際に作業へ参加する。"
                  rows={3}
                />
              </label>
              <button
                type="button"
                className="goalMgmtCadetailToggle"
                onClick={() => setShowDraftCadetail((prev) => !prev)}
              >
                {showDraftCadetail ? '▼ C/A入力欄を閉じる（後で入力可）' : '▶ C/A入力欄を開く（任意・後で入力可）'}
              </button>
              {showDraftCadetail ? (
                <>
                  <label className="goalMgmtFormLabel">
                    C（Check: 評価）
                    <span className="goalMgmtFieldHint">達成度や数値、うまくいった点・課題を整理します。</span>
                    <textarea
                      value={draftCheck}
                      onChange={(event) => setDraftCheck(event.target.value)}
                      placeholder="作業を覚えることで対応できる範囲が広がり、作業ペースが効率化されたか確認する。"
                      rows={2}
                    />
                  </label>
                  <label className="goalMgmtFormLabel">
                    A（Action: 改善）
                    <span className="goalMgmtFieldHint">次にどう改善して再挑戦するかを書きます。</span>
                    <textarea
                      value={draftAction}
                      onChange={(event) => setDraftAction(event.target.value)}
                      placeholder="作業中に物が散乱していたため、置き場を整理し、さらに作業しやすい環境づくりを行う。"
                      rows={2}
                    />
                  </label>
                </>
              ) : null}
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

function SkillSettingsPage({
  skills,
  setSkills,
  sections,
  setSections,
  grades,
  setGrades,
  activeGradeId,
  setActiveGradeId,
  deptChoices,
  onRemoveSkillProgressKeysGlobally,
}) {
  const deptList = Array.isArray(deptChoices) && deptChoices.length > 0 ? deptChoices : DEFAULT_EMPLOYEE_DEPTS
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
      allDepts,
      depts: allDepts ? [] : depts.filter((d) => d !== 'all' && deptList.includes(d)),
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

    const validDepts = draft.depts.filter((d) => deptList.includes(d))
    if (!draft.allDepts && validDepts.length === 0) {
      window.alert('「全部署」にチェックを入れるか、部署マスタに登録されている部署を1つ以上選んでください。')
      return
    }
    const departments = draft.allDepts ? ['all'] : [...validDepts]

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
      required: true,
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

  const openSectionEditModal = () => {
    window.alert('区分は「評価基準設定」の大項目と連動しています。区分の追加・編集・削除は評価基準設定で行ってください。')
  }

  const handleDeleteSection = (sectionId) => {
    if (sections.length <= 1) {
      window.alert('区分は最低1つ必要です。')
      return
    }
    const sec = sections.find((s) => s.id === sectionId)
    const label = sec?.label ?? sectionId
    const inSection = skills.filter((s) => s.sectionId === sectionId)
    const detail =
      inSection.length > 0
        ? `この区分に属するスキルが全等級あわせて${inSection.length}件あります。区分とこれらのスキルを削除し、従業員の進捗から該当スキル分を取り除きます。`
        : 'この区分にスキルはありません。区分だけを削除します。'
    const ok = window.confirm(
      `区分「${label}」を削除しますか？\n\n${detail}\n\n「OK」で削除、「キャンセル」で中止します。`,
    )
    if (!ok) return
    const skillIds = inSection.map((s) => s.id)
    onRemoveSkillProgressKeysGlobally?.(skillIds)
    const remainingFirst = sections.find((s) => s.id !== sectionId)?.id
    setSkills((prev) => prev.filter((s) => s.sectionId !== sectionId))
    setSections((prev) => prev.filter((s) => s.id !== sectionId))
    if (remainingFirst) {
      setDraft((prev) => (prev.sectionId === sectionId ? { ...prev, sectionId: remainingFirst } : prev))
    }
  }

  const handleSaveNewSection = (event) => {
    event.preventDefault()
    const label = newSectionLabel.trim()
    if (!label) return
    const id = `sec_${Date.now()}`
    setSections((prev) => [...prev, { id, label }])
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
          <p>スキルの設定を確認・編集できます（区分は評価基準の大項目と連動）</p>
        </div>
        <div className="skillSettingsHeaderActions">
          <button type="button" className="skillSectionAddButton" onClick={openSectionEditModal}>
            区分は評価基準と連動
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
                    <th>対象部署</th>
                    <th>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {sectionSkills.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="skillTableEmpty">
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

              <fieldset className="skillDeptFieldset">
                <legend>対象部署（部署マスタと連動）</legend>
                <p className="skillDeptMasterHelp">
                  チェック一覧は「設定」→「部署マスタ」の部署名と同じです。部署の追加・削除は部署マスタで行ってください。
                </p>
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
                    {deptList.length === 0 ? (
                      <p className="skillDeptMasterEmpty">部署マスタに部署がまだありません。先に部署を登録してください。</p>
                    ) : (
                      deptList.map((d) => (
                      <label key={d} className="skillCheckboxRow">
                        <input
                          type="checkbox"
                          checked={draft.depts.includes(d)}
                          onChange={() => toggleDept(d)}
                        />
                        {d}
                      </label>
                      ))
                    )}
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
            <h3>区分の編集</h3>
            <p>区分の削除や、新しい区分の追加ができます。区分を削除すると、その区分内のスキル（全等級）もまとめて削除されます。</p>

            <ul className="skillSectionEditList">
              {sections.map((s) => {
                const count = skills.filter((sk) => sk.sectionId === s.id).length
                const onlyOne = sections.length <= 1
                return (
                  <li key={s.id} className="skillSectionEditRow">
                    <div>
                      <strong>{s.label}</strong>
                      <span className="skillSectionEditMeta">{count > 0 ? `スキル ${count}件` : 'スキルなし'}</span>
                    </div>
                    <button
                      type="button"
                      className="skillSectionDeleteBtn"
                      disabled={onlyOne}
                      title={onlyOne ? '区分は最低1つ必要です' : 'この区分を削除'}
                      onClick={() => handleDeleteSection(s.id)}
                    >
                      削除
                    </button>
                  </li>
                )
              })}
            </ul>

            <form className="employeeForm skillSectionAddForm" onSubmit={handleSaveNewSection}>
              <h4 className="skillSectionAddFormTitle">新しい区分を追加</h4>
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
                  閉じる
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

/** 管理者ダッシュ用：Amazon風の折りたたみセクション */
function AdminDashAccordion({ id, title, titleMeta, defaultOpen = true, className = '', children }) {
  const [open, setOpen] = useState(defaultOpen)
  const panelId = `${id}-panel`
  const triggerId = `${id}-trigger`

  return (
    <div className={`adminDashAccordion ${className}`.trim()}>
      <button
        type="button"
        id={triggerId}
        className="adminDashAccordionTrigger"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((prev) => !prev)}
      >
        <span className="adminDashAccordionTitleRow">
          <span className="adminDashAccordionTitle">{title}</span>
          {titleMeta != null && titleMeta !== '' ? (
            <span className="adminDashAccordionMeta">{titleMeta}</span>
          ) : null}
        </span>
        <span className={`adminDashAccordionChevron ${open ? 'isOpen' : ''}`} aria-hidden>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path
              d="M6 9l6 6 6-6"
              stroke="currentColor"
              strokeWidth="2.2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </span>
      </button>
      <div
        id={panelId}
        role="region"
        aria-labelledby={triggerId}
        className={`adminDashAccordionPanel ${open ? 'isOpen' : ''}`}
        aria-hidden={!open}
      >
        <div className="adminDashAccordionPanelMeasure">
          <div className="adminDashAccordionPanelInner">{children}</div>
        </div>
      </div>
    </div>
  )
}

const MemberSelfEvalTab = memo(function MemberSelfEvalTab({ rows }) {
  return rows.length ? (
    <ul className="memberEvalList">
      {rows.map((row) => (
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
})

const MemberBossEvalTab = memo(function MemberBossEvalTab({ rows }) {
  return rows.length ? (
    <ul className="memberEvalList">
      {rows.map((row) => (
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
    <p className="memberDetailEmpty">1次評価(上司)の入力はまだありません。</p>
  )
})

const MemberHistoryTab = memo(function MemberHistoryTab({ rows, summary }) {
  return rows.length ? (
    <div className="memberEvalHistoryBlock">
      {summary ? (
        <div className="memberEvalHistorySummary">
          <p>
            最新期: <strong>{summary.latestPeriod}</strong>
            {summary.previousPeriod ? `（前回: ${summary.previousPeriod}）` : ''}
          </p>
          <p>
            自己: <strong>{summary.selfTrend}</strong> / 上司: <strong>{summary.bossTrend}</strong> / 経営層:{' '}
            <strong>{summary.execTrend}</strong>
          </p>
          <p>{summary.focusLabel}</p>
        </div>
      ) : null}
      <div className="memberEvalHistoryWrap">
        <table className="memberEvalHistoryTable">
          <thead>
            <tr>
              <th>評価期</th>
              <th>自己評価</th>
              <th>前期比</th>
              <th>1次評価(上司)</th>
              <th>前期比</th>
              <th>経営層評価</th>
              <th>前期比</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.periodKey}>
                <td>{row.periodKey}</td>
                <td>{row.selfLabel}</td>
                <td className={String(row.selfDelta).startsWith('+') ? 'isUp' : String(row.selfDelta).startsWith('-') ? 'isDown' : ''}>
                  {row.selfDelta}
                </td>
                <td>{row.bossLabel}</td>
                <td className={String(row.bossDelta).startsWith('+') ? 'isUp' : String(row.bossDelta).startsWith('-') ? 'isDown' : ''}>
                  {row.bossDelta}
                </td>
                <td>{row.execLabel}</td>
                <td className={String(row.execDelta).startsWith('+') ? 'isUp' : String(row.execDelta).startsWith('-') ? 'isDown' : ''}>
                  {row.execDelta}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  ) : (
    <p className="memberDetailEmpty">評価履歴はまだありません。</p>
  )
})

function AdminMockPage({
  directoryRows,
  skills,
  skillProgress,
  setSkillEmployeeProgress,
  skillProgressUpdatedAtByEmployee,
  selfEvalByEmployee,
  supervisorEvalByEmployee,
  setSupervisorEvalByEmployee,
  executiveEvalByEmployee,
  setExecutiveEvalByEmployee,
  selfEvalHistoryByEmployee,
  supervisorEvalHistoryByEmployee,
  setSupervisorEvalHistoryByEmployee,
  executiveEvalHistoryByEmployee,
  setExecutiveEvalHistoryByEmployee,
  goalsByEmployeePeriod,
  goalDirectionByEmployeePeriod,
  goalFocusMajorByEmployeePeriod,
  evaluationCriteria,
  hideGradeSelfEvalAndGradeStats = false,
  canViewExecutiveCommentEval = false,
  forcedSelectedMemberId,
  forcedDetailTab,
  onSelectMember,
  onChangeDetailTab,
  promotionRequests,
  canApprovePromotions,
  onApprovePromotionRequest,
  onRejectPromotionRequest,
  activeEvalPeriodKey,
  setActiveEvalPeriodKey,
  evalPeriodDefinitions,
  evalPeriodFallbackKey,
  onSubmitSupervisorEvaluation,
  onWithdrawSupervisorEvaluation,
  onWithdrawSelfEvaluation,
  onWithdrawGoalSubmissionForMember,
  goalSubmissionByEmployee,
  onSubmitExecutiveEvaluation,
}) {
  const SELF_BOSS_GAP_ALERT_THRESHOLD = 20
  const [selectedMemberId, setSelectedMemberId] = useState(null)
  const [detailTab, setDetailTab] = useState('skill')
  const [adminMemberSearch, setAdminMemberSearch] = useState('')
  const [adminMemberDept, setAdminMemberDept] = useState('')
  const [adminMemberGrade, setAdminMemberGrade] = useState('')
  const [adminMemberPeriodKey, setAdminMemberPeriodKey] = useState('')
  /** all | active | retired */
  const [adminMemberEmployment, setAdminMemberEmployment] = useState('active')
  /** name | id | grade | retiredFirst */
  const [adminMemberSort, setAdminMemberSort] = useState('name')
  const [bossCommentDraft, setBossCommentDraft] = useState('')
  const [bossCommentDraftMajor, setBossCommentDraftMajor] = useState('')
  const [execCommentDraft, setExecCommentDraft] = useState('')
  const [execCommentDraftMajor, setExecCommentDraftMajor] = useState('')
  const adminMemberDetailDockRef = useRef(null)
  const adminMockTopRef = useRef(null)
  const [adminScrollTopVisible, setAdminScrollTopVisible] = useState(false)

  const pendingPromotionRequests = useMemo(
    () => (promotionRequests ?? []).filter((r) => r.status === 'pending'),
    [promotionRequests],
  )

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
        retired: isEmployeeDirectoryRetired(row),
      })),
    [directoryRows, skills, skillProgress],
  )

  const adminDeptOptions = useMemo(() => {
    const set = new Set()
    for (const row of directoryRows) {
      const d = String(row.dept ?? '').trim()
      if (d) set.add(d)
    }
    return [...set].sort((a, b) => a.localeCompare(b, 'ja'))
  }, [directoryRows])

  const adminGradeOptions = useMemo(() => {
    const set = new Set()
    for (const row of directoryRows) {
      const g = String(row.grade ?? '').trim()
      if (g) set.add(g)
    }
    return [...set].sort((a, b) => a.localeCompare(b, 'ja'))
  }, [directoryRows])

  const adminFilteredMemberRows = useMemo(() => {
    const q = adminMemberSearch.trim().toLowerCase()
    let list = memberRows.filter((m) => {
      if (adminMemberEmployment === 'active' && m.retired) return false
      if (adminMemberEmployment === 'retired' && !m.retired) return false
      if (adminMemberDept && m.dept !== adminMemberDept) return false
      if (adminMemberGrade && m.grade !== adminMemberGrade) return false
      if (q && !String(m.name ?? '').toLowerCase().includes(q)) return false
      return true
    })
    const gradeOrder = (g) => {
      const m = /^G(\d)/i.exec(String(g))
      return m ? -Number(m[1]) : 0
    }
    const sorted = [...list]
    if (adminMemberSort === 'retiredFirst') {
      sorted.sort((a, b) => Number(b.retired) - Number(a.retired) || String(a.name).localeCompare(String(b.name), 'ja'))
    } else if (adminMemberSort === 'id') {
      sorted.sort((a, b) => String(a.id).localeCompare(String(b.id), 'ja'))
    } else if (adminMemberSort === 'grade') {
      sorted.sort((a, b) => gradeOrder(a.grade) - gradeOrder(b.grade) || String(a.name).localeCompare(String(b.name), 'ja'))
    } else {
      sorted.sort((a, b) => String(a.name).localeCompare(String(b.name), 'ja'))
    }
    return sorted
  }, [memberRows, adminMemberSearch, adminMemberDept, adminMemberGrade, adminMemberEmployment, adminMemberSort])

  useEffect(() => {
    if (!adminFilteredMemberRows.length) {
      setSelectedMemberId(null)
      return
    }
    if (!selectedMemberId) {
      setSelectedMemberId(adminFilteredMemberRows[0].id)
      return
    }
    if (selectedMemberId && !adminFilteredMemberRows.some((m) => m.id === selectedMemberId)) {
      setSelectedMemberId(null)
    }
  }, [adminFilteredMemberRows, selectedMemberId])

  useEffect(() => {
    if (!forcedSelectedMemberId) return
    const row = directoryRows.find((r) => String(r.id) === String(forcedSelectedMemberId))
    if (row && isEmployeeDirectoryRetired(row) && adminMemberEmployment === 'active') {
      setAdminMemberEmployment('all')
    }
  }, [forcedSelectedMemberId, directoryRows, adminMemberEmployment])

  useEffect(() => {
    if (!forcedSelectedMemberId) return
    if (adminFilteredMemberRows.some((m) => m.id === forcedSelectedMemberId)) {
      setSelectedMemberId(forcedSelectedMemberId)
    }
  }, [forcedSelectedMemberId, adminFilteredMemberRows])

  // NOTE: Do not force-sync detailTab from parent state here.
  // Local tab clicks must always win to keep admin tab switching responsive.

  const switchDetailTab = useCallback(
    (tabId) => {
      const needsMember = tabId === 'boss' || tabId === 'bossnote' || tabId === 'execcomments' || tabId === 'execnote'
      if (needsMember && !selectedMemberId && adminFilteredMemberRows.length > 0) {
        setSelectedMemberId(adminFilteredMemberRows[0].id)
      }
      setDetailTab(tabId)
      onChangeDetailTab?.(tabId)
    },
    [onChangeDetailTab, selectedMemberId, adminFilteredMemberRows],
  )

  useEffect(() => {
    if (!hideGradeSelfEvalAndGradeStats) return
    if (detailTab === 'self') {
      setDetailTab('skill')
      onChangeDetailTab?.('skill')
    }
  }, [hideGradeSelfEvalAndGradeStats, detailTab, onChangeDetailTab])

  useEffect(() => {
    if (canViewExecutiveCommentEval) return
    if (detailTab === 'execcomments') {
      setDetailTab('skill')
      onChangeDetailTab?.('skill')
    }
  }, [canViewExecutiveCommentEval, detailTab, onChangeDetailTab])

  useEffect(() => {
    if (!hideGradeSelfEvalAndGradeStats) return
    if (adminMemberSort === 'grade') setAdminMemberSort('name')
  }, [hideGradeSelfEvalAndGradeStats, adminMemberSort])

  useEffect(() => {
    const el = adminMockTopRef.current
    if (!el) return
    let rafId = 0
    let lastVisible = null
    const update = () => {
      if (rafId) return
      rafId = window.requestAnimationFrame(() => {
        rafId = 0
        const top = el.getBoundingClientRect().top
        const visible = top < 72
        if (lastVisible === visible) return
        lastVisible = visible
        setAdminScrollTopVisible(visible)
      })
    }
    update()
    window.addEventListener('scroll', update, { passive: true })
    window.addEventListener('resize', update, { passive: true })
    return () => {
      if (rafId) window.cancelAnimationFrame(rafId)
      window.removeEventListener('scroll', update)
      window.removeEventListener('resize', update)
    }
  }, [])

  const selectedMember = useMemo(
    () => adminFilteredMemberRows.find((m) => m.id === selectedMemberId) ?? null,
    [adminFilteredMemberRows, selectedMemberId],
  )
  const selectedMemberWeightedTotal100 = useMemo(() => {
    return overallWeightedScore100ForEmployee(selectedMember, {
      skills,
      skillProgress,
      selfEvalByEmployee,
      supervisorEvalByEmployee,
      executiveEvalByEmployee,
      evaluationCriteria,
    })
  }, [selectedMember, evaluationCriteria, skills, skillProgress, selfEvalByEmployee, supervisorEvalByEmployee, executiveEvalByEmployee])
  const selectedMemberSelfBossGap = useMemo(() => {
    if (!selectedMember) return Number.NaN
    const empId = String(selectedMember.id ?? '').trim()
    if (!empId) return Number.NaN
    const full = directoryRows.find((r) => String(r?.id ?? '').trim() === empId)
    const memberPeriodOptions = buildEvalPeriodSelectOptionList({
      definitions: evalPeriodDefinitions,
      selfEvalHistoryByEmployee,
      supervisorEvalHistoryByEmployee,
      extraPeriods: normalizeExtraEvalPeriodsForEmployee(full),
      forEmployeeId: empId,
    })
    const activeCandidate = String(activeEvalPeriodKey ?? '').trim()
    const hasActiveCandidate = memberPeriodOptions.some((opt) => String(opt?.value ?? '').trim() === activeCandidate)
    const activeKey = hasActiveCandidate ? activeCandidate : String(memberPeriodOptions?.[0]?.value ?? '').trim()
    if (!activeKey) return Number.NaN
    const selfHist = selfEvalHistoryByEmployee?.[empId] ?? {}
    const bossHist = supervisorEvalHistoryByEmployee?.[empId] ?? {}
    const periodGrade =
      String(selfHist?.[activeKey]?.evalGrade ?? '').trim() ||
      String(bossHist?.[activeKey]?.evalGrade ?? '').trim() ||
      String(selectedMember.grade ?? '').trim()
    const categories = buildEvalCategoriesForGrade(evaluationCriteria, periodGrade)
    // 乖離アラートは「選択中の期」のスナップショットを優先して計算し、
    // 自動保存中の一時状態による値の揺れを抑える。
    const hasSelfHistForActive = Boolean(selfHist?.[activeKey] && typeof selfHist[activeKey] === 'object')
    const hasBossHistForActive = Boolean(bossHist?.[activeKey] && typeof bossHist[activeKey] === 'object')
    // 他期の値を参照しない（選択期の履歴のみで判定）
    const selfScores = hasSelfHistForActive ? { ...(selfHist?.[activeKey]?.scores ?? {}) } : {}
    const bossScores = hasBossHistForActive ? { ...(bossHist?.[activeKey]?.scores ?? {}) } : {}
    const self100 = weightedEvalScore100ByCategories(categories, selfScores)
    const boss100 = weightedEvalScore100ByCategories(categories, bossScores)
    if (!Number.isFinite(self100) || !Number.isFinite(boss100)) return Number.NaN
    return Math.abs(self100 - boss100)
  }, [
    selectedMember,
    directoryRows,
    evalPeriodDefinitions,
    activeEvalPeriodKey,
    evalPeriodFallbackKey,
    selfEvalByEmployee,
    supervisorEvalByEmployee,
    selfEvalHistoryByEmployee,
    supervisorEvalHistoryByEmployee,
    evaluationCriteria,
  ])
  const selectedMemberSelfBossGapAlert = useMemo(() => {
    if (!Number.isFinite(selectedMemberSelfBossGap)) return null
    if (selectedMemberSelfBossGap < SELF_BOSS_GAP_ALERT_THRESHOLD) return null
    return `自己/上司の評価乖離 ${selectedMemberSelfBossGap.toFixed(1)}点`
  }, [selectedMemberSelfBossGap])
  const selectedMemberTopMajorGapLabels = useMemo(() => {
    const top = topSelfBossMajorGaps(selectedMember, evaluationCriteria, selfEvalByEmployee, supervisorEvalByEmployee, 2)
    return top.map((x) => `${x.title} ${x.gap.toFixed(1)}点`)
  }, [selectedMember, evaluationCriteria, selfEvalByEmployee, supervisorEvalByEmployee])
  const adminMemberEvalPeriodSelectOptions = useMemo(() => {
    const full = directoryRows.find((r) => String(r?.id) === String(selectedMember?.id))
    return buildEvalPeriodSelectOptionList({
      definitions: evalPeriodDefinitions,
      selfEvalHistoryByEmployee,
      supervisorEvalHistoryByEmployee,
      extraPeriods: normalizeExtraEvalPeriodsForEmployee(full),
      forEmployeeId: selectedMember?.id,
    })
  }, [
    evalPeriodDefinitions,
    directoryRows,
    selectedMember?.id,
    selfEvalHistoryByEmployee,
    supervisorEvalHistoryByEmployee,
  ])
  useEffect(() => {
    const optionValues = (adminMemberEvalPeriodSelectOptions ?? []).map((opt) => String(opt?.value ?? '').trim()).filter(Boolean)
    if (!optionValues.length) {
      setAdminMemberPeriodKey('')
      return
    }
    const current = String(adminMemberPeriodKey ?? '').trim()
    if (current && optionValues.includes(current)) return
    const activeCandidate = String(activeEvalPeriodKey ?? '').trim()
    if (activeCandidate && optionValues.includes(activeCandidate)) {
      setAdminMemberPeriodKey(activeCandidate)
      return
    }
    setAdminMemberPeriodKey(optionValues[0])
  }, [adminMemberEvalPeriodSelectOptions, adminMemberPeriodKey, activeEvalPeriodKey])
  const selectedMemberEffectivePeriodKey = useMemo(() => {
    const active = String(adminMemberPeriodKey ?? '').trim()
    const optionValues = (adminMemberEvalPeriodSelectOptions ?? []).map((opt) => String(opt?.value ?? '').trim()).filter(Boolean)
    if (active && optionValues.includes(active)) return active
    return String(optionValues[0] ?? evalPeriodFallbackKey ?? '').trim()
  }, [adminMemberPeriodKey, adminMemberEvalPeriodSelectOptions, evalPeriodFallbackKey])
  const scrollMemberDockIntoView = useCallback(() => {
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        adminMemberDetailDockRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
      })
    })
  }, [])
  const selectedMemberSkills = useMemo(() => {
    if (!selectedMember) return []
    const rawProgress = skillProgress?.[selectedMember.id] ?? {}
    return (skills ?? [])
      .filter((s) => s.gradeId === selectedMember.grade)
      .map((s) => {
        const current = Math.max(0, Number(rawProgress[s.id] ?? 0))
        const max = Math.max(1, Number(s.stages) || 1)
        return { id: s.id, title: s.title, description: s.description, current, max }
      })
  }, [selectedMember, skills, skillProgress])
  const selectedMemberActiveEvalGrade = useMemo(() => {
    if (!selectedMember) return ''
    const periodKey = String(selectedMemberEffectivePeriodKey ?? '').trim()
    const empId = String(selectedMember.id ?? '').trim()
    const selfStored = String(selfEvalHistoryByEmployee?.[empId]?.[periodKey]?.evalGrade ?? '').trim()
    const bossStored = String(supervisorEvalHistoryByEmployee?.[empId]?.[periodKey]?.evalGrade ?? '').trim()
    const preferred = selfStored || bossStored || String(selectedMember.grade ?? '').trim()
    const byGrade =
      evaluationCriteria?.byGrade &&
      typeof evaluationCriteria.byGrade === 'object' &&
      !Array.isArray(evaluationCriteria.byGrade)
        ? evaluationCriteria.byGrade
        : {}
    const gradeIds = Object.keys(byGrade).filter((k) => Array.isArray(byGrade[k]))
    if (preferred && gradeIds.includes(preferred)) return preferred
    const current = String(selectedMember.grade ?? '').trim()
    if (current && gradeIds.includes(current)) return current
    return gradeIds[0] ?? preferred ?? current
  }, [
    selectedMember,
    selectedMemberEffectivePeriodKey,
    selfEvalHistoryByEmployee,
    supervisorEvalHistoryByEmployee,
    evaluationCriteria,
  ])
  const selectedMemberEvalItems = useMemo(() => {
    const cats = buildEvalCategoriesForGrade(evaluationCriteria, selectedMemberActiveEvalGrade)
    return cats.flatMap((cat) => cat.items)
  }, [evaluationCriteria, selectedMemberActiveEvalGrade])
  const selectedMemberEvalRadarSeries = useMemo(() => {
    if (!selectedMember) return []
    const empId = String(selectedMember.id ?? '').trim()
    if (!empId) return []
    const activeKey = String(selectedMemberEffectivePeriodKey ?? '').trim()
    const selfHist = selfEvalHistoryByEmployee?.[empId] ?? {}
    const bossHist = supervisorEvalHistoryByEmployee?.[empId] ?? {}
    const execHist = executiveEvalHistoryByEmployee?.[empId] ?? {}
    const periodKeys = pickRadarPeriodKeys({
      activeKey,
      selfHist,
      bossHist,
      execHist,
      definitions: evalPeriodDefinitions,
      limit: 3,
    })
    if (!periodKeys.length) return []
    const axisMajors = buildEvalCategoriesForGrade(evaluationCriteria, selectedMemberActiveEvalGrade).map((c, idx) => ({
      id: String(c?.id ?? '').trim() || `major-${idx}`,
      title: String(c?.title ?? '').trim() || `大項目${idx + 1}`,
    }))
    if (!axisMajors.length) return []
    const palette = ['#2563eb', '#059669', '#7c3aed']
    return periodKeys
      .map((periodKey, idx) => {
        const selfSubmitted = Boolean(String(selfHist?.[periodKey]?.submittedAt ?? '').trim())
        const bossSubmitted = Boolean(String(bossHist?.[periodKey]?.submittedAt ?? '').trim())
        const execSubmitted = Boolean(String(execHist?.[periodKey]?.submittedAt ?? '').trim())
        if (!selfSubmitted || !bossSubmitted || !execSubmitted) return null
        const periodGrade =
          String(selfHist?.[periodKey]?.evalGrade ?? '').trim() ||
          String(bossHist?.[periodKey]?.evalGrade ?? '').trim() ||
          selectedMemberActiveEvalGrade
        const periodCats = buildEvalCategoriesForGrade(evaluationCriteria, periodGrade)
        const catById = new Map(periodCats.map((c) => [String(c?.id ?? '').trim(), c]))
        const catByTitle = new Map(periodCats.map((c) => [String(c?.title ?? '').trim(), c]))
        const selfScores =
          periodKey === activeKey
            ? {
                ...(selfHist?.[periodKey]?.scores ?? {}),
                ...(selfEvalByEmployee?.[empId]?.scores ?? {}),
              }
            : { ...(selfHist?.[periodKey]?.scores ?? {}) }
        const bossScores =
          periodKey === activeKey
            ? {
                ...(bossHist?.[periodKey]?.scores ?? {}),
                ...(supervisorEvalByEmployee?.[empId]?.scores ?? {}),
              }
            : { ...(bossHist?.[periodKey]?.scores ?? {}) }
        const periodExecState = execHist?.[periodKey] ?? null
        const execScores =
          periodExecState?.scores &&
          typeof periodExecState.scores === 'object' &&
          !Array.isArray(periodExecState.scores)
            ? periodExecState.scores
            : {}
        const execByMajor = executiveEvalCategoryScores100(axisMajors, periodExecState)
        const rows = axisMajors.map((major) => {
          const cat = catById.get(major.id) || catByTitle.get(major.title)
          const self100 = weightedEvalScore100ByItems(cat?.items ?? [], selfScores)
          const boss100 = weightedEvalScore100ByItems(cat?.items ?? [], bossScores)
          const execFromScores = weightedEvalScore100ByItems(cat?.items ?? [], execScores)
          const exec100 = Number.isFinite(execFromScores)
            ? execFromScores
            : Number.isFinite(execByMajor?.[major.id])
              ? execByMajor[major.id]
              : Number.NaN
          const allDone = Number.isFinite(self100) && Number.isFinite(boss100) && Number.isFinite(exec100)
          const total100 = allDone ? (self100 + boss100 + exec100) / 3 : Number.NaN
          return {
            id: major.id,
            title: major.title,
            self100: Number.isFinite(self100) ? self100 : Number.NaN,
            boss100: Number.isFinite(boss100) ? boss100 : Number.NaN,
            exec100,
            total100,
          }
        })
        const hasAllEvalCompleted = rows.some((r) => Number.isFinite(r.total100))
        if (!hasAllEvalCompleted) return null
        return {
          periodKey,
          label: idx === 0 ? `${periodKey}（最新）` : periodKey,
          color: palette[idx] ?? palette[palette.length - 1],
          rows,
        }
      })
      .filter(Boolean)
  }, [
    selectedMember,
    selectedMemberEffectivePeriodKey,
    selfEvalHistoryByEmployee,
    supervisorEvalHistoryByEmployee,
    executiveEvalByEmployee,
    executiveEvalHistoryByEmployee,
    selfEvalByEmployee,
    supervisorEvalByEmployee,
    selectedMemberActiveEvalGrade,
    evaluationCriteria,
    evalPeriodDefinitions,
  ])
  const selectedMemberSelfEvalRows = useMemo(() => {
    if (detailTab !== 'self') return []
    if (!selectedMember) return []
    const periodKey = String(selectedMemberEffectivePeriodKey ?? '').trim()
    const histSlot = periodKey ? selfEvalHistoryByEmployee?.[selectedMember.id]?.[periodKey] : null
    const evalState = histSlot && typeof histSlot === 'object' ? histSlot : selfEvalByEmployee?.[selectedMember.id]
    const scores = evalState?.scores ?? {}
    return selectedMemberEvalItems
      .map((item) => {
        const score = String(scores[item.id] ?? '').trim()
        if (!score) return null
        return { id: item.id, title: item.title, score }
      })
      .filter(Boolean)
  }, [
    detailTab,
    selectedMember,
    selectedMemberEffectivePeriodKey,
    selfEvalHistoryByEmployee,
    selfEvalByEmployee,
    selectedMemberEvalItems,
  ])
  const selectedMemberSupervisorEvalState = useMemo(() => {
    if (!selectedMember) return { scores: {}, comments: {} }
    const periodKey = String(selectedMemberEffectivePeriodKey ?? '').trim()
    const histSlot = periodKey ? supervisorEvalHistoryByEmployee?.[selectedMember.id]?.[periodKey] : null
    if (histSlot && typeof histSlot === 'object') {
      return {
        scores: { ...(histSlot?.scores ?? {}) },
        comments: { ...(histSlot?.comments ?? {}) },
      }
    }
    return supervisorEvalByEmployee?.[selectedMember.id] ?? { scores: {}, comments: {} }
  }, [
    selectedMember,
    selectedMemberEffectivePeriodKey,
    supervisorEvalHistoryByEmployee,
    supervisorEvalByEmployee,
  ])
  const setSelectedMemberSupervisorEvalState = useCallback(
    (updater) => {
      if (!selectedMember || !setSupervisorEvalByEmployee) return
      const periodKey = String(selectedMemberEffectivePeriodKey ?? '').trim()
      if (periodKey && setSupervisorEvalHistoryByEmployee) {
        setSupervisorEvalHistoryByEmployee((prev) => {
          const currentRaw = prev?.[selectedMember.id]?.[periodKey] ?? { scores: {}, comments: {} }
          const current = { scores: currentRaw.scores ?? {}, comments: currentRaw.comments ?? {} }
          const nextState = typeof updater === 'function' ? updater(current) : updater
          return {
            ...(prev ?? {}),
            [selectedMember.id]: {
              ...((prev ?? {})[selectedMember.id] ?? {}),
              [periodKey]: {
                ...currentRaw,
                scores: { ...(nextState?.scores ?? {}) },
                comments: { ...(nextState?.comments ?? {}) },
                savedAt: new Date().toISOString(),
              },
            },
          }
        })
      }
      setSupervisorEvalByEmployee((prev) => {
        const currentRaw = prev?.[selectedMember.id] ?? { scores: {}, comments: {}, commentHistory: [] }
        const current = { scores: currentRaw.scores ?? {}, comments: currentRaw.comments ?? {} }
        const nextState = typeof updater === 'function' ? updater(current) : updater
        return {
          ...(prev ?? {}),
          [selectedMember.id]: {
            ...currentRaw,
            scores: { ...(nextState?.scores ?? {}) },
            comments: { ...(nextState?.comments ?? {}) },
          },
        }
      })
    },
    [selectedMember, selectedMemberEffectivePeriodKey, setSupervisorEvalByEmployee, setSupervisorEvalHistoryByEmployee],
  )
  const selectedMemberExecutiveEvalState = useMemo(() => {
    if (!selectedMember) return { scores: {}, comments: {} }
    const periodKey = String(selectedMemberEffectivePeriodKey ?? '').trim()
    const histSlot = periodKey ? executiveEvalHistoryByEmployee?.[selectedMember.id]?.[periodKey] : null
    if (histSlot && typeof histSlot === 'object') {
      return {
        scores: { ...(histSlot?.scores ?? {}) },
        comments: { ...(histSlot?.comments ?? {}) },
      }
    }
    return {
      scores: executiveEvalByEmployee?.[selectedMember.id]?.scores ?? {},
      comments: executiveEvalByEmployee?.[selectedMember.id]?.comments ?? {},
    }
  }, [
    selectedMember,
    selectedMemberEffectivePeriodKey,
    executiveEvalHistoryByEmployee,
    executiveEvalByEmployee,
  ])
  const setSelectedMemberExecutiveEvalState = useCallback(
    (updater) => {
      if (!selectedMember || !setExecutiveEvalByEmployee) return
      const periodKey = String(selectedMemberEffectivePeriodKey ?? '').trim()
      if (periodKey && setExecutiveEvalHistoryByEmployee) {
        setExecutiveEvalHistoryByEmployee((prev) => {
          const currentRaw = prev?.[selectedMember.id]?.[periodKey] ?? { scores: {}, comments: {} }
          const current = {
            scores: currentRaw.scores ?? {},
            comments: currentRaw.comments ?? {},
          }
          const nextState = typeof updater === 'function' ? updater(current) : updater
          return {
            ...(prev ?? {}),
            [selectedMember.id]: {
              ...((prev ?? {})[selectedMember.id] ?? {}),
              [periodKey]: {
                ...currentRaw,
                scores: { ...(nextState?.scores ?? {}) },
                comments: { ...(nextState?.comments ?? {}) },
                savedAt: new Date().toISOString(),
              },
            },
          }
        })
      }
      setExecutiveEvalByEmployee((prev) => {
        const currentRaw = prev?.[selectedMember.id] ?? { baseScore: 0, baseByMajor: {}, commentHistory: [], scores: {}, comments: {} }
        const current = {
          scores: currentRaw.scores ?? {},
          comments: currentRaw.comments ?? {},
        }
        const nextState = typeof updater === 'function' ? updater(current) : updater
        return {
          ...(prev ?? {}),
          [selectedMember.id]: {
            ...currentRaw,
            scores: { ...(nextState?.scores ?? {}) },
            comments: { ...(nextState?.comments ?? {}) },
          },
        }
      })
    },
    [selectedMember, selectedMemberEffectivePeriodKey, setExecutiveEvalByEmployee, setExecutiveEvalHistoryByEmployee],
  )
  const execCommentMajorOptions = useMemo(() => {
    const majors = Array.isArray(evaluationCriteria?.sharedMajors) ? evaluationCriteria.sharedMajors : []
    return majors
      .map((m, idx) => ({
        id: String(m?.id ?? '').trim() || `major-${idx}`,
        title: String(m?.title ?? '').trim() || `大項目${idx + 1}`,
      }))
      .filter((m) => m.id)
  }, [evaluationCriteria])
  const bossCommentMajorOptions = execCommentMajorOptions
  const bossCommentMajorLabelById = useMemo(
    () => Object.fromEntries(bossCommentMajorOptions.map((m) => [m.id, m.title])),
    [bossCommentMajorOptions],
  )
  useEffect(() => {
    if (!bossCommentMajorOptions.length) {
      setBossCommentDraftMajor('')
      return
    }
    setBossCommentDraftMajor((prev) => {
      if (prev && bossCommentMajorLabelById[prev]) return prev
      return bossCommentMajorOptions[0].id
    })
  }, [bossCommentMajorOptions, bossCommentMajorLabelById])
  const selectedMemberBossCommentHistory = useMemo(() => {
    if (!selectedMember) return []
    const rows = Array.isArray(supervisorEvalByEmployee?.[selectedMember.id]?.commentHistory)
      ? supervisorEvalByEmployee[selectedMember.id].commentHistory
      : []
    return [...rows].sort((a, b) => String(b?.createdAt ?? '').localeCompare(String(a?.createdAt ?? '')))
  }, [selectedMember, supervisorEvalByEmployee])
  const addBossCommentForSelectedMember = useCallback(() => {
    if (!selectedMember || !setSupervisorEvalByEmployee) return
    const comment = String(bossCommentDraft ?? '').trim()
    if (!comment) return
    const majorCategoryKey = String(bossCommentDraftMajor ?? '').trim()
    const now = new Date().toISOString()
    setSupervisorEvalByEmployee((prev) => {
      const current = prev?.[selectedMember.id] ?? { scores: {}, comments: {}, commentHistory: [] }
      const history = Array.isArray(current.commentHistory) ? current.commentHistory : []
      return {
        ...(prev ?? {}),
        [selectedMember.id]: {
          ...current,
          commentHistory: [
            ...history,
            {
              id: `boss-comment-${selectedMember.id}-${Date.now()}`,
              comment,
              majorCategoryKey,
              createdAt: now,
            },
          ],
        },
      }
    })
    setBossCommentDraft('')
  }, [selectedMember, setSupervisorEvalByEmployee, bossCommentDraft, bossCommentDraftMajor])
  const removeBossCommentForSelectedMember = useCallback(
    (commentId) => {
      const id = String(commentId ?? '').trim()
      if (!selectedMember || !setSupervisorEvalByEmployee || !id) return
      setSupervisorEvalByEmployee((prev) => {
        const current = prev?.[selectedMember.id]
        if (!current) return prev
        const history = Array.isArray(current.commentHistory) ? current.commentHistory : []
        return {
          ...(prev ?? {}),
          [selectedMember.id]: {
            ...current,
            commentHistory: history.filter((h) => String(h?.id ?? '').trim() !== id),
          },
        }
      })
    },
    [selectedMember, setSupervisorEvalByEmployee],
  )
  const execCommentMajorLabelById = useMemo(
    () => Object.fromEntries(execCommentMajorOptions.map((m) => [m.id, m.title])),
    [execCommentMajorOptions],
  )
  useEffect(() => {
    if (!execCommentMajorOptions.length) {
      setExecCommentDraftMajor('')
      return
    }
    setExecCommentDraftMajor((prev) => {
      if (prev && execCommentMajorLabelById[prev]) return prev
      return execCommentMajorOptions[0].id
    })
  }, [execCommentMajorOptions, execCommentMajorLabelById])
  const selectedMemberExecCommentHistory = useMemo(() => {
    if (!selectedMember) return []
    const rows = Array.isArray(executiveEvalByEmployee?.[selectedMember.id]?.commentHistory)
      ? executiveEvalByEmployee[selectedMember.id].commentHistory
      : []
    return [...rows].sort((a, b) => String(b?.createdAt ?? '').localeCompare(String(a?.createdAt ?? '')))
  }, [selectedMember, executiveEvalByEmployee])
  const addExecutiveCommentForSelectedMember = useCallback(() => {
    if (!selectedMember || !setExecutiveEvalByEmployee) return
    const comment = String(execCommentDraft ?? '').trim()
    if (!comment) return
    const majorCategoryKey = String(execCommentDraftMajor ?? '').trim()
    const now = new Date().toISOString()
    setExecutiveEvalByEmployee((prev) => {
      const current = prev?.[selectedMember.id] ?? { baseScore: 0, baseByMajor: {}, commentHistory: [], scores: {}, comments: {} }
      const history = Array.isArray(current.commentHistory) ? current.commentHistory : []
      return {
        ...(prev ?? {}),
        [selectedMember.id]: {
          ...current,
          commentHistory: [
            ...history,
            {
              id: `exec-comment-${selectedMember.id}-${Date.now()}`,
              delta: 0,
              comment,
              majorCategoryKey,
              createdAt: now,
            },
          ],
        },
      }
    })
    setExecCommentDraft('')
  }, [selectedMember, setExecutiveEvalByEmployee, execCommentDraft, execCommentDraftMajor])
  const removeExecutiveCommentForSelectedMember = useCallback(
    (commentId) => {
      const id = String(commentId ?? '').trim()
      if (!selectedMember || !setExecutiveEvalByEmployee || !id) return
      setExecutiveEvalByEmployee((prev) => {
        const current = prev?.[selectedMember.id]
        if (!current) return prev
        const history = Array.isArray(current.commentHistory) ? current.commentHistory : []
        return {
          ...(prev ?? {}),
          [selectedMember.id]: {
            ...current,
            commentHistory: history.filter((h) => String(h?.id ?? '').trim() !== id),
          },
        }
      })
    },
    [selectedMember, setExecutiveEvalByEmployee],
  )
  const selectedMemberSelfSubmittedForActive = useMemo(() => {
    if (!selectedMember) return false
    const periodKey = String(selectedMemberEffectivePeriodKey ?? '').trim()
    if (!periodKey) return false
    const submittedRaw = Boolean(String(selfEvalHistoryByEmployee?.[selectedMember.id]?.[periodKey]?.submittedAt ?? '').trim())
    return submittedRaw || isSelfEvalDeadlineLockedForPeriod(evalPeriodDefinitions, periodKey)
  }, [selectedMember, selectedMemberEffectivePeriodKey, selfEvalHistoryByEmployee, evalPeriodDefinitions])
  const selectedMemberPeerSelfEvalForActive = useMemo(() => {
    if (!selectedMember) return { scores: {}, comments: {} }
    const periodKey = String(selectedMemberEffectivePeriodKey ?? '').trim()
    const empId = String(selectedMember.id ?? '').trim()
    if (!empId) return { scores: {}, comments: {} }
    const histSlot = periodKey ? selfEvalHistoryByEmployee?.[empId]?.[periodKey] : null
    if (histSlot && typeof histSlot === 'object') {
      return {
        scores: { ...(histSlot?.scores ?? {}) },
        comments: { ...(histSlot?.comments ?? {}) },
      }
    }
    return { scores: {}, comments: {} }
  }, [selectedMember, selectedMemberEffectivePeriodKey, selfEvalHistoryByEmployee])
  const selectedMemberSupervisorSubmittedForActive = useMemo(() => {
    if (!selectedMember) return false
    const periodKey = selectedMemberEffectivePeriodKey
    if (!periodKey) return false
    return Boolean(String(supervisorEvalHistoryByEmployee?.[selectedMember.id]?.[periodKey]?.submittedAt ?? '').trim())
  }, [selectedMember, selectedMemberEffectivePeriodKey, supervisorEvalHistoryByEmployee])
  const selectedMemberSupervisorSubmissionWithdrawalsUsed = useMemo(() => {
    if (!selectedMember) return 0
    const periodKey = String(selectedMemberEffectivePeriodKey ?? '').trim()
    if (!periodKey) return 0
    return clampEvalSubmissionWithdrawalsUsed(
      supervisorEvalHistoryByEmployee?.[selectedMember.id]?.[periodKey]?.submissionWithdrawalsUsed,
    )
  }, [selectedMember, selectedMemberEffectivePeriodKey, supervisorEvalHistoryByEmployee])
  const selectedMemberSupervisorDeadlineLocked = useMemo(
    () => isSupervisorEvalDeadlineLockedForPeriod(evalPeriodDefinitions, selectedMemberEffectivePeriodKey),
    [evalPeriodDefinitions, selectedMemberEffectivePeriodKey],
  )
  const selectedMemberSelfEvalSubmittedRaw = useMemo(() => {
    if (!selectedMember) return false
    const pk = String(selectedMemberEffectivePeriodKey ?? '').trim()
    if (!pk) return false
    return Boolean(String(selfEvalHistoryByEmployee?.[selectedMember.id]?.[pk]?.submittedAt ?? '').trim())
  }, [selectedMember, selectedMemberEffectivePeriodKey, selfEvalHistoryByEmployee])
  const selectedMemberSelfSubmissionWithdrawalsUsed = useMemo(() => {
    if (!selectedMember) return 0
    const pk = String(selectedMemberEffectivePeriodKey ?? '').trim()
    if (!pk) return 0
    return clampEvalSubmissionWithdrawalsUsed(
      selfEvalHistoryByEmployee?.[selectedMember.id]?.[pk]?.submissionWithdrawalsUsed,
    )
  }, [selectedMember, selectedMemberEffectivePeriodKey, selfEvalHistoryByEmployee])
  const selectedMemberSelfDeadlineLockedForPeriod = useMemo(
    () => isSelfEvalDeadlineLockedForPeriod(evalPeriodDefinitions, selectedMemberEffectivePeriodKey),
    [evalPeriodDefinitions, selectedMemberEffectivePeriodKey],
  )
  const selectedMemberGoalSubmittedRaw = useMemo(() => {
    if (!selectedMember) return false
    const pk = String(selectedMemberEffectivePeriodKey ?? '').trim()
    if (!pk) return false
    return Boolean(String(goalSubmissionByEmployee?.[selectedMember.id]?.[pk]?.submittedAt ?? '').trim())
  }, [selectedMember, selectedMemberEffectivePeriodKey, goalSubmissionByEmployee])
  const selectedMemberGoalSubmissionWithdrawalsUsed = useMemo(() => {
    if (!selectedMember) return 0
    const pk = String(selectedMemberEffectivePeriodKey ?? '').trim()
    if (!pk) return 0
    return clampEvalSubmissionWithdrawalsUsed(
      goalSubmissionByEmployee?.[selectedMember.id]?.[pk]?.submissionWithdrawalsUsed,
    )
  }, [selectedMember, selectedMemberEffectivePeriodKey, goalSubmissionByEmployee])
  const selectedMemberPeerSupervisorEvalForActive = useMemo(() => {
    if (!selectedMember) return { scores: {}, comments: {} }
    const periodKey = String(selectedMemberEffectivePeriodKey ?? '').trim()
    const empId = String(selectedMember.id ?? '').trim()
    if (!empId) return { scores: {}, comments: {} }
    const histSlot = periodKey ? supervisorEvalHistoryByEmployee?.[empId]?.[periodKey] : null
    if (histSlot && typeof histSlot === 'object') {
      return {
        scores: { ...(histSlot?.scores ?? {}) },
        comments: { ...(histSlot?.comments ?? {}) },
      }
    }
    return { scores: {}, comments: {} }
  }, [
    selectedMember,
    selectedMemberEffectivePeriodKey,
    supervisorEvalHistoryByEmployee,
  ])
  const selectedMemberExecutiveSubmittedForActive = useMemo(() => {
    if (!selectedMember) return false
    const periodKey = selectedMemberEffectivePeriodKey
    if (!periodKey) return false
    return Boolean(String(executiveEvalHistoryByEmployee?.[selectedMember.id]?.[periodKey]?.submittedAt ?? '').trim())
  }, [selectedMember, selectedMemberEffectivePeriodKey, executiveEvalHistoryByEmployee])
  const selectedMemberGoals = useMemo(() => {
    if (!selectedMember) return []
    const periodKey = String(selectedMemberEffectivePeriodKey ?? '').trim()
    if (!periodKey) return []
    return goalsByEmployeePeriod?.[selectedMember.id]?.[periodKey] ?? []
  }, [selectedMember, selectedMemberEffectivePeriodKey, goalsByEmployeePeriod])
  const selectedMemberGoalDirection = useMemo(() => {
    if (!selectedMember) return ''
    const periodKey = String(selectedMemberEffectivePeriodKey ?? '').trim()
    if (!periodKey) return ''
    return String(goalDirectionByEmployeePeriod?.[selectedMember.id]?.[periodKey] ?? '').trim()
  }, [selectedMember, selectedMemberEffectivePeriodKey, goalDirectionByEmployeePeriod])
  const selectedMemberGoalFocusMajorKey = useMemo(() => {
    if (!selectedMember) return ''
    const periodKey = String(selectedMemberEffectivePeriodKey ?? '').trim()
    if (!periodKey) return ''
    return String(goalFocusMajorByEmployeePeriod?.[selectedMember.id]?.[periodKey] ?? '').trim()
  }, [selectedMember, selectedMemberEffectivePeriodKey, goalFocusMajorByEmployeePeriod])
  const selectedMemberGoalCount = selectedMemberGoals.length
  const selectedMemberEvalHistoryRows = useMemo(() => {
    if (detailTab !== 'history') return []
    if (!selectedMember) return []
    const empId = selectedMember.id
    const selfPeriods = Object.keys(selfEvalHistoryByEmployee?.[empId] ?? {})
    const bossPeriods = Object.keys(supervisorEvalHistoryByEmployee?.[empId] ?? {})
    const periodKeys = [...new Set([...selfPeriods, ...bossPeriods])].sort(compareEvalPeriodDesc)
    const cumulativeExecState = executiveEvalByEmployee?.[empId] ?? executiveEvalHistoryByEmployee?.[empId]?.cumulative
    const execScore = (state) => {
      if (!state) return null
      return executiveScore100ForState(state, evaluationCriteria, selectedMember?.grade)
    }
    const rawRows = periodKeys.map((periodKey) => {
      const selfState = selfEvalHistoryByEmployee?.[empId]?.[periodKey]
      const selfGrade = String(selfState?.evalGrade ?? selectedMember?.grade ?? '').trim()
      const selfCategories = buildEvalCategoriesForGrade(evaluationCriteria, selfGrade)
      const self100 = weightedEvalScore100ByCategories(selfCategories, selfState?.scores ?? {})
      const bossState = supervisorEvalHistoryByEmployee?.[empId]?.[periodKey]
      const bossGrade = String(bossState?.evalGrade ?? selectedMember?.grade ?? '').trim()
      const bossCategories = buildEvalCategoriesForGrade(evaluationCriteria, bossGrade)
      const boss100 = weightedEvalScore100ByCategories(bossCategories, bossState?.scores ?? {})
      const exec100 = execScore(cumulativeExecState)
      return {
        periodKey,
        self100,
        boss100,
        exec100,
        selfLabel: self100 == null ? '—' : `${self100.toFixed(1)}点`,
        bossLabel: boss100 == null ? '—' : `${boss100.toFixed(1)}点`,
        execLabel: exec100 == null ? '—' : `${exec100.toFixed(1)}点`,
      }
    })
    const deltaLabel = (now, prev) => {
      if (!Number.isFinite(now) || !Number.isFinite(prev)) return '—'
      const d = now - prev
      if (Math.abs(d) < 0.05) return '±0.0'
      return `${d > 0 ? '+' : ''}${d.toFixed(1)}`
    }
    return rawRows.map((row, i) => {
      const prev = rawRows[i + 1]
      return {
        ...row,
        selfDelta: prev ? deltaLabel(row.self100, prev.self100) : '—',
        bossDelta: prev ? deltaLabel(row.boss100, prev.boss100) : '—',
        execDelta: prev ? deltaLabel(row.exec100, prev.exec100) : '—',
      }
    })
  }, [
    detailTab,
    selectedMember,
    selfEvalHistoryByEmployee,
    supervisorEvalHistoryByEmployee,
    executiveEvalByEmployee,
    executiveEvalHistoryByEmployee,
    evaluationCriteria,
  ])

  const selectedMemberEvalHistorySummary = useMemo(() => {
    if (detailTab !== 'history') return null
    const rows = selectedMemberEvalHistoryRows
    if (!rows.length) return null
    const latest = rows[0]
    const prev = rows[1]
    const trend = (delta) => {
      const n = Number(delta)
      if (!Number.isFinite(n)) return '—'
      if (Math.abs(n) < 0.05) return '横ばい'
      return n > 0 ? '上昇' : '低下'
    }
    const parseDelta = (label) => {
      const n = Number(String(label ?? '').replace('+', ''))
      return Number.isFinite(n) ? n : NaN
    }
    const selfD = parseDelta(latest.selfDelta)
    const bossD = parseDelta(latest.bossDelta)
    const execD = parseDelta(latest.execDelta)
    const maxAbs = [
      { key: '自己評価', v: selfD },
      { key: '1次評価(上司)', v: bossD },
      { key: '経営層評価', v: execD },
    ]
      .filter((x) => Number.isFinite(x.v))
      .sort((a, b) => Math.abs(b.v) - Math.abs(a.v))[0]
    return {
      latestPeriod: latest.periodKey,
      previousPeriod: prev?.periodKey ?? null,
      selfTrend: trend(selfD),
      bossTrend: trend(bossD),
      execTrend: trend(execD),
      focusLabel: maxAbs ? `${maxAbs.key} ${maxAbs.v > 0 ? '改善' : '要確認'}（${maxAbs.v > 0 ? '+' : ''}${maxAbs.v.toFixed(1)}）` : '比較データ不足',
    }
  }, [detailTab, selectedMemberEvalHistoryRows])

  const gradeRows = useMemo(() => {
    const order = ['G6', 'G5', 'G4', 'G3', 'G2', 'G1']
    const toneMap = { G6: 'gold', G5: 'orange', G4: 'blue', G3: 'green', G2: 'purple', G1: 'gray' }
    const counts = Object.fromEntries(order.map((g) => [g, 0]))
    const statsRows = directoryRows.filter(isDirectoryRowCountedForGradeStats)
    for (const row of statsRows) {
      if (counts[row.grade] !== undefined) counts[row.grade] += 1
    }
    const total = statsRows.length || 1
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
    const statsRows = directoryRows.filter(isDirectoryRowCountedForGradeStats)
    const values = statsRows.map((r) => gradeToNum(r.grade)).filter((v) => v != null)
    if (!values.length) return '—'
    const avg = values.reduce((a, b) => a + b, 0) / values.length
    return `G${avg.toFixed(1)}`
  }, [directoryRows])

  const gradeStatsEligibleCount = useMemo(
    () => directoryRows.filter(isDirectoryRowCountedForGradeStats).length,
    [directoryRows],
  )

  const totalCount = directoryRows.length
  const activeDirectoryCount = useMemo(
    () => directoryRows.filter((row) => !isEmployeeDirectoryRetired(row)).length,
    [directoryRows],
  )
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
        if (isEmployeeDirectoryRetired(row)) return null
        if (String(row.role ?? '').trim() === '役員') return null
        const lastUpdatedRaw = skillProgressUpdatedAtByEmployee?.[row.id]
        const lastUpdatedMs = lastUpdatedRaw ? Date.parse(lastUpdatedRaw) : Number.NaN
        const hasSkillUpdateDate = Number.isFinite(lastUpdatedMs)
        const isSkillStagnated = !hasSkillUpdateDate || nowMs - lastUpdatedMs >= threeMonthsMs

        const selfDone = hasEvalScore(selfEvalByEmployee?.[row.id])
        const supervisorDone = hasEvalScore(supervisorEvalByEmployee?.[row.id])
        const self100 = weightedEvalScore100ForEmployee(selfEvalByEmployee, row, evaluationCriteria)
        const boss100 = weightedEvalScore100ForEmployee(supervisorEvalByEmployee, row, evaluationCriteria)
        const selfBossGap =
          Number.isFinite(self100) && Number.isFinite(boss100) ? Math.abs(self100 - boss100) : Number.NaN
        const execData = executiveEvalByEmployee?.[row.id]
        const execScores =
          execData?.scores && typeof execData.scores === 'object' && !Array.isArray(execData.scores) ? execData.scores : {}
        const execBase = executiveEvalOverallBaseScore(execData)
        const executiveDone = !!(
          execData &&
          (Object.keys(execScores).length > 0 ||
            execBase > 0 ||
            (Array.isArray(execData.commentHistory) && execData.commentHistory.length > 0))
        )

        const tags = []
        if (isSkillStagnated) tags.push('スキル更新停滞(3か月以上)')
        if (!selfDone) tags.push('自己評価未実施')
        if (!supervisorDone) tags.push('1次評価(上司)未実施')
        if (!executiveDone) tags.push('経営層評価未実施')
        if (Number.isFinite(selfBossGap) && selfBossGap >= SELF_BOSS_GAP_ALERT_THRESHOLD) {
          tags.push(`自己/上司の評価乖離 ${selfBossGap.toFixed(1)}点`)
          const topMajor = topSelfBossMajorGaps(row, evaluationCriteria, selfEvalByEmployee, supervisorEvalByEmployee, 2)
          for (const item of topMajor) {
            tags.push(`乖離大項目: ${item.title} ${item.gap.toFixed(1)}点`)
          }
        }
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
    evaluationCriteria,
  ])

  return (
    <>
      <section ref={adminMockTopRef} className="adminMock">
      <div className="adminMain only">
          {selectedMember ? (
          <div
            ref={adminMemberDetailDockRef}
            className="adminMemberDetailDock"
          >
              <section key={selectedMember.id} className="memberDetailWorkspace">
              <header
                className="memberDetailHero"
                id={selectedMember ? `admin-member-detail-${selectedMember.id}` : undefined}
              >
                <div className="memberDetailHeroTop">
                  <div className="memberDetailAvatar" aria-hidden>
                    👤
                  </div>
                  <div className="memberDetailHeroIdentity">
                    <div className="memberDetailHeroNameRow">
                    <h4>{selectedMember.name}</h4>
                      {hideGradeSelfEvalAndGradeStats ? null : (
                        <div
                          className="memberDetailGradeInline"
                          role="group"
                          aria-label="現在の等級"
                          title="現在の等級"
                        >
                          <span className="memberDetailGradeInlineLabel">等級</span>
                          <strong className="memberDetailGradeInlineValue">{selectedMember.grade}</strong>
                        </div>
                      )}
                    </div>
                    <p>{selectedMember.dept}</p>
                    <small>入社日: {selectedMember.joinDate || '―'}</small>
                    {selectedMemberSelfBossGapAlert ? (
                      <div className="memberDetailGapAlertWrap">
                        <p className="memberDetailGapAlert">{selectedMemberSelfBossGapAlert}</p>
                        {selectedMemberTopMajorGapLabels.map((label) => (
                          <p key={label} className="memberDetailGapAlertSub">
                            {label}
                          </p>
                        ))}
                  </div>
                    ) : null}
                </div>
                  {selectedMemberEvalRadarSeries.length > 0 ? (
                    <div className="memberDetailHeroRadar">
                      <MemberEvalRadarChart
                        series={selectedMemberEvalRadarSeries}
                        compact
                        headlineName={selectedMember.name}
                        gradeLabel={selectedMemberActiveEvalGrade}
                        headlineScore={selectedMemberWeightedTotal100}
                        activePeriodKey={selectedMemberEffectivePeriodKey}
                        highlightMajorKey={selectedMemberGoalFocusMajorKey}
                      />
                </div>
                  ) : null}
                </div>
              </header>

              <div className="memberDetailTabs">
                <button
                  type="button"
                  className={detailTab === 'skill' ? 'isActive' : ''}
                  onClick={() => switchDetailTab('skill')}
                >
                  スキル習得状況
                </button>
                {hideGradeSelfEvalAndGradeStats ? null : (
                <button
                  type="button"
                  className={detailTab === 'self' ? 'isActive' : ''}
                  onClick={() => switchDetailTab('self')}
                >
                  自己評価
                </button>
                )}
                <button
                  type="button"
                  className={detailTab === 'boss' ? 'isActive' : ''}
                  onClick={() => switchDetailTab('boss')}
                >
                  1次評価(上司)
                </button>
                <button
                  type="button"
                  className={detailTab === 'bossnote' ? 'isActive' : ''}
                  onClick={() => switchDetailTab('bossnote')}
                >
                  1次評価コメント
                </button>
                <button
                  type="button"
                  className={detailTab === 'goal' ? 'isActive' : ''}
                  onClick={() => switchDetailTab('goal')}
                >
                  目標管理
                </button>
                <button
                  type="button"
                  className={detailTab === 'history' ? 'isActive' : ''}
                  onClick={() => switchDetailTab('history')}
                >
                  評価履歴
                </button>
                {canViewExecutiveCommentEval ? (
                  <button
                    type="button"
                    className={detailTab === 'execcomments' ? 'isActive' : ''}
                    onClick={() => switchDetailTab('execcomments')}
                  >
                    2次評価(経営層)
                  </button>
                ) : null}
                {canViewExecutiveCommentEval ? (
                  <button
                    type="button"
                    className={detailTab === 'execnote' ? 'isActive' : ''}
                    onClick={() => switchDetailTab('execnote')}
                  >
                    経営層コメント
                  </button>
                ) : null}
              </div>

              <div className="memberDetailTabPanel">
                {Array.isArray(adminMemberEvalPeriodSelectOptions) &&
                adminMemberEvalPeriodSelectOptions.length > 0 ? (
                  <div className="memberDetailEvalPeriodBar">
                    <label className="memberDetailEvalPeriodField">
                      <span>評価期</span>
                      <select
                        value={selectedMemberEffectivePeriodKey}
                        onChange={(event) => {
                          const next = String(event.target.value ?? '').trim()
                          setAdminMemberPeriodKey(next)
                        }}
                        aria-label="表示する評価期"
                      >
                        {adminMemberEvalPeriodSelectOptions.map((opt) => (
                          <option key={opt.value} value={opt.value}>
                            {opt.label}
                          </option>
                        ))}
                      </select>
                    </label>
                    <p className="memberDetailEvalPeriodHint">
                      自己評価・1次評価(上司)・2次評価(経営層)はこの期のデータです。
                    </p>
                  </div>
                ) : null}
                {detailTab === 'skill' ? (
                  selectedMemberSkills.length ? (
                    <>
                      <p className="memberSkillEditHint">
                        面談などのタイミングで進捗レベルを更新できます（0＝未習得、保存は自動です）。
                      </p>
                    <ul className="memberSkillList">
                        {selectedMemberSkills.map((s) => (
                          <li key={s.id} className="memberSkillRow">
                            <div className="memberSkillRowMain">
                          <p className="memberSkillTitle">{s.title}</p>
                              <p className="memberSkillMeta">最大 Lv.{s.max}</p>
                            </div>
                            <label className="memberSkillLevelLabel">
                              <span className="memberSkillLevelLabelText">進捗</span>
                              <select
                                className="memberSkillLevelSelect"
                                value={s.current}
                                aria-label={`${s.title}の習得レベル`}
                                onChange={(event) => {
                                  if (!selectedMember || !setSkillEmployeeProgress) return
                                  const n = Math.max(
                                    0,
                                    Math.min(s.max, Math.trunc(Number(event.target.value)) || 0),
                                  )
                                  setSkillEmployeeProgress((prev) => ({
                                    ...prev,
                                    [selectedMember.id]: {
                                      ...(prev[selectedMember.id] ?? {}),
                                      [s.id]: n,
                                    },
                                  }))
                                }}
                              >
                                {Array.from({ length: s.max + 1 }, (_, lv) => (
                                  <option key={lv} value={lv}>
                                    Lv.{lv}
                                    {lv === 0 ? '（未習得）' : ''}
                                  </option>
                                ))}
                              </select>
                            </label>
                        </li>
                      ))}
                    </ul>
                    </>
                  ) : (
                    <p className="memberDetailEmpty">この等級のスキル設定がありません。</p>
                  )
                ) : null}
                {!hideGradeSelfEvalAndGradeStats && detailTab === 'self' ? (
                  <>
                    <MemberSelfEvalTab rows={selectedMemberSelfEvalRows} />
                    {typeof onWithdrawSelfEvaluation === 'function' && selectedMember && selectedMemberSelfEvalSubmittedRaw ? (
                      <div className="selfEvalSubmitBar evaluatorWithdrawBarForMember">
                        {!selectedMemberSelfDeadlineLockedForPeriod &&
                        selectedMemberSelfSubmissionWithdrawalsUsed < MAX_EVAL_SUBMISSION_WITHDRAWALS ? (
                          <>
                            <button
                              type="button"
                              className="selfEvalWithdrawBtn"
                              onClick={() =>
                                onWithdrawSelfEvaluation?.(selectedMember.id, selectedMemberEffectivePeriodKey)
                              }
                            >
                              被評価者の自己評価の提出を取り消す（あと
                              {MAX_EVAL_SUBMISSION_WITHDRAWALS - selectedMemberSelfSubmissionWithdrawalsUsed}回）
                            </button>
                            <p className="selfEvalSubmitHint selfEvalWithdrawHint">
                              評価責任者として、被評価者が提出した自己評価のロックを外し再編集できるようにします。取り消しはこの評価期で最大
                              {MAX_EVAL_SUBMISSION_WITHDRAWALS}回までです。
                            </p>
                          </>
                        ) : null}
                        {selectedMemberSelfSubmissionWithdrawalsUsed >= MAX_EVAL_SUBMISSION_WITHDRAWALS ? (
                          <p className="selfEvalSubmitHint">
                            この評価期での提出取り消しは上限（{MAX_EVAL_SUBMISSION_WITHDRAWALS}回）に達しています。
                          </p>
                        ) : null}
                        {selectedMemberSelfDeadlineLockedForPeriod ? (
                          <p className="selfEvalSubmitHint">この評価期の自己評価は締切後のため、提出の取り消しはできません。</p>
                        ) : null}
                      </div>
                    ) : null}
                  </>
                ) : null}
                {detailTab === 'boss' ? (
                  <SupervisorEvaluationPage
                    key={`admin-boss-${String(selectedMember?.id ?? '')}-${String(selectedMemberEffectivePeriodKey ?? '')}`}
                    employees={selectedMember ? [selectedMember] : []}
                    evalState={selectedMemberSupervisorEvalState}
                    setEvalState={setSelectedMemberSupervisorEvalState}
                    peerSelfEval={selectedMemberPeerSelfEvalForActive}
                    evaluationCriteria={evaluationCriteria}
                    activeEvalPeriodKey={selectedMemberEffectivePeriodKey}
                    setActiveEvalPeriodKey={setAdminMemberPeriodKey}
                    evalPeriodSelectOptions={adminMemberEvalPeriodSelectOptions}
                    evalPeriodFallbackKey={evalPeriodFallbackKey}
                    supervisorEvalHistoryByEmployee={supervisorEvalHistoryByEmployee}
                    isSubmittedForPeriod={selectedMemberSupervisorSubmittedForActive}
                    onSubmitEvaluation={() =>
                      onSubmitSupervisorEvaluation?.(selectedMember?.id, selectedMemberEffectivePeriodKey)
                    }
                    submissionWithdrawalsUsed={selectedMemberSupervisorSubmissionWithdrawalsUsed}
                    onWithdrawSubmission={() =>
                      onWithdrawSupervisorEvaluation?.(selectedMember?.id, selectedMemberEffectivePeriodKey)
                    }
                    withdrawBlockedByDeadline={selectedMemberSupervisorDeadlineLocked}
                    canEvaluate
                    blockedReason="自己評価の提出後に1次評価(上司)を入力できます。"
                    focusMajorKey={selectedMemberGoalFocusMajorKey}
                  />
                ) : null}
                {detailTab === 'goal' ? (
                  <>
                    {typeof onWithdrawGoalSubmissionForMember === 'function' && selectedMember && selectedMemberGoalSubmittedRaw ? (
                      <div className="selfEvalSubmitBar evaluatorWithdrawBarForMember">
                        {selectedMemberGoalSubmissionWithdrawalsUsed < MAX_EVAL_SUBMISSION_WITHDRAWALS ? (
                          <>
                            <button
                              type="button"
                              className="selfEvalWithdrawBtn"
                              onClick={() =>
                                onWithdrawGoalSubmissionForMember?.(selectedMember.id, selectedMemberEffectivePeriodKey)
                              }
                            >
                              被評価者の目標管理の提出を取り消す（あと
                              {MAX_EVAL_SUBMISSION_WITHDRAWALS - selectedMemberGoalSubmissionWithdrawalsUsed}回）
                            </button>
                            <p className="selfEvalSubmitHint selfEvalWithdrawHint">
                              評価責任者として、被評価者が提出した目標管理のロックを外し再編集できるようにします。取り消しはこの評価期で最大
                              {MAX_EVAL_SUBMISSION_WITHDRAWALS}回までです。
                            </p>
                          </>
                        ) : null}
                        {selectedMemberGoalSubmissionWithdrawalsUsed >= MAX_EVAL_SUBMISSION_WITHDRAWALS ? (
                          <p className="selfEvalSubmitHint">
                            この評価期での提出取り消しは上限（{MAX_EVAL_SUBMISSION_WITHDRAWALS}回）に達しています。
                          </p>
                        ) : null}
                      </div>
                    ) : null}
                    {selectedMemberGoalCount > 0 ? (
                    <>
                      {selectedMemberGoalDirection ? (
                        <section className="goalMgmtDirectionCard">
                          <h3>今期の方針目標（P: Plan）</h3>
                          <p className="goalMgmtDirectionHint">{selectedMemberGoalDirection}</p>
                        </section>
                ) : null}
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
                    </>
                  ) : (
                    selectedMemberGoalDirection ? (
                      <>
                        <section className="goalMgmtDirectionCard">
                          <h3>今期の方針目標（P: Plan）</h3>
                          <p className="goalMgmtDirectionHint">{selectedMemberGoalDirection}</p>
            </section>
                        <p className="memberDetailEmpty">この期のPDCA目標はまだありません。</p>
                      </>
                    ) : (
                      <p className="memberDetailEmpty">この期の目標管理データはまだありません。</p>
                    )
                  )}
                  </>
                ) : null}
                {detailTab === 'bossnote' ? (
                  <div className="memberDetailExecComments">
                    <article className="execEvalSection">
                      <h4>1次評価コメントを追加</h4>
                      <p className="memberDetailExecCommentsNote">
                        このコメント履歴は累積です（評価期で締めません）。点数には影響しません。
                      </p>
                      <div className="execEvalMajorSelectRow">
                        <label className="execEvalMajorField">
                          <span>対象の大項目</span>
                          <select value={bossCommentDraftMajor} onChange={(event) => setBossCommentDraftMajor(event.target.value)}>
                            {bossCommentMajorOptions.map((opt) => (
                              <option key={opt.id} value={opt.id}>
                                {opt.title}
                              </option>
                            ))}
                          </select>
                        </label>
                      </div>
                      <div className="execEvalCommentForm">
                        <input
                          type="text"
                          value={bossCommentDraft}
                          onChange={(event) => setBossCommentDraft(event.target.value)}
                          placeholder="1次評価コメントを入力"
                        />
                        <button type="button" onClick={addBossCommentForSelectedMember}>
                          追加
                        </button>
                      </div>
                    </article>
                    {selectedMemberBossCommentHistory.length ? (
                      <article className="execEvalSection">
                        <h4 className="memberDetailExecCommentsHeading">コメント履歴</h4>
                        <ul className="execEvalHistoryList memberDetailExecHistoryList">
                          {selectedMemberBossCommentHistory.map((row) => (
                            <li key={row.id} className="execEvalHistoryItem">
                              <div className="execEvalHistoryTop">
                                <span className="execEvalHistoryDate">
                                  {(() => {
                                    const d = new Date(row.createdAt)
                                    return Number.isNaN(d.getTime()) ? String(row.createdAt ?? '') : d.toLocaleString('ja-JP')
                                  })()}
                                </span>
                                <button
                                  type="button"
                                  className="execEvalDeleteBtn"
                                  onClick={() => removeBossCommentForSelectedMember(row.id)}
                                >
                                  削除
                                </button>
                              </div>
                              <p className="execEvalHistoryComment">{row.comment}</p>
                              <p className="execEvalHistoryMeta">
                                対象: {bossCommentMajorLabelById[String(row?.majorCategoryKey ?? '').trim()] ?? '未指定'}
                              </p>
                            </li>
                          ))}
                        </ul>
                      </article>
                    ) : (
                      <p className="memberDetailEmpty">1次評価コメント履歴はまだありません。</p>
                    )}
                  </div>
                ) : null}
                {canViewExecutiveCommentEval && detailTab === 'execcomments' ? (
                  <EvalQuestionnairePage
                    key={`admin-exec-${String(selectedMember?.id ?? '')}-${String(selectedMemberEffectivePeriodKey ?? '')}`}
                    variant="exec"
                    employees={selectedMember ? [selectedMember] : []}
                    evalState={selectedMemberExecutiveEvalState}
                    setEvalState={setSelectedMemberExecutiveEvalState}
                    peerSelfEval={selectedMemberPeerSelfEvalForActive}
                    peerSupervisorEval={selectedMemberPeerSupervisorEvalForActive}
                    evaluationCriteria={evaluationCriteria}
                    activeEvalPeriodKey={selectedMemberEffectivePeriodKey}
                    setActiveEvalPeriodKey={setAdminMemberPeriodKey}
                    selfEvalHistoryByEmployee={selfEvalHistoryByEmployee}
                    evalHistoryByEmployee={executiveEvalHistoryByEmployee}
                    evalPeriodSelectOptions={adminMemberEvalPeriodSelectOptions}
                    evalPeriodFallbackKey={evalPeriodFallbackKey}
                    isSubmittedForPeriod={selectedMemberExecutiveSubmittedForActive}
                    onSubmitEvaluation={() =>
                      onSubmitExecutiveEvaluation?.(selectedMember?.id, selectedMemberEffectivePeriodKey)
                    }
                    canEvaluate
                    blockedReason="自己評価と1次評価(上司)の提出後に2次評価(経営層)を入力できます。"
                    focusMajorKey={selectedMemberGoalFocusMajorKey}
                  />
                ) : null}
                {canViewExecutiveCommentEval && detailTab === 'execnote' ? (
                  <div className="memberDetailExecComments">
                    <article className="execEvalSection">
                      <h4>経営層コメントを追加</h4>
                      <p className="memberDetailExecCommentsNote">
                        このコメント履歴は累積です（評価期で締めません）。点数には影響しません。
                      </p>
                      <div className="execEvalMajorSelectRow">
                        <label className="execEvalMajorField">
                          <span>対象の大項目</span>
                          <select value={execCommentDraftMajor} onChange={(event) => setExecCommentDraftMajor(event.target.value)}>
                            {execCommentMajorOptions.map((opt) => (
                              <option key={opt.id} value={opt.id}>
                                {opt.title}
                              </option>
                            ))}
                          </select>
                        </label>
                      </div>
                      <div className="execEvalCommentForm">
                        <input
                          type="text"
                          value={execCommentDraft}
                          onChange={(event) => setExecCommentDraft(event.target.value)}
                          placeholder="経営層コメントを入力"
                        />
                        <button type="button" onClick={addExecutiveCommentForSelectedMember}>
                          追加
                        </button>
                      </div>
                    </article>
                    {selectedMemberExecCommentHistory.length ? (
                      <article className="execEvalSection">
                        <h4 className="memberDetailExecCommentsHeading">コメント履歴</h4>
                        <ul className="execEvalHistoryList memberDetailExecHistoryList">
                          {selectedMemberExecCommentHistory.map((row) => (
                            <li key={row.id} className="execEvalHistoryItem">
                              <div className="execEvalHistoryTop">
                                <span className="execEvalHistoryDate">
                                  {(() => {
                                    const d = new Date(row.createdAt)
                                    return Number.isNaN(d.getTime()) ? String(row.createdAt ?? '') : d.toLocaleString('ja-JP')
                                  })()}
                                </span>
                                <button
                                  type="button"
                                  className="execEvalDeleteBtn"
                                  onClick={() => removeExecutiveCommentForSelectedMember(row.id)}
                                >
                                  削除
                                </button>
                              </div>
                              <p className="execEvalHistoryComment">{row.comment}</p>
                              <p className="execEvalHistoryMeta">
                                対象: {execCommentMajorLabelById[String(row?.majorCategoryKey ?? '').trim()] ?? '未指定'}
                              </p>
                            </li>
                          ))}
                        </ul>
                      </article>
                    ) : (
                      <p className="memberDetailEmpty">経営層コメント履歴はまだありません。</p>
                    )}
                  </div>
                ) : null}
                {detailTab === 'history' ? (
                  <MemberHistoryTab rows={selectedMemberEvalHistoryRows} summary={selectedMemberEvalHistorySummary} />
                ) : null}
              </div>
        </section>
          </div>
        ) : null}
        <AdminDashAccordion
          id="admin-member-list"
          title="従業員一覧"
          titleMeta={`${adminFilteredMemberRows.length}人 / ${totalCount}人`}
          defaultOpen={false}
          className="adminDashAccordion--members"
        >
          <div className="adminPanel adminPanel--inAccordion">
          <div className="filters filtersAdminMember">
            <input
              type="text"
              placeholder="名前で検索..."
              value={adminMemberSearch}
              onChange={(event) => setAdminMemberSearch(event.target.value)}
            />
            <select value={adminMemberDept} onChange={(event) => setAdminMemberDept(event.target.value)}>
              <option value="">全部署</option>
              {adminDeptOptions.map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
            </select>
            {hideGradeSelfEvalAndGradeStats ? null : (
              <select value={adminMemberGrade} onChange={(event) => setAdminMemberGrade(event.target.value)}>
                <option value="">全等級</option>
                {adminGradeOptions.map((g) => (
                  <option key={g} value={g}>
                    {g}
                  </option>
                ))}
              </select>
            )}
            <select value={adminMemberEmployment} onChange={(event) => setAdminMemberEmployment(event.target.value)}>
              <option value="all">全員</option>
              <option value="active">在籍のみ</option>
              <option value="retired">退職のみ</option>
            </select>
            <select value={adminMemberSort} onChange={(event) => setAdminMemberSort(event.target.value)}>
              <option value="name">並び: 名前</option>
              <option value="id">並び: 社員C</option>
              {hideGradeSelfEvalAndGradeStats ? null : <option value="grade">並び: 等級</option>}
              <option value="retiredFirst">並び: 退職を上</option>
            </select>
          </div>
          <p className="adminMemberRetireHint">
            退職者は従業員管理で社員Cを「退職」または「退職_元のID」（例: 退職_e1）にすると、ここで「退職のみ」表示できます。
          </p>
          <div className={`memberTable${hideGradeSelfEvalAndGradeStats ? ' memberTable--yakuin' : ''}`}>
            <div className="row head">
              <span>社員C</span>
              <span>名前</span>
              <span>部署</span>
              {hideGradeSelfEvalAndGradeStats ? null : <span>等級</span>}
              <span>★数</span>
            </div>
            {adminFilteredMemberRows.map((member) => (
              <div className={`row${member.retired ? ' isRetiredMember' : ''}`} key={member.id}>
                <span className="memberIdCell" title={member.retired ? '退職扱い' : ''}>
                  {member.id}
                  {member.retired ? <em className="retiredBadge">退職</em> : null}
                </span>
                <span>
                  <button
                    type="button"
                    className={`memberNameButton ${selectedMemberId === member.id ? 'isActive' : ''}`}
                    title={`${member.name}の詳細へ移動`}
                    onClick={() => {
                      setSelectedMemberId(member.id)
                      onSelectMember?.(member.id)
                      window.requestAnimationFrame(() => {
                        window.requestAnimationFrame(() => {
                          scrollMemberDockIntoView()
                        })
                      })
                    }}
                  >
                    {member.name}
                  </button>
                </span>
                <span>{member.dept}</span>
                {hideGradeSelfEvalAndGradeStats ? null : <span>{member.grade}</span>}
                <span className="stars">★ {member.stars}</span>
              </div>
            ))}
          </div>
          </div>
        </AdminDashAccordion>

        <section className="adminOverview">
          {pendingPromotionRequests.length ? (
            <section className="promotionRequestBanner" role="status" aria-live="polite">
              <div className="promotionRequestBannerHead">
                <span className="promotionRequestBannerIcon" aria-hidden>
                  📋
                </span>
                <div>
                  <h3 className="promotionRequestBannerTitle">昇級の申請があります</h3>
                  <p className="promotionRequestBannerLead">
                    {canApprovePromotions
                      ? '管理者は、各申請に対して許可または却下をしてください。許可すると等級が更新され、スキル進捗はリセットされます。'
                      : '管理者が許可または却下するまでお待ちください。'}
                  </p>
                </div>
              </div>
              <ul className="promotionRequestList">
                {pendingPromotionRequests.map((req) => (
                  <li key={req.id} className="promotionRequestItem">
                    <div className="promotionRequestItemMain">
                      <strong>{req.employeeName}</strong>
                      <span className="promotionRequestItemMeta">
                        社員C: {req.employeeId} / {req.fromGrade} → <em>{req.toGrade}</em> /{' '}
                        {new Date(req.requestedAt).toLocaleString('ja-JP')}
                      </span>
                    </div>
                    {canApprovePromotions ? (
                      <div className="promotionRequestItemActions">
                        <button type="button" className="promotionApproveBtn" onClick={() => onApprovePromotionRequest?.(req.id)}>
                          許可
                        </button>
                        <button type="button" className="promotionRejectBtn" onClick={() => onRejectPromotionRequest?.(req.id)}>
                          却下
                        </button>
                      </div>
                    ) : null}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          <AdminDashAccordion
            id="admin-stagnation"
            title="スキルアップ停滞アラート"
            defaultOpen={false}
            className="adminDashAccordion--stagnation"
          >
            <div className="stagnationAlert stagnationAlert--accordionBody">
              <p>
                3か月以上スキル更新がない従業員、または評価（自己・上司・経営層）が未実施の従業員を表示しています。
              </p>
              {stagnationAlerts.length ? (
                stagnationAlerts.map((alert) => (
                  <article className="stagnationCard" key={alert.id}>
                    <button
                      type="button"
                      className="stagnationCardNameBtn"
                      title={`${alert.name}の詳細へ移動`}
                      onClick={() => {
                        setAdminMemberEmployment('active')
                        setAdminMemberSearch('')
                        setAdminMemberDept('')
                        if (!hideGradeSelfEvalAndGradeStats) setAdminMemberGrade('')
                        setSelectedMemberId(alert.id)
                        onSelectMember?.(alert.id)
                        window.requestAnimationFrame(() => {
                          window.requestAnimationFrame(() => {
                            scrollMemberDockIntoView()
                          })
                        })
                      }}
                    >
                      {alert.name}
                    </button>
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
            </div>
          </AdminDashAccordion>
        </section>

        {hideGradeSelfEvalAndGradeStats ? null : (
          <AdminDashAccordion
            id="admin-grade-dist"
            title="等級別人数分布"
            defaultOpen={false}
            className="adminDashAccordion--grades"
          >
            <div className="adminPanel adminPanel--inAccordion">
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
                総従業員数: <strong>{gradeStatsEligibleCount}</strong>
            </p>
            <p>
              平均等級: <strong>{averageGradeLabel}</strong>
            </p>
          </div>
            </div>
          </AdminDashAccordion>
        )}
      </div>
    </section>
      {typeof document !== 'undefined'
      ? createPortal(
          <button
            type="button"
            className={`adminMockScrollTop${adminScrollTopVisible ? ' isVisible' : ''}`}
            aria-label="評価者用の先頭へ戻る"
            title="評価者用の先頭へ"
            onClick={() => {
              adminMockTopRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
            }}
          >
            <svg className="adminMockScrollTopChevron" width="20" height="12" viewBox="0 0 20 12" aria-hidden>
              <path
                d="M3 9.5L10 2.5L17 9.5"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.25"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            <span className="adminMockScrollTopLabel">TOP</span>
          </button>,
          document.body,
        )
      : null}
  </>
  )
}

function EmployeeManagePage({
  rows,
  setRows,
  deptOptions,
  skills,
  skillProgress,
  selfEvalByEmployee,
  supervisorEvalByEmployee,
  executiveEvalByEmployee,
  evaluationCriteria,
  hideGradeAndTotalScore = false,
  onEmployeeIdRename,
  onClearSkillProgressForEmployees,
}) {
  const deptList = Array.isArray(deptOptions) && deptOptions.length > 0 ? deptOptions : DEFAULT_EMPLOYEE_DEPTS
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false)
  const [isEditModalOpen, setIsEditModalOpen] = useState(false)
  const [editingRow, setEditingRow] = useState(null)
  const [editingOriginalId, setEditingOriginalId] = useState(null)

  const closeEmployeeEditModal = () => {
    setIsEditModalOpen(false)
    setEditingRow(null)
    setEditingOriginalId(null)
  }

  const [newEmployee, setNewEmployee] = useState({
    id: '',
    name: '',
    dept: '製造',
    role: '一般従業員',
    grade: 'G1',
    password: '',
    extraMenuKeys: [],
  })

  useEffect(() => {
    setNewEmployee((prev) => {
      if (deptList.includes(prev.dept)) return prev
      return { ...prev, dept: deptList[0] ?? '製造' }
    })
  }, [deptList])

  useEffect(() => {
    setEditingRow((prev) => {
      if (!prev) return prev
      if (deptList.includes(prev.dept)) return prev
      return { ...prev, dept: deptList[0] ?? '製造' }
    })
  }, [deptList])

  const handleCreateEmployee = (event) => {
    event.preventDefault()
    if (!newEmployee.id.trim() || !newEmployee.name.trim()) return

    setRows((prev) => [
      ...prev,
      {
        id: newEmployee.id.trim(),
        name: newEmployee.name.trim(),
        dept: normalizeEmployeeDept(newEmployee.dept, deptList),
        grade: newEmployee.grade,
        score: '0.0点',
        role: newEmployee.role,
        password: newEmployee.password,
        extraMenuKeys: normalizeEmployeeExtraMenuKeys(newEmployee.extraMenuKeys),
      },
    ])
    setIsCreateModalOpen(false)
    setNewEmployee({
      id: '',
      name: '',
      dept: deptList[0] ?? '製造',
      role: '一般従業員',
      grade: 'G1',
      password: '',
      extraMenuKeys: [],
    })
  }

  const handleStartEdit = (row) => {
    setEditingOriginalId(row.id)
    setEditingRow({
      ...row,
      extraMenuKeys: normalizeEmployeeExtraMenuKeys(row?.extraMenuKeys),
    })
    setIsEditModalOpen(true)
  }

  const handleSaveEdit = (event) => {
    event.preventDefault()
    if (!editingRow || editingOriginalId == null) return

    const trimmedName = editingRow.name.trim()
    if (!trimmedName) return

    const nextId = String(editingRow.id ?? '').trim()
    if (!nextId) {
      window.alert('社員Cを入力してください。')
      return
    }
    if (nextId !== editingOriginalId && rows.some((r) => r.id === nextId)) {
      window.alert('その社員Cは既に使われています。')
      return
    }

    const prevRow = rows.find((r) => r.id === editingOriginalId)
    const normalizedEdit = {
      ...editingRow,
      id: nextId,
      name: trimmedName,
      dept: normalizeEmployeeDept(editingRow.dept, deptList),
      grade: normalizeEmployeeGrade(editingRow.grade),
      extraMenuKeys: normalizeEmployeeExtraMenuKeys(editingRow.extraMenuKeys),
      extraEvalPeriods: normalizeExtraEvalPeriodsForEmployee(prevRow ?? editingRow),
    }
    const gradeChanged =
      prevRow != null &&
      String(prevRow.grade ?? '').trim() !== String(normalizedEdit.grade ?? '').trim()
    if (nextId !== editingOriginalId) {
      onEmployeeIdRename?.(editingOriginalId, nextId)
    }
    setRows((prev) => prev.map((row) => (row.id === editingOriginalId ? { ...row, ...normalizedEdit } : row)))
    if (gradeChanged) {
      onClearSkillProgressForEmployees?.([nextId])
    }
    closeEmployeeEditModal()
  }

  const handleDeleteRow = (rowId) => {
    const shouldDelete = window.confirm(
      'この従業員の行を削除しますか？\n\n「OK」で削除、「キャンセル」で中止します。',
    )
    if (!shouldDelete) return

    setRows((prev) => prev.filter((row) => row.id !== rowId))
    if (editingRow?.id === rowId || editingOriginalId === rowId) {
      closeEmployeeEditModal()
    }
  }

  const employeeCsvFileRef = useRef(null)
  const [directoryCsvMessage, setDirectoryCsvMessage] = useState('')

  const scoreByEmployeeId = useMemo(() => {
    const out = {}
    for (const row of rows) {
      const total = overallWeightedScore100ForEmployee(row, {
        skills,
        skillProgress,
        selfEvalByEmployee,
        supervisorEvalByEmployee,
        executiveEvalByEmployee,
        evaluationCriteria,
      })
      out[row.id] = Number.isFinite(total) ? `${total.toFixed(1)}点` : '—'
    }
    return out
  }, [rows, skills, skillProgress, selfEvalByEmployee, supervisorEvalByEmployee, executiveEvalByEmployee, evaluationCriteria])

  const handleEmployeeExportCsv = () => {
    const headers = EMPLOYEE_DIRECTORY_CSV_HEADERS
    const body = rows.map((row) =>
      [
        escapeCsvField(row.id),
        escapeCsvField(row.name),
        escapeCsvField(row.dept),
        escapeCsvField(row.grade),
        escapeCsvField(scoreByEmployeeId[row.id] ?? '0.0点'),
        escapeCsvField(row.role),
        escapeCsvField(row.password ?? ''),
      ].join(','),
    )
    const csvContent = [headers.map(escapeCsvField).join(','), ...body].join('\r\n')
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

  const handleEmployeeTemplateCsv = () => {
    const csvContent = EMPLOYEE_DIRECTORY_CSV_HEADERS.map(escapeCsvField).join(',')
    const bom = '\uFEFF'
    const blob = new Blob([bom + csvContent], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = 'employees_template.csv'
    link.click()
    URL.revokeObjectURL(url)
    setDirectoryCsvMessage('ヘッダー行のみのテンプレートをダウンロードしました。2行目以降にデータを入力してインポートしてください。')
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
      const passwordIdx = findHeaderIndex(headers, ['パスワード', 'password', 'Password'])

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

        const passwordRaw = passwordIdx >= 0 ? String(cols[passwordIdx] ?? '') : ''
        const passwordTrimmed = passwordRaw.trim()

        const patch = { id, name }
        if (deptIdx >= 0 && String(cols[deptIdx] ?? '').trim()) {
          patch.dept = normalizeEmployeeDept(cols[deptIdx], deptList)
        }
        if (gradeIdx >= 0 && String(cols[gradeIdx] ?? '').trim()) {
          patch.grade = normalizeEmployeeGrade(cols[gradeIdx])
        }
        if (scoreIdx >= 0 && String(cols[scoreIdx] ?? '').trim()) {
          patch.score = normalizeEmployeeDirectoryScore(cols[scoreIdx])
        }
        if (roleIdx >= 0 && String(cols[roleIdx] ?? '').trim()) {
          patch.role = normalizeEmployeeRole(cols[roleIdx])
        }
        if (passwordTrimmed) {
          patch.password = passwordTrimmed
        }
        imported.push(patch)
      }

      if (imported.length === 0) {
        setDirectoryCsvMessage('取り込める行がありませんでした（名前は必須です）。')
        return
      }

      let csvGradeChangeClearIds = []
      setRows((prev) => {
        const filled = imported.map((imp) => {
          const exists = prev.some((r) => String(r.id) === String(imp.id))
          if (exists) return imp
          return {
            ...imp,
            dept: Object.prototype.hasOwnProperty.call(imp, 'dept') ? imp.dept : (deptList[0] ?? '製造'),
            grade: Object.prototype.hasOwnProperty.call(imp, 'grade') ? imp.grade : 'G1',
            score: Object.prototype.hasOwnProperty.call(imp, 'score') ? imp.score : '0.0点',
            role: Object.prototype.hasOwnProperty.call(imp, 'role') ? imp.role : '一般従業員',
            joinDate: imp.joinDate ?? '',
            email: imp.email ?? '',
            extraMenuKeys: normalizeEmployeeExtraMenuKeys(imp.extraMenuKeys),
          }
        })
        const { merged, employeeIdsToClearSkillProgress } = mergeEmployeeDirectoryRows(prev, filled)
        csvGradeChangeClearIds = employeeIdsToClearSkillProgress
        return merged
      })
      if (csvGradeChangeClearIds.length) {
        onClearSkillProgressForEmployees?.(csvGradeChangeClearIds)
      }
      setDirectoryCsvMessage(
        `${imported.length}件を取り込みました（同一の社員Cは上書き。空欄の列は既存の値を維持します。等級が変わった行はスキル進捗をリセットします。パスワード列が空の行は既存パスワードを維持します）。`,
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
          <button type="button" className="btn export" aria-label="CSVエクスポート" onClick={handleEmployeeExportCsv}>
            <span className="employeeToolbarBtnIcon" aria-hidden>
              <GyosekiIconDownload />
            </span>
            <span className="employeeToolbarBtnLabel">CSVエクスポート</span>
          </button>
          <button type="button" className="btn import" aria-label="CSVインポート" onClick={() => employeeCsvFileRef.current?.click()}>
            <span className="employeeToolbarBtnIcon" aria-hidden>
              <GyosekiIconUpload />
            </span>
            <span className="employeeToolbarBtnLabel">CSVインポート</span>
          </button>
          <button type="button" className="btn template" aria-label="CSVテンプレート" onClick={handleEmployeeTemplateCsv}>
            <span className="employeeToolbarBtnIcon" aria-hidden>
              <EmployeeIconTemplateCsv />
            </span>
            <span className="employeeToolbarBtnLabel">CSVテンプレート</span>
          </button>
          <input
            ref={employeeCsvFileRef}
            type="file"
            accept=".csv,text/csv"
            className="employeeCsvHiddenInput"
            onChange={handleEmployeeImportCsv}
          />
        </div>
        <button type="button" className="btn add" aria-label="新規従業員を追加" onClick={() => setIsCreateModalOpen(true)}>
          <span className="employeeToolbarBtnIcon" aria-hidden>
            <GyosekiIconPlus />
          </span>
          <span className="employeeToolbarBtnLabel">新規従業員を追加</span>
        </button>
      </div>

      {directoryCsvMessage ? <p className="employeeCsvMessage">{directoryCsvMessage}</p> : null}

      <p className="employeeCsvHeaderHint">
        <span className="employeeCsvHeaderHintLabel">CSV 1行目（ヘッダー・推奨）</span>
        <code className="employeeCsvHeaderLine">{EMPLOYEE_DIRECTORY_CSV_HEADERS.map(escapeCsvField).join(',')}</code>
        <span className="employeeCsvHeaderHintNote">
          パスワード列は任意です。空欄のまま取り込むと、既存ユーザーのパスワードは変わりません。
          退職者は社員Cを「退職」または「退職_元のID」（例: 退職_e1）にすると、評価者用の一覧で「退職のみ」表示できます。
          部署列は「設定 → 部署マスタ」に登録した名前と一致させてください（未登録の名前は先頭の部署に置き換わります）。
        </span>
      </p>

      <div className={`employeeTable${hideGradeAndTotalScore ? ' employeeTable--yakuin' : ''}`}>
        <div className="row head">
          <span>ID</span>
          <span>名前</span>
          <span>部署</span>
          {hideGradeAndTotalScore ? null : (
            <>
          <span>等級</span>
          <span>総合得点</span>
            </>
          )}
          <span>役割</span>
          <span>パスワード</span>
          <span>操作</span>
        </div>
        {rows.map((row) => {
          const isExecutive = String(row.role ?? '').trim() === '役員'
          return (
          <div className="row" key={row.id}>
            <span>{formatLoginLikeCode(row.id)}</span>
            <span>{row.name}</span>
            <span>{row.dept}</span>
              {hideGradeAndTotalScore ? null : (
                <>
                  <span className="grade">{isExecutive ? '役員' : row.grade}</span>
                  <span className="score">{isExecutive ? '役員' : scoreByEmployeeId[row.id] ?? '0.0点'}</span>
                </>
              )}
            <span>
              <em className="roleTag">{row.role}</em>
            </span>
            <span className="passwordCell">
              <span className="passwordText">{row.password ? formatLoginLikeCode(row.password) : '（未設定）'}</span>
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
          )
        })}
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
                <small>退職者は「退職」または「退職_元ID」（例: 退職_e1）を入力できます。</small>
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
                  {deptList.map((d) => (
                    <option key={d} value={d}>
                      {d}
                    </option>
                  ))}
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
                  <option>役員</option>
                  <option>管理者</option>
                </select>
              </label>

              <fieldset className="employeeExtraTabsField">
                <legend>個別表示タブ（このユーザーのみ）</legend>
                <p className="employeeExtraTabsHelp">役割設定に加えて表示するタブを複数選択できます。</p>
                <div className="employeeExtraTabsGrid">
                  {MAIN_WORKSPACE_TAB_ORDER.map((tab) => (
                    <label key={tab.key} className="employeeExtraTabsOption">
                      <input
                        type="checkbox"
                        checked={(newEmployee.extraMenuKeys ?? []).includes(tab.key)}
                        onChange={() =>
                          setNewEmployee((prev) => {
                            const list = normalizeEmployeeExtraMenuKeys(prev.extraMenuKeys)
                            const has = list.includes(tab.key)
                            const next = has ? list.filter((k) => k !== tab.key) : [...list, tab.key]
                            return { ...prev, extraMenuKeys: next }
                          })
                        }
                      />
                      <span>{tab.label}</span>
                    </label>
                  ))}
                </div>
              </fieldset>

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
        <div className="employeeModalOverlay" onClick={closeEmployeeEditModal}>
          <div className="employeeModal" onClick={(event) => event.stopPropagation()}>
            <button className="modalClose" type="button" onClick={closeEmployeeEditModal}>
              ×
            </button>
            <h3>従業員情報を編集</h3>
            <p>内容を更新して保存してください。</p>

            <form className="employeeForm" onSubmit={handleSaveEdit}>
              <label>
                社員C
                <input
                  type="text"
                  value={editingRow.id}
                  onChange={(event) => setEditingRow((prev) => ({ ...prev, id: event.target.value }))}
                  required
                />
                <small>
                  ログインIDとして使います。退職扱いは「退職」または「退職_元ID」（例: 退職_e1）。社員Cを変えるとスキル・評価・目標の紐づけを引き継ぎます。
                </small>
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
                  {deptList.map((d) => (
                    <option key={d} value={d}>
                      {d}
                    </option>
                  ))}
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
                  <option>役員</option>
                  <option>管理者</option>
                </select>
              </label>

              <fieldset className="employeeExtraTabsField">
                <legend>個別表示タブ（このユーザーのみ）</legend>
                <p className="employeeExtraTabsHelp">役割設定に加えて表示するタブを複数選択できます。</p>
                <div className="employeeExtraTabsGrid">
                  {MAIN_WORKSPACE_TAB_ORDER.map((tab) => (
                    <label key={tab.key} className="employeeExtraTabsOption">
                      <input
                        type="checkbox"
                        checked={normalizeEmployeeExtraMenuKeys(editingRow.extraMenuKeys).includes(tab.key)}
                        onChange={() =>
                          setEditingRow((prev) => {
                            const list = normalizeEmployeeExtraMenuKeys(prev?.extraMenuKeys)
                            const has = list.includes(tab.key)
                            const next = has ? list.filter((k) => k !== tab.key) : [...list, tab.key]
                            return { ...prev, extraMenuKeys: next }
                          })
                        }
                      />
                      <span>{tab.label}</span>
                    </label>
                  ))}
                </div>
              </fieldset>

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
                <button type="button" className="cancel" onClick={closeEmployeeEditModal}>
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
