const { app, BrowserWindow, ipcMain } = require('electron')
const path = require('path')
const fs = require('fs')
const fsp = fs.promises

const RECORDINGS_DIR = path.join(app.getPath('userData'), 'recordings')
const CONFIG_PATH = path.join(app.getPath('userData'), 'config.json')

// mode is the either/or: 'manual' means the Start/Stop buttons drive capture and
// the schedule is ignored; 'scheduled' means the app starts and stops itself
// inside the window and the buttons are inert.
const DEFAULT_CONFIG = {
  mode: 'manual',
  schedule: { start: '22:00', end: '08:00' },
  preBufferSeconds: 30,
  cooldownSeconds: 10,
  retentionDays: 14
}

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/
const DAY_MS = 24 * 60 * 60 * 1000

async function ensureDir() {
  await fsp.mkdir(RECORDINGS_DIR, { recursive: true })
}

function clampInt(value, min, max, fallback) {
  const n = parseInt(value, 10)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

// Fills in every missing/invalid field so the rest of the app never has to
// guard against a half-written config.json.
function normalizeConfig(raw) {
  const src = (raw && typeof raw === 'object') ? raw : {}
  const schedule = (src.schedule && typeof src.schedule === 'object') ? src.schedule : {}
  return {
    mode: src.mode === 'scheduled' ? 'scheduled' : 'manual',
    schedule: {
      start: TIME_RE.test(schedule.start) ? schedule.start : DEFAULT_CONFIG.schedule.start,
      end: TIME_RE.test(schedule.end) ? schedule.end : DEFAULT_CONFIG.schedule.end
    },
    preBufferSeconds: clampInt(src.preBufferSeconds, 5, 300, DEFAULT_CONFIG.preBufferSeconds),
    cooldownSeconds: clampInt(src.cooldownSeconds, 0, 3600, DEFAULT_CONFIG.cooldownSeconds),
    retentionDays: clampInt(src.retentionDays, 1, 3650, DEFAULT_CONFIG.retentionDays)
  }
}

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      return normalizeConfig(JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')))
    }
  } catch (err) { console.warn('loadConfig', err) }
  return normalizeConfig(null)
}

function saveConfig(cfg) {
  const normalized = normalizeConfig(cfg)
  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(normalized, null, 2))
  } catch (err) { console.warn('saveConfig', err) }
  return normalized
}

// Keeps a renderer-supplied name from escaping the recordings folder.
function resolveInRecordings(name, allowedExt) {
  const base = path.basename(String(name || ''))
  if (!base || base === '.' || base === '..') return null
  if (allowedExt && path.extname(base).toLowerCase() !== allowedExt) return null
  const full = path.resolve(RECORDINGS_DIR, base)
  const rel = path.relative(RECORDINGS_DIR, full)
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null
  return full
}

function metaPathFor(webmPath) {
  return webmPath.replace(/\.webm$/i, '.json')
}

async function readMeta(webmName) {
  try {
    const metaName = webmName.replace(/\.webm$/i, '.json')
    return JSON.parse(await fsp.readFile(path.join(RECORDINGS_DIR, metaName), 'utf8'))
  } catch (err) {
    return {}
  }
}

async function cleanupOldFiles(days) {
  await ensureDir()
  const retention = clampInt(days, 1, 3650, loadConfig().retentionDays)
  const cutoff = Date.now() - retention * DAY_MS
  let removed = 0
  for (const f of await fsp.readdir(RECORDINGS_DIR)) {
    try {
      const full = path.join(RECORDINGS_DIR, f)
      const stat = await fsp.stat(full)
      if (stat.mtimeMs < cutoff) {
        await fsp.rm(full, { recursive: true, force: true })
        removed++
      }
    } catch (err) {
      console.warn('cleanup error', err)
    }
  }
  return removed
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1000,
    height: 720,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    }
  })

  win.loadFile(path.join(__dirname, 'src', 'renderer', 'index.html'))
}

app.whenReady().then(async () => {
  await ensureDir()
  cleanupOldFiles().catch(err => console.warn('startup cleanup', err))
  // daily cleanup, re-reading retentionDays from the config on every run
  setInterval(() => {
    cleanupOldFiles().catch(err => console.warn('scheduled cleanup', err))
  }, DAY_MS)
  createWindow()
})

ipcMain.handle('save-event', async (ev, payload) => {
  try {
    await ensureDir()
    const { mimeType, meta } = payload || {}

    let buffer = null
    const blob = payload && payload.blob
    if (ArrayBuffer.isView(blob)) {
      buffer = Buffer.from(blob.buffer, blob.byteOffset, blob.byteLength)
    } else if (blob instanceof ArrayBuffer) {
      buffer = Buffer.from(new Uint8Array(blob))
    } else if (payload && payload.arrayBuffer instanceof ArrayBuffer) {
      buffer = Buffer.from(new Uint8Array(payload.arrayBuffer))
    } else if (payload && typeof payload.base64 === 'string') {
      buffer = Buffer.from(payload.base64, 'base64')
    }

    if (!buffer || buffer.length === 0) {
      return { ok: false, error: 'No recording payload' }
    }

    const timestampISO = new Date().toISOString().replace(/[:.]/g, '-')
    const filename = 'event-' + timestampISO + '.webm'
    const filepath = path.join(RECORDINGS_DIR, filename)

    // Media first: a .json without its .webm would show up as a phantom event.
    await fsp.writeFile(filepath, buffer)
    const metaFull = Object.assign(
      { file: filename, mimeType, savedAt: Date.now(), bytes: buffer.length },
      meta
    )
    await fsp.writeFile(metaPathFor(filepath), JSON.stringify(metaFull, null, 2))
    return { ok: true, path: filepath, file: filename, meta: metaFull }
  } catch (err) {
    console.warn('save-event', err)
    return { ok: false, error: String(err) }
  }
})

ipcMain.handle('get-config', async () => {
  return loadConfig()
})

ipcMain.handle('set-config', async (ev, cfg) => {
  // Return the stored config so the renderer picks up clamped/defaulted values.
  return { ok: true, config: saveConfig(cfg) }
})

ipcMain.handle('export-report-csv', async () => {
  try {
    await ensureDir()
    const entries = []
    for (const f of await fsp.readdir(RECORDINGS_DIR)) {
      if (!f.startsWith('event-') || !f.endsWith('.json')) continue
      try {
        const meta = JSON.parse(await fsp.readFile(path.join(RECORDINGS_DIR, f), 'utf8'))
        const ts = meta.savedAt || meta.timestamp
        if (!ts) continue
        entries.push({ ts, reason: meta.reason || '', file: meta.file || '', duration: meta.duration })
      } catch (err) { console.warn('export error', err) }
    }
    entries.sort((a, b) => a.ts - b.ts)

    const rows = [['day', 'time', 'reason', 'file', 'durationSec']]
    for (const e of entries) {
      const t = new Date(e.ts)
      rows.push([
        t.toISOString().slice(0, 10),
        t.toISOString(),
        e.reason,
        e.file,
        typeof e.duration === 'number' ? e.duration.toFixed(1) : ''
      ])
    }

    const csv = rows
      .map(r => r.map(c => '"' + String(c).replace(/"/g, '""') + '"').join(','))
      .join('\r\n')
    const out = path.join(RECORDINGS_DIR, 'report-' + new Date().toISOString().slice(0, 10) + '.csv')
    await fsp.writeFile(out, csv, 'utf8')
    return { ok: true, path: out, rows: entries.length }
  } catch (err) {
    console.warn('export-report-csv', err)
    return { ok: false, error: String(err) }
  }
})

ipcMain.handle('list-recordings', async () => {
  await ensureDir()
  const items = []
  for (const f of await fsp.readdir(RECORDINGS_DIR)) {
    // Only actual recordings - report CSVs and sidecar JSONs are not playable.
    if (!f.toLowerCase().endsWith('.webm')) continue
    try {
      const full = path.join(RECORDINGS_DIR, f)
      const stat = await fsp.stat(full)
      const meta = await readMeta(f)
      items.push({
        file: f,
        meta,
        size: stat.size,
        savedAt: meta.savedAt || meta.timestamp || stat.mtimeMs,
        path: full
      })
    } catch (err) {
      console.warn('listing error', err)
    }
  }
  items.sort((a, b) => b.savedAt - a.savedAt)
  return items
})

// Playback goes through IPC instead of a hand-built file:// URL: no escaping
// bugs with spaces or # in the user profile path, and nothing outside the
// recordings folder is reachable.
ipcMain.handle('read-recording', async (ev, filename) => {
  try {
    const full = resolveInRecordings(filename, '.webm')
    if (!full) return { ok: false, error: 'Invalid filename' }
    if (!fs.existsSync(full)) return { ok: false, error: 'Recording not found' }
    const data = await fsp.readFile(full)
    const meta = await readMeta(path.basename(full))
    return { ok: true, data, mimeType: meta.mimeType || 'video/webm' }
  } catch (err) {
    return { ok: false, error: String(err) }
  }
})

ipcMain.handle('delete-recording', async (ev, filename) => {
  try {
    const full = resolveInRecordings(filename, '.webm')
    if (!full) return { ok: false, error: 'Invalid filename' }
    await fsp.rm(full, { force: true })
    await fsp.rm(metaPathFor(full), { force: true })
    return { ok: true }
  } catch (err) {
    return { ok: false, error: String(err) }
  }
})

ipcMain.handle('get-daily-report', async () => {
  await ensureDir()
  const byDay = {}
  for (const f of await fsp.readdir(RECORDINGS_DIR)) {
    if (!f.startsWith('event-') || !f.endsWith('.json')) continue
    try {
      const meta = JSON.parse(await fsp.readFile(path.join(RECORDINGS_DIR, f), 'utf8'))
      const ts = meta.savedAt || meta.timestamp
      if (!ts) continue
      const date = new Date(ts).toISOString().slice(0, 10)
      byDay[date] = byDay[date] || { count: 0, events: [] }
      byDay[date].count += 1
      byDay[date].events.push({ time: ts, reason: meta.reason || meta.type || '', file: meta.file })
    } catch (err) { console.warn('report error', err) }
  }
  return Object.keys(byDay).sort().map(d => ({
    day: d,
    count: byDay[d].count,
    events: byDay[d].events.sort((a, b) => a.time - b.time)
  }))
})

ipcMain.handle('cleanup-now', async () => {
  try {
    const removed = await cleanupOldFiles()
    return { ok: true, removed }
  } catch (err) {
    return { ok: false, error: String(err) }
  }
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
