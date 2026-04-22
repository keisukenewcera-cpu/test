import { useEffect, useMemo, useState } from 'react'
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

const createRow = (index) => ({
  id: Date.now() + index,
  employeeNo: '',
  employeeName: '',
  grade: 'G3',
  score: '',
  specialAllowance: '',
  note: '',
})

const STORAGE_KEY = 'performanceAllowanceAppData'
const CLOUD_STATE_ID = 'default'

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

function App() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [loginError, setLoginError] = useState('')
  const [isLoggedIn, setIsLoggedIn] = useState(false)
  const savedData = loadSavedData()
  const [rows, setRows] = useState(() => {
    const savedRows = savedData?.rows
    return Array.isArray(savedRows) && savedRows.length > 0 ? savedRows : [createRow(0), createRow(1)]
  })
  const [departmentSales, setDepartmentSales] = useState(() => savedData?.departmentSales ?? '')
  const [performanceRatePercent, setPerformanceRatePercent] = useState(
    () => savedData?.performanceRatePercent ?? '',
  )
  const [targetSpecialBonusTotal, setTargetSpecialBonusTotal] = useState(
    () => savedData?.targetSpecialBonusTotal ?? '',
  )
  const [csvMessage, setCsvMessage] = useState('')
  const [sortKey, setSortKey] = useState(() => savedData?.sortKey ?? 'employeeNo')
  const [sortOrder, setSortOrder] = useState(() => savedData?.sortOrder ?? 'asc')
  const [isCloudReady, setIsCloudReady] = useState(false)
  const [syncMessage, setSyncMessage] = useState(
    supabase ? 'Supabase同期を確認中...' : 'Supabase未設定（ローカル保存のみ）',
  )

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
      const headerIndex = (name) => headers.findIndex((header) => header === name)

      const employeeNoIdx = headerIndex('社員番号')
      const employeeNameIdx = headerIndex('社員名')
      const gradeIdx = headerIndex('等級')
      const scoreIdx = headerIndex('評価スコア')
      const specialIdx = headerIndex('特別手当')
      const noteIdx = headerIndex('備考欄')

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

          return {
            id: Date.now() + index,
            employeeNo: employeeNoIdx >= 0 ? cols[employeeNoIdx] || '' : '',
            employeeName: employeeNameIdx >= 0 ? cols[employeeNameIdx] || '' : '',
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

      setRows(importedRows)
      setCsvMessage(`${importedRows.length}件の社員データを取り込みました。`)
    } catch {
      setCsvMessage('CSVの読み込みに失敗しました。形式を確認してください。')
    } finally {
      event.target.value = ''
    }
  }

  const handleExportCsv = () => {
    const headers = [
      '社員番号',
      '社員名',
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
      row.grade,
      row.score,
      row.performanceAllowance,
      row.specialAllowance,
      row.thirdBonus,
      row.note,
    ])

    const csvContent = [headers, ...rowsForExport]
      .map((line) => line.map(escapeCsvValue).join(','))
      .join('\r\n')

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
    const salesValue = Number(departmentSales === '' ? 0 : departmentSales) || 0
    const rateValue = Number(performanceRatePercent === '' ? 0 : performanceRatePercent) || 0
    const targetTotal = Math.round(salesValue * (rateValue / 100))
    const targetSpecialTotal =
      Number(targetSpecialBonusTotal === '' ? 0 : targetSpecialBonusTotal) || 0

    const weightedRows = rows.map((row) => {
      const score = Number(row.score === '' ? 0 : row.score) || 0
      const specialAllowance = Number(row.specialAllowance === '' ? 0 : row.specialAllowance) || 0
      const gradeRate = gradeRates[row.grade] ?? 0
      const weightedScore = score * gradeRate

      return {
        ...row,
        score,
        specialAllowance,
        weightedScore,
      }
    })

    const weightedTotal = weightedRows.reduce((sum, row) => sum + row.weightedScore, 0)

    return weightedRows.map((row) => {
      const allocationRate = weightedTotal > 0 ? row.weightedScore / weightedTotal : 0
      const performanceAllowance = Math.round(allocationRate * targetTotal)
      const thirdBonus = Math.round(allocationRate * targetSpecialTotal)

      return {
        ...row,
        performanceAllowance,
        thirdBonus,
      }
    })
  }, [rows, departmentSales, performanceRatePercent, targetSpecialBonusTotal])

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
      if (sortKey === 'performanceAllowance')
        return (a.performanceAllowance - b.performanceAllowance) * direction
      if (sortKey === 'thirdBonus') return (a.thirdBonus - b.thirdBonus) * direction
      if (sortKey === 'grade') return (gradeRates[a.grade] - gradeRates[b.grade]) * direction

      return toString(a[sortKey]).localeCompare(toString(b[sortKey]), 'ja') * direction
    })
  }, [computedRows, sortKey, sortOrder])

  const salesValue = Number(departmentSales === '' ? 0 : departmentSales) || 0
  const rateValue = Number(performanceRatePercent === '' ? 0 : performanceRatePercent) || 0
  const targetTotalValue = Math.round(salesValue * (rateValue / 100))
  const targetSpecialTotalValue =
    Number(targetSpecialBonusTotal === '' ? 0 : targetSpecialBonusTotal) || 0
  const totalGap = targetTotalValue - totals.performanceAllowance
  const specialTotalGap = targetSpecialTotalValue - totals.thirdBonus

  const formatJPY = (value) =>
    new Intl.NumberFormat('ja-JP', {
      style: 'currency',
      currency: 'JPY',
      maximumFractionDigits: 0,
    }).format(value)

  const handleLogin = (event) => {
    event.preventDefault()

    const normalizedEmail = email.trim().toLowerCase()
    if (normalizedEmail === 'admin@example.com' && password === 'password123') {
      setIsLoggedIn(true)
      setLoginError('')
      return
    }

    setLoginError('メールアドレスまたはパスワードが違います。')
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
        const cloudRows = Array.isArray(payload.rows) && payload.rows.length > 0 ? payload.rows : null
        if (cloudRows) setRows(cloudRows)
        if (typeof payload.departmentSales === 'string') setDepartmentSales(payload.departmentSales)
        if (typeof payload.performanceRatePercent === 'string') {
          setPerformanceRatePercent(payload.performanceRatePercent)
        }
        if (typeof payload.targetSpecialBonusTotal === 'string') {
          setTargetSpecialBonusTotal(payload.targetSpecialBonusTotal)
        }
        if (typeof payload.sortKey === 'string') setSortKey(payload.sortKey)
        if (payload.sortOrder === 'asc' || payload.sortOrder === 'desc') setSortOrder(payload.sortOrder)
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
      JSON.stringify({
        rows,
        departmentSales,
        performanceRatePercent,
        targetSpecialBonusTotal,
        sortKey,
        sortOrder,
      }),
    )
  }, [rows, departmentSales, performanceRatePercent, targetSpecialBonusTotal, sortKey, sortOrder])

  useEffect(() => {
    if (!supabase || !isCloudReady) return

    const payload = {
      rows,
      departmentSales,
      performanceRatePercent,
      targetSpecialBonusTotal,
      sortKey,
      sortOrder,
    }

    setSyncMessage('Supabaseに保存中...')
    const timer = window.setTimeout(async () => {
      const { error } = await supabase
        .from('app_state')
        .upsert({ id: CLOUD_STATE_ID, payload }, { onConflict: 'id' })

      if (error) {
        setSyncMessage('Supabase保存失敗（ローカル保存は有効）')
        return
      }
      setSyncMessage('Supabaseに保存済み')
    }, 600)

    return () => window.clearTimeout(timer)
  }, [
    rows,
    departmentSales,
    performanceRatePercent,
    targetSpecialBonusTotal,
    sortKey,
    sortOrder,
    isCloudReady,
  ])

  return (
    <main className="app">
      <section className="card">
        {!isLoggedIn ? (
          <>
            <p className="eyebrow">Performance Suite</p>
            <h1>ログイン</h1>
            <p className="description">業績手当シミュレーターを利用するにはログインしてください。</p>

            <form className="loginForm" onSubmit={handleLogin}>
              <label>
                メールアドレス
                <input
                  type="email"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  placeholder="admin@example.com"
                  required
                />
              </label>

              <label>
                パスワード
                <input
                  type="password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  placeholder="password123"
                  required
                />
              </label>

              {loginError ? <p className="errorMessage">{loginError}</p> : null}

              <button type="submit" className="primaryButton">
                ログイン
              </button>
            </form>
          </>
        ) : (
          <>
            <div className="cardHeader">
              <div>
                <p className="eyebrow">Performance Suite</p>
                <h1>業績手当管理ページ</h1>
                <p className="description">
                  社員ごとに評価スコアを入力すると業績手当と第3回目賞与を自動計算します。
                </p>
                <div className="targetPanel">
                  <div className="targetFields">
                    <label className="targetLabel">
                      部門売上
                      <input
                        type="text"
                        inputMode="numeric"
                        value={departmentSales === '' ? '' : formatJPY(Number(departmentSales))}
                        onChange={(event) =>
                          setDepartmentSales(
                            sanitizeIntegerInput(event.target.value),
                          )
                        }
                        placeholder="売上を入力"
                      />
                    </label>
                    <label className="targetLabel">
                      業績手当率 (%)
                      <input
                        type="text"
                        inputMode="numeric"
                        value={performanceRatePercent}
                        onChange={(event) =>
                          setPerformanceRatePercent(
                            sanitizeIntegerInput(event.target.value),
                          )
                        }
                        placeholder="例: 12"
                      />
                    </label>
                    <label className="targetLabel">
                      業績手当総額 (部門売上×率)
                      <input type="text" value={formatJPY(targetTotalValue)} readOnly />
                    </label>
                    <label className="targetLabel">
                      特別賞与総額
                      <input
                        type="text"
                        inputMode="numeric"
                        value={
                          targetSpecialBonusTotal === ''
                            ? ''
                            : formatJPY(Number(targetSpecialBonusTotal))
                        }
                        onChange={(event) =>
                          setTargetSpecialBonusTotal(
                            sanitizeIntegerInput(event.target.value),
                          )
                        }
                        placeholder="総額を入力"
                      />
                    </label>
                  </div>
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
                </div>
              </div>
              <button type="button" className="secondaryButton" onClick={() => setIsLoggedIn(false)}>
                ログアウト
              </button>
            </div>

            <div className="actionRow">
              <div className="sortControls">
                <label className="sortLabel">
                  並び替え
                  <select value={sortKey} onChange={(event) => setSortKey(event.target.value)}>
                    <option value="employeeNo">社員番号</option>
                    <option value="employeeName">社員名</option>
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
                CSV取込
                <input type="file" accept=".csv" onChange={handleImportCsv} />
              </label>
              <button type="button" className="csvExportButton" onClick={handleExportCsv}>
                CSV掃き出し
              </button>
            </div>
            <p className="syncMessage">{syncMessage}</p>
            {csvMessage ? <p className="csvMessage">{csvMessage}</p> : null}

            <div className="tableWrap">
              <table className="allowanceTable">
                <colgroup>
                  <col className="colEmployeeNo" />
                  <col className="colEmployeeName" />
                  <col className="colGrade" />
                  <col className="colScore" />
                  <col className="colMoney" />
                  <col className="colMoney" />
                  <col className="colMoney" />
                  <col className="colNote" />
                  <col className="colAction" />
                </colgroup>
                <thead>
                  <tr>
                    <th>社員番号</th>
                    <th>社員名</th>
                    <th>等級</th>
                    <th>評価スコア</th>
                    <th>業績手当</th>
                    <th>特別手当</th>
                    <th>第3回目賞与</th>
                    <th>備考欄</th>
                    <th>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {sortedRows.map((row) => (
                    <tr key={row.id}>
                      <td>
                        <input
                          type="text"
                          value={row.employeeNo}
                          onChange={(event) => updateRow(row.id, 'employeeNo', event.target.value)}
                          placeholder="1001"
                        />
                      </td>
                      <td>
                        <input
                          type="text"
                          value={row.employeeName}
                          onChange={(event) => updateRow(row.id, 'employeeName', event.target.value)}
                          placeholder="山田 太郎"
                        />
                      </td>
                      <td>
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
                      </td>
                      <td>
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
                      </td>
                      <td className="moneyCell">{formatJPY(row.performanceAllowance)}</td>
                      <td>
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
                      </td>
                      <td className="moneyCell">{formatJPY(row.thirdBonus)}</td>
                      <td>
                        <input
                          type="text"
                          value={row.note}
                          onChange={(event) => updateRow(row.id, 'note', event.target.value)}
                          placeholder="備考"
                        />
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
              計算式: 業績手当 = (個人のスコア×等級係数) ÷ 全体の(スコア×係数合計) × 業績手当総額,
              第3回目賞与 = (個人のスコア×等級係数) ÷ 全体の(スコア×係数合計) × 特別賞与総額
            </p>
          </>
        )}
      </section>
    </main>
  )
}

export default App
