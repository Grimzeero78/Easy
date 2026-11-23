import type { ColumnMoneyTotal, MoneyTotals } from './types'

/**
 * Money engine — detects monetary columns in extracted data and sums them up.
 *
 * The user-facing contract: "sum up all the money and give me the total in
 * column number or name". Every detected money column is reported BOTH by its
 * 1-based column number (same numbering as the header row in every export)
 * and by its column name.
 *
 * Design rules (mirrors the platform's product rules):
 * - Never guess: unreadable / non-money values are skipped and REPORTED
 *   (with samples), never approximated or silently dropped.
 * - Missing values are counted separately from skipped ones.
 * - Duplicate rows are summed twice in `total` (they are part of the exported
 *   data) but `uniqueTotal` excludes them so double-counting is visible.
 * - Mixed currencies are never silently added into one grand total.
 *
 * This module is pure and isomorphic: it must stay free of Node/browser/Worker
 * APIs so the exact same logic runs in the Next.js server, the browser UI and
 * the Cloudflare Worker.
 */

/* ------------------------------------------------------------------ */
/* Currency tokens                                                     */
/* ------------------------------------------------------------------ */

/** Currency marker -> canonical code. Longest/most specific first when matching. */
const CURRENCY_MAP: Record<string, string> = {
  // East Africa + Africa (common in cash sheets / receipts)
  ksh: 'KES', 'kenya shillings': 'KES', kes: 'KES', shilingi: 'KES',
  tsh: 'TZS', tzs: 'TZS', 'tanzania shillings': 'TZS',
  ush: 'UGX', ugx: 'UGX', 'uganda shillings': 'UGX',
  rwf: 'RWF', frw: 'RWF',
  zar: 'ZAR', rand: 'ZAR',
  'gh¢': 'GHS', ghs: 'GHS', cedis: 'GHS',
  ngn: 'NGN', naira: 'NGN',
  // International
  usd: 'USD', eur: 'EUR', gbp: 'GBP', jpy: 'JPY', cny: 'CNY', rmb: 'CNY',
  inr: 'INR', aud: 'AUD', cad: 'CAD', chf: 'CHF',
  aed: 'AED', sar: 'SAR', qar: 'QAR', kwd: 'KWD', bhd: 'BHD', omr: 'OMR',
}

const CURRENCY_SYMBOLS: Record<string, string> = {
  $: 'USD', '€': 'EUR', '£': 'GBP', '¥': 'JPY', '₹': 'INR', '₦': 'NGN', '₱': 'PHP',
}

/** Tokens sorted longest-first so "ksh" wins over "sh" etc. */
const ALL_CURRENCY_KEYS = [
  ...Object.keys(CURRENCY_MAP),
  ...Object.keys(CURRENCY_SYMBOLS),
].sort((a, b) => b.length - a.length)

/** Column-name hints that strongly suggest a money column. */
const MONEY_NAME_RE =
  /(^|\W)(amount|amounts|total|totals|grand|sum|price|prices|cost|costs|value|values|fee|fees|charge|charges|paid|payment|payments|pay|balance|salary|salaries|wage|wages|revenue|income|expense|expenses|net|gross|sub\s?total|subtotal|money|cash|bill|bills|amount\s?due|unit\s?price|discount|tax|vat|usd|kes|ksh|tzs|ugx|rwf|zar|ngn|ghs|inr|eur|gbp|shilling|shillings|shs)(\W|$)/i

/* ------------------------------------------------------------------ */
/* Parsing                                                             */
/* ------------------------------------------------------------------ */

export interface ParsedMoney {
  value: number
  /** Canonical currency code when a marker was present in the text. */
  currency: string | null
  /**
   * Strong evidence this text is really money (currency marker, decimal
   * amount or thousands separators) — vs. a bare integer that could be a
   * quantity, a year or an ID number.
   */
  strong: boolean
}

/**
 * Parse a money-ish string. Returns null when the text cannot be interpreted
 * as an amount of money.
 *
 * Accepts: "1,234.56" · "KSh 1,500" · "1500/=" · "$1,200.50" · "EUR 99" ·
 * "1 500,00" · "(1,200)" (accounting negative) · "-250" · "250.00 ksh".
 * Rejects: IDs, phone numbers, dates, plain words, ranges.
 */
export function parseMoney(raw: string | null | undefined): ParsedMoney | null {
  if (raw == null) return null
  let s = String(raw).trim()
  if (!s) return null
  s = s.replace(/\u00A0/g, ' ').replace(/\u2013|\u2014/g, '-')

  // accounting negative: (1,200.00)
  let negative = false
  if (/^\(.*\)$/.test(s)) {
    negative = true
    s = s.slice(1, -1).trim()
  }

  // strip East-African style trailing marks: 1500/= , 1500/- , 1500=
  s = s.replace(/[=/-]+\s*$/, '').trim()
  if (!s) return null

  // currency marker (prefix or suffix)
  let currency: string | null = null
  let core = s
  const escKey = (k: string) => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const CURRENCY_RES = ALL_CURRENCY_KEYS.map((key) => ({
    key,
    pre: new RegExp(`^${escKey(key)}\\s*\\.?\\s*`, 'i'),
    suf: new RegExp(`\\s*\\.?\\s*${escKey(key)}$`, 'i'),
  }))
  const tryStrip = (txt: string): string => {
    for (const { key, pre, suf } of CURRENCY_RES) {
      if (pre.test(txt)) {
        currency = CURRENCY_MAP[key] ?? CURRENCY_SYMBOLS[key] ?? null
        return txt.replace(pre, '').trim()
      }
      if (suf.test(txt) && txt.length > key.length) {
        currency = CURRENCY_MAP[key] ?? CURRENCY_SYMBOLS[key] ?? null
        return txt.replace(suf, '').trim()
      }
    }
    return txt
  }
  core = tryStrip(core)

  // negative sign (after currency strip so "-KSh 100" also works)
  if (/^-/.test(core)) {
    negative = true
    core = core.slice(1).trim()
  }
  if (!core) return null

  // strip thousands separators and spacing, honoring BOTH decimal conventions:
  // "1,234.56" / "1 500" (dot or space grouping) and "1.234,56" / "1 500,00"
  // (comma decimal). The LAST separator wins as the decimal point; every
  // other separator is grouping.
  const normalized = normalizeNumber(core)
  if (!/^\d+(\.\d{1,4})?$/.test(normalized.num)) return null

  // Phone numbers / long account numbers: leading zero + 9+ digits without a
  // currency marker is almost never money on a document.
  if (currency == null && /^0\d{8,}$/.test(normalized.num)) return null

  const value = Number(normalized.num)
  if (!isFinite(value)) return null
  if (Math.abs(value) >= 1e13) return null // implausible for a document amount

  const strong = currency != null || normalized.hadDecimals || normalized.hadSeparators

  return { value: (negative ? -value : value), currency, strong }
}

/** Grouping/decimal-separator normalization used by parseMoney. */
function normalizeNumber(core: string): { num: string; hadSeparators: boolean; hadDecimals: boolean } {
  const hadSeparators = /[\d][, ]\d/.test(core)
  const lastComma = core.lastIndexOf(',')
  const lastDot = core.lastIndexOf('.')
  let dec: string
  if (lastComma >= 0 && lastDot >= 0) dec = lastComma > lastDot ? ',' : '.'
  else if (lastComma >= 0) dec = /,\d{1,2}$/.test(core) ? ',' : ''
  else if (lastDot >= 0) dec = '.'
  else dec = ''

  let num: string
  let hadDecimals = false
  if (dec) {
    const idx = core.lastIndexOf(dec)
    const intPart = core.slice(0, idx).replace(/[,\s]/g, '')
    const fracPart = core.slice(idx + 1)
    num = `${intPart}.${fracPart}`
    hadDecimals = /\d/.test(fracPart) && !/^0+$/.test(fracPart)
  } else {
    num = core.replace(/[,\s]/g, '')
  }
  return { num, hadSeparators, hadDecimals }
}

/* ------------------------------------------------------------------ */
/* Column detection + totals                                           */
/* ------------------------------------------------------------------ */

export interface MoneyRecord {
  values: Record<string, string | null>
  duplicate: boolean
}

/** Heuristic: how much of a column looks like money. */
function analyzeColumn(columnName: string, values: (string | null)[]) {
  const nonEmpty = values.filter((v) => v != null && String(v).trim() !== '')
  let parseable = 0
  let strong = 0
  const currencies = new Map<string, number>()
  for (const v of nonEmpty) {
    const m = parseMoney(v)
    if (m) {
      parseable++
      if (m.strong) strong++
      if (m.currency) currencies.set(m.currency, (currencies.get(m.currency) ?? 0) + 1)
    }
  }
  return {
    nonEmptyCount: nonEmpty.length,
    parseableCount: parseable,
    strongCount: strong,
    parseableRatio: nonEmpty.length ? parseable / nonEmpty.length : 0,
    strongRatio: nonEmpty.length ? strong / nonEmpty.length : 0,
    nameHint: MONEY_NAME_RE.test(columnName),
    currencies,
  }
}

/**
 * Compute money totals for a whole job.
 *
 * @param columns column names in header order (index 0 => column number 1)
 * @param records extracted records (page/row order, duplicates flagged)
 */
export function computeMoneyTotals(columns: string[], records: MoneyRecord[]): MoneyTotals {
  const warnings: string[] = []
  const columnWarnings: string[] = []
  const totals: ColumnMoneyTotal[] = []

  columns.forEach((col, idx) => {
    const values = records.map((r) => r.values[col] ?? null)
    const a = analyzeColumn(col, values)
    if (a.nonEmptyCount === 0) return

    // Detection rules (conservative — better to miss a column than to sum IDs):
    const isMoney =
      (a.nameHint && a.parseableRatio >= 0.4 && a.parseableCount >= 1) ||
      (!a.nameHint && a.strongRatio >= 0.6 && a.strongCount >= 2)
    if (!isMoney) return

    let total = 0
    let uniqueTotal = 0
    let counted = 0
    let missingCount = 0
    let skippedCount = 0
    let duplicateCounted = 0
    let uniqueCounted = 0
    const skipped: string[] = []
    const currencies = new Map<string, number>()

    // Single pass over the column, aligned to the records array by index so
    // duplicate exclusion stays correct even when values are missing/skipped.
    values.forEach((v, i) => {
      const rec = records[i]
      const text = v == null ? '' : String(v).trim()
      if (text === '') {
        missingCount++
        return
      }
      const m = parseMoney(text)
      if (!m) {
        skippedCount++
        if (skipped.length < 3) skipped.push(text.length > 24 ? `${text.slice(0, 24)}…` : text)
        return
      }
      counted++
      total += m.value
      if (m.currency) currencies.set(m.currency, (currencies.get(m.currency) ?? 0) + 1)
      if (rec?.duplicate) duplicateCounted++
      else {
        uniqueTotal += m.value
        uniqueCounted++
      }
    })

    // dominant currency for this column
    let currency: string | null = null
    let maxSeen = 0
    for (const [code, n] of currencies) {
      if (n > maxSeen) {
        maxSeen = n
        currency = code
      }
    }
    if (currencies.size > 1 && currency != null) {
      const breakdown = [...currencies.entries()].map(([code, n]) => `${code}: ${n}`).join(', ')
      columnWarnings.push(
        `Column ${idx + 1} "${col}" mixes currencies (${breakdown}) — the total is shown in the dominant currency (${currency}). Check the individual values.`
      )
    }

    totals.push({
      columnIndex: idx + 1,
      columnName: col,
      total: round2(total),
      uniqueTotal: round2(uniqueTotal),
      average: counted ? round2(total / counted) : 0,
      currency,
      countedValues: counted,
      missingValues: missingCount,
      duplicateValuesCounted: duplicateCounted,
      uniqueValuesCounted: uniqueCounted,
      skippedValues: skippedCount,
      skippedSamples: skipped,
      formatted: formatMoney(round2(total), currency),
      formattedUnique: formatMoney(round2(uniqueTotal), currency),
    })
  })

  /* ---- grand total across money columns ---- */
  let grandTotal: number | null = null
  let formattedGrandTotal: string | null = null
  if (totals.length === 1) {
    grandTotal = totals[0].total
    formattedGrandTotal = totals[0].formatted
  } else if (totals.length > 1) {
    const codes = new Set(totals.map((t) => t.currency))
    if (codes.size === 1 && totals[0].currency != null) {
      grandTotal = round2(totals.reduce((s, t) => s + t.total, 0))
      formattedGrandTotal = formatMoney(grandTotal, totals[0].currency)
    } else {
      warnings.push(
        `Found ${totals.length} money columns but they do not share one currency — no grand total was computed, use the per-column totals.`
      )
    }
  }

  /* ---- notes / warnings (product rule: never silent) ---- */
  warnings.push(...columnWarnings)
  for (const t of totals) {
    if (t.skippedValues > 0 && t.skippedSamples.length)
      warnings.push(
        `Column ${t.columnIndex} "${t.columnName}": ${t.skippedValues} value(s) did not read as an amount (e.g. "${t.skippedSamples[0]}") and were excluded from the total — correct them in the workspace for an exact sum.`
      )
    if (t.missingValues > 0)
      warnings.push(
        `Column ${t.columnIndex} "${t.columnName}": ${t.missingValues} amount(s) are missing/unreadable in the source and were excluded from the total.`
      )
    if (t.duplicateValuesCounted > 0)
      warnings.push(
        `Column ${t.columnIndex} "${t.columnName}": the total includes ${t.duplicateValuesCounted} duplicated row(s) (KSh-equivalent ${formatMoney(round2(t.total - t.uniqueTotal), t.currency)}). Unique-records total: ${t.formattedUnique}.`
      )
  }
  if (totals.length === 0 && records.length > 0) {
    warnings.push('No monetary column was detected in this extraction — no totals computed.')
  }

  return {
    columns: totals,
    grandTotal,
    formattedGrandTotal,
    warnings,
  }
}

/* ------------------------------------------------------------------ */
/* Formatting helpers                                                  */
/* ------------------------------------------------------------------ */

export function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100
}

/** Format 12345.6 -> "12,345.60" with optional currency prefix. */
export function formatMoney(n: number, currency: string | null): string {
  const body = n.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
  return currency ? `${currency} ${body}` : body
}
