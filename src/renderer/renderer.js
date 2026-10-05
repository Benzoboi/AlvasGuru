// ---------------------------------------------------------------------------
// DOM references
// ---------------------------------------------------------------------------
const startBtn = document.getElementById('startBtn')
const stopBtn = document.getElementById('stopBtn')
const status = document.getElementById('status')
const messageBox = document.getElementById('messageBox')
const video = document.getElementById('video')
const canvas = document.getElementById('canvas')
const motionThreshInput = document.getElementById('motionThresh')
const audioThreshInput = document.getElementById('audioThresh')
const cameraSelect = document.getElementById('cameraSelect')
const micSelect = document.getElementById('micSelect')
const recordingList = document.getElementById('recordingList')
const player = document.getElementById('player')
const reportsList = document.getElementById('reportsList')
const daySelect = document.getElementById('daySelect')
const exportCsvBtn = document.getElementById('exportCsv')
const reportsChart = document.getElementById('reportsChart')
const triggerIndicator = document.getElementById('triggerIndicator')
const eventLog = document.getElementById('eventLog')

const modeManual = document.getElementById('modeManual')
const modeScheduled = document.getElementById('modeScheduled')
const schedulerStatus = document.getElementById('schedulerStatus')
const scheduleRow = document.getElementById('scheduleRow')
const cfgStart = document.getElementById('cfgStart')
const cfgEnd = document.getElementById('cfgEnd')
const cfgPrebuffer = document.getElementById('cfgPrebuffer')
const cfgCooldown = document.getElementById('cfgCooldown')
const cfgRetention = document.getElementById('cfgRetention')
const saveCfgBtn = document.getElementById('saveCfg')
const cleanupBtn = document.getElementById('cleanupNow')

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const TIMESLICE_MS = 1000
// Motion is detected on a downscaled frame: at 1080p a full-resolution diff
// walks ~8 MB five times a second, which is pointless heat overnight.
const DETECT_W = 160
const DETECT_H = 90
const DETECT_INTERVAL_MS = 200
// The first frames after start are often black, which reads as huge motion.
const WARMUP_MS = 2000
const MAX_CHUNKS = 600
const POSTROLL_QUIET_SAMPLES = 3
const POSTROLL_SAMPLE_MS = 500
const MAX_POSTROLL_MS = 60000
// Schedule times have minute granularity, so a 5s poll reacts promptly enough.
const SCHEDULER_TICK_MS = 5000
// After a failed automatic start, back off instead of retrying every tick.
const SCHEDULER_RETRY_MS = 60000

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let stream = null
let mediaRecorder = null
let recorderMime = ''
let audioCtx = null
let analyser = null
let sourceNode = null

// Rolling pre-buffer of { ts, blob } parts.
let chunksBuffer = []
// The very first chunk of a recorder session carries the WebM/EBML header. Once
// the rolling buffer trims it away every later clip would be unplayable, so it
// is kept aside and prepended when it is no longer part of the buffer.
let headerBlob = null

let preBufferSeconds = 30
let cooldownSeconds = 10
let config = null

let prevImageData = null
let detectCtx = null
let eventOngoing = false
let lastEventEndedAt = 0
let monitoringStartedAt = 0
// Guards against two detect loops running after a fast Stop/Start.
let loopToken = 0
// MediaRecorder.stop() delivers one last chunk asynchronously. Without this
// token that chunk lands in the buffer after teardown - and if Start already
// ran, it would mix a foreign session's data into the new recording.
let recorderSession = 0
let currentObjectUrl = null

// Scheduler state - only meaningful while config.mode === 'scheduled'.
let schedulerBusy = false
let schedulerBlockedUntil = 0

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

function errMessage(err) {
  if (!err) return 'unknown error'
  if (err.message) return err.message
  if (err.name) return err.name
  return String(err)
}

function readNumber(input, fallback) {
  const n = parseFloat(input.value)
  return Number.isFinite(n) ? n : fallback
}

function formatBytes(n) {
  if (!Number.isFinite(n)) return '?'
  if (n < 1024) return n + ' B'
  if (n < 1024 * 1024) return (n / 1024).toFixed(0) + ' KB'
  return (n / (1024 * 1024)).toFixed(1) + ' MB'
}

function showMessage(text, kind) {
  messageBox.textContent = text
  messageBox.className = 'messageBox ' + (kind || 'info')
  messageBox.hidden = false
}

function showError(text) { showMessage(text, 'error') }
function clearMessage() { messageBox.hidden = true; messageBox.textContent = '' }

function setTriggerState(text, active) {
  triggerIndicator.textContent = text
  triggerIndicator.classList.toggle('active', !!active)
  triggerIndicator.classList.toggle('idle', !active)
}

function appendEventLog(text) {
  const line = document.createElement('div')
  line.textContent = text
  eventLog.prepend(line)
  while (eventLog.children.length > 8) eventLog.removeChild(eventLog.lastChild)
}

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------
document.querySelectorAll('.tab').forEach(b => b.addEventListener('click', (e) => {
  const t = e.currentTarget.dataset.tab
  document.querySelectorAll('.tabContent').forEach(s => { s.hidden = s.id !== t })
  document.querySelectorAll('.tab').forEach(x => x.classList.toggle('active', x === e.currentTarget))
  if (t === 'recordings') loadRecordings()
  if (t === 'reports') loadReports()
}))

// ---------------------------------------------------------------------------
// Devices
// ---------------------------------------------------------------------------
function fillSelect(select, devices, labelPrefix, emptyLabel) {
  const previous = select.value
  select.innerHTML = ''
  if (devices.length === 0) {
    const opt = document.createElement('option')
    opt.value = 'default'
    opt.textContent = emptyLabel
    select.appendChild(opt)
    return
  }
  devices.forEach((device, i) => {
    const opt = document.createElement('option')
    opt.value = device.deviceId || 'default'
    opt.textContent = device.label || (labelPrefix + ' ' + (i + 1))
    select.appendChild(opt)
  })
  if (previous && Array.prototype.some.call(select.options, o => o.value === previous)) {
    select.value = previous
  }
}

// Before permission is granted enumerateDevices() returns blank ids and labels,
// so this is called again right after getUserMedia() succeeds.
async function populateDeviceSelectors() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return
  const devices = await navigator.mediaDevices.enumerateDevices()
  fillSelect(cameraSelect, devices.filter(d => d.kind === 'videoinput'), 'Camera', 'No camera found')
  fillSelect(micSelect, devices.filter(d => d.kind === 'audioinput'), 'Microphone', 'No microphone found')
}

function pickMimeType(mediaStream) {
  const hasAudio = mediaStream.getAudioTracks().length > 0
  const candidates = hasAudio
    ? ['video/webm;codecs=vp8,opus', 'video/webm;codecs=vp9,opus', 'video/webm']
    : ['video/webm;codecs=vp8', 'video/webm;codecs=vp9', 'video/webm']
  for (const c of candidates) {
    if (window.MediaRecorder && MediaRecorder.isTypeSupported(c)) return c
  }
  return ''
}

async function acquireStream() {
  const cameraId = cameraSelect.value && cameraSelect.value !== 'default' ? cameraSelect.value : null
  const micId = micSelect.value && micSelect.value !== 'default' ? micSelect.value : null
  const videoConstraint = cameraId ? { deviceId: { exact: cameraId } } : { facingMode: 'user' }
  const audioConstraint = micId ? { deviceId: { exact: micId } } : true

  try {
    const s = await navigator.mediaDevices.getUserMedia({ video: videoConstraint, audio: audioConstraint })
    return { stream: s, audio: true }
  } catch (err) {
    if (err && err.name === 'NotAllowedError') throw err
    // A machine with no usable microphone would otherwise fail to start at all.
    const s = await navigator.mediaDevices.getUserMedia({ video: videoConstraint, audio: false })
    return { stream: s, audio: false }
  }
}

// ---------------------------------------------------------------------------
// Pre-buffer
// ---------------------------------------------------------------------------
function onRecorderData(e, session = recorderSession) {
  if (session !== recorderSession) return // late chunk from a stopped recorder
  if (!e.data || e.data.size === 0) return
  if (!headerBlob) headerBlob = e.data
  chunksBuffer.push({ ts: Date.now(), blob: e.data })
  trimBuffer()
}

function trimBuffer() {
  // While an event is being captured the pre-buffer must not be trimmed away
  // under us - the post-roll wait would eat exactly the seconds we want to keep.
  if (!eventOngoing) {
    const cutoff = Date.now() - preBufferSeconds * 1000
    while (chunksBuffer.length && chunksBuffer[0].ts < cutoff) chunksBuffer.shift()
  }
  while (chunksBuffer.length > MAX_CHUNKS) chunksBuffer.shift()
}

// Asks the recorder for the slice collected since the last chunk, so the clip
// ends at the event instead of up to a second before it.
function requestFlush() {
  return new Promise(resolve => {
    // Held locally: Stop may null out mediaRecorder while this is pending.
    const rec = mediaRecorder
    if (!rec || rec.state !== 'recording') return resolve()
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      rec.removeEventListener('dataavailable', finish)
      resolve()
    }
    const timer = setTimeout(finish, TIMESLICE_MS + 500)
    rec.addEventListener('dataavailable', finish)
    try { rec.requestData() } catch (err) { finish() }
  })
}

function buildClipBlob(entries) {
  const parts = entries.map(c => c.blob)
  if (headerBlob && !entries.some(c => c.blob === headerBlob)) parts.unshift(headerBlob)
  return new Blob(parts, { type: recorderMime || 'video/webm' })
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------
function captureDetectFrame() {
  if (!video.videoWidth || !video.videoHeight) return null
  if (canvas.width !== DETECT_W || canvas.height !== DETECT_H) {
    canvas.width = DETECT_W
    canvas.height = DETECT_H
    detectCtx = null
  }
  if (!detectCtx) detectCtx = canvas.getContext('2d', { willReadFrequently: true })
  detectCtx.drawImage(video, 0, 0, DETECT_W, DETECT_H)
  return detectCtx.getImageData(0, 0, DETECT_W, DETECT_H)
}

// Mean absolute per-channel difference, 0..255.
function frameDiff(img1, img2) {
  if (!img1 || !img2) return 0
  const d1 = img1.data
  const d2 = img2.data
  if (d1.length !== d2.length) return 0
  let sum = 0
  for (let i = 0; i < d1.length; i += 4) {
    const r = Math.abs(d1[i] - d2[i])
    const g = Math.abs(d1[i + 1] - d2[i + 1])
    const b = Math.abs(d1[i + 2] - d2[i + 2])
    sum += (r + g + b) / 3
  }
  return sum / (d1.length / 4)
}

function getAudioLevel() {
  if (!analyser) return 0
  const buf = new Float32Array(analyser.fftSize)
  analyser.getFloatTimeDomainData(buf)
  let sum = 0
  for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i]
  return Math.sqrt(sum / buf.length)
}

// Pure clock question: is the current time inside start..end? Handles overnight
// ranges (22:00 -> 08:00), where the window wraps past midnight.
function isWithinWindow(schedule, at) {
  if (!schedule || !schedule.start || !schedule.end) return false
  if (schedule.start === schedule.end) return true // full day
  const now = at || new Date()
  const pad = (n) => String(n).padStart(2, '0')
  const cur = pad(now.getHours()) + ':' + pad(now.getMinutes())
  if (schedule.start < schedule.end) return cur >= schedule.start && cur <= schedule.end
  return cur >= schedule.start || cur <= schedule.end
}

// The either/or: in manual mode the schedule is ignored entirely and the
// buttons decide; in scheduled mode the window decides and the buttons are off.
function shouldBeCapturing(cfg, at) {
  if (!cfg || cfg.mode !== 'scheduled') return false
  return isWithinWindow(cfg.schedule, at)
}

async function waitForCalm(motionThresh, audioThresh) {
  const deadline = Date.now() + MAX_POSTROLL_MS
  let quiet = 0
  while (quiet < POSTROLL_QUIET_SAMPLES && Date.now() < deadline && stream) {
    await sleep(POSTROLL_SAMPLE_MS)
    const frame = captureDetectFrame()
    const motion = frame ? frameDiff(frame, prevImageData) : 0
    if (frame) prevImageData = frame
    const audio = getAudioLevel()
    if (motion <= motionThresh && audio <= audioThresh) quiet++
    else quiet = 0
  }
}

async function triggerEvent(reason, motionThresh, audioThresh) {
  if (eventOngoing) return
  eventOngoing = true
  const startedAt = Date.now()
  status.textContent = 'Event: ' + reason
  setTriggerState('TRIGGERED: ' + reason + ' detected', true)
  appendEventLog('Trigger: ' + reason + ' at ' + new Date().toLocaleTimeString())

  try {
    // Snapshot only after the event is over, otherwise the clip holds the
    // pre-roll and stops right where the interesting part begins.
    await waitForCalm(motionThresh, audioThresh)
    await requestFlush()

    const entries = chunksBuffer.slice()
    if (entries.length === 0) {
      appendEventLog('Nothing buffered - event skipped')
      setTriggerState('Nothing to save', false)
      return
    }

    const clip = buildClipBlob(entries)
    const startTs = entries[0].ts - TIMESLICE_MS
    const endTs = entries[entries.length - 1].ts
    const meta = {
      reason,
      timestamp: startedAt,
      startTime: startTs,
      endTime: endTs,
      duration: Math.max(0, (endTs - startTs) / 1000)
    }

    // Buffer does not exist in a sandboxed renderer - a plain Uint8Array is
    // what structured-clones cleanly over IPC.
    const bytes = new Uint8Array(await clip.arrayBuffer())
    const res = await window.api.saveEvent({ mimeType: clip.type, meta, blob: bytes })

    if (res && res.ok) {
      appendEventLog('Saved ' + res.file + ' (' + formatBytes(res.meta.bytes) + ', ' + meta.duration.toFixed(1) + 's)')
      setTriggerState('Saved recording', false)
    } else {
      const msg = (res && res.error) || 'unknown error'
      appendEventLog('Save FAILED: ' + msg)
      showError('Could not save recording: ' + msg)
      setTriggerState('Save failed', false)
    }
  } catch (err) {
    console.error(err)
    appendEventLog('Event error: ' + errMessage(err))
    showError('Event error: ' + errMessage(err))
    setTriggerState('Event error', false)
  } finally {
    // Released no matter what: a single failure must never wedge the watcher.
    eventOngoing = false
    lastEventEndedAt = Date.now()
    prevImageData = null
    trimBuffer()
  }
}

async function detectLoop() {
  const token = ++loopToken
  while (stream && token === loopToken) {
    try {
      const frame = captureDetectFrame()
      const motion = frame ? frameDiff(frame, prevImageData) : 0
      if (frame) prevImageData = frame
      const audio = getAudioLevel()
      const motionThresh = readNumber(motionThreshInput, 10)
      const audioThresh = readNumber(audioThreshInput, 0.02)

      // No schedule check here: whether capture runs at all is the mode's job.
      const warmingUp = Date.now() - monitoringStartedAt < WARMUP_MS
      const cooling = Date.now() - lastEventEndedAt < cooldownSeconds * 1000

      let state = 'Armed'
      if (warmingUp) state = 'Warming up'
      else if (cooling) state = 'Cooldown'

      status.textContent = state +
        ' | motion ' + motion.toFixed(1) + '/' + motionThresh +
        ' | audio ' + audio.toFixed(4) + '/' + audioThresh

      if (!warmingUp && !cooling) {
        if (motion > motionThresh) await triggerEvent('motion', motionThresh, audioThresh)
        else if (audio > audioThresh) await triggerEvent('audio', motionThresh, audioThresh)
      }
      await sleep(DETECT_INTERVAL_MS)
    } catch (err) {
      console.error(err)
      showError('Detection stopped: ' + errMessage(err))
      break
    }
  }
}

// ---------------------------------------------------------------------------
// Start / stop
// ---------------------------------------------------------------------------
async function startCapture() {
  const acquired = await acquireStream()
  stream = acquired.stream
  video.srcObject = stream
  await populateDeviceSelectors().catch(() => {})

  if (stream.getAudioTracks().length > 0) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)()
    if (audioCtx.state === 'suspended') await audioCtx.resume()
    analyser = audioCtx.createAnalyser()
    analyser.fftSize = 2048
    sourceNode = audioCtx.createMediaStreamSource(stream)
    // Deliberately not connected to destination - that would loop the mic back
    // through the speakers.
    sourceNode.connect(analyser)
  } else {
    analyser = null
    appendEventLog('No microphone available - motion detection only')
  }

  recorderMime = pickMimeType(stream)
  mediaRecorder = new MediaRecorder(stream, recorderMime ? { mimeType: recorderMime } : undefined)
  recorderMime = mediaRecorder.mimeType || recorderMime

  chunksBuffer = []
  headerBlob = null
  prevImageData = null
  eventOngoing = false
  lastEventEndedAt = 0

  const session = ++recorderSession
  mediaRecorder.ondataavailable = (e) => onRecorderData(e, session)
  mediaRecorder.onerror = (e) => showError('Recorder error: ' + errMessage(e && e.error))
  // The recorder now runs uninterrupted: clips are sliced out of the rolling
  // buffer instead of stopping and restarting it around every event.
  mediaRecorder.start(TIMESLICE_MS)

  monitoringStartedAt = Date.now()
  setTriggerState('Waiting for motion or sound', false)
  appendEventLog('Monitoring started at ' + new Date().toLocaleTimeString())
  detectLoop()
}

function teardown() {
  loopToken++ // stops the detect loop even if Start follows immediately
  recorderSession++ // the final chunk stop() emits must not land in the buffer
  try {
    if (mediaRecorder) {
      mediaRecorder.ondataavailable = null
      if (mediaRecorder.state !== 'inactive') mediaRecorder.stop()
    }
  } catch (err) { console.warn('recorder stop', err) }
  mediaRecorder = null

  if (stream) {
    stream.getTracks().forEach(t => t.stop())
    stream = null
  }
  video.srcObject = null

  try { if (sourceNode) sourceNode.disconnect() } catch (err) { console.warn('disconnect', err) }
  sourceNode = null
  analyser = null
  if (audioCtx) {
    audioCtx.close().catch(() => {})
    audioCtx = null
  }

  // An event still in flight keeps its buffer and header so it can write a
  // valid clip instead of losing the footage; its own finally-block clears the
  // lock, and startCapture() resets everything before the next session anyway.
  if (!eventOngoing) {
    chunksBuffer = []
    headerBlob = null
  }
  prevImageData = null
  detectCtx = null
}

function stopCapture() {
  teardown()
  setTriggerState('Monitoring stopped', false)
  status.textContent = 'Stopped'
  appendEventLog('Monitoring stopped at ' + new Date().toLocaleTimeString())
}

// Shared by the buttons and the scheduler so both routes behave identically.
async function beginCapture() {
  if (stream) return true
  startBtn.disabled = true
  try {
    await startCapture()
    updateModeUI()
    return true
  } catch (err) {
    console.error(err)
    teardown()
    setTriggerState('Not running', false)
    status.textContent = 'Idle'
    showError('Could not start monitoring: ' + errMessage(err))
    updateModeUI()
    return false
  }
}

function endCapture() {
  if (!stream) return
  stopCapture()
  updateModeUI()
}

startBtn.addEventListener('click', async () => {
  if (isScheduledMode()) return // the clock owns capture in scheduled mode
  clearMessage()
  await beginCapture()
})

stopBtn.addEventListener('click', () => {
  if (isScheduledMode()) return
  endCapture()
})

window.addEventListener('beforeunload', () => teardown())

// ---------------------------------------------------------------------------
// Mode: manual (buttons) or scheduled (clock) - never both
// ---------------------------------------------------------------------------
function isScheduledMode() {
  return !!(config && config.mode === 'scheduled')
}

function updateModeUI() {
  const scheduled = isScheduledMode()
  modeManual.checked = !scheduled
  modeScheduled.checked = scheduled
  cfgStart.disabled = !scheduled
  cfgEnd.disabled = !scheduled
  scheduleRow.classList.toggle('disabled', !scheduled)

  // In scheduled mode the buttons are inert; in manual mode they are the only
  // way in or out.
  startBtn.disabled = scheduled || !!stream
  stopBtn.disabled = scheduled || !stream

  if (!scheduled) {
    schedulerStatus.textContent = stream
      ? 'Manual mode - monitoring; press Stop to end.'
      : 'Manual mode - press Start to begin.'
    return
  }

  const s = config.schedule
  const win = s.start + ' - ' + s.end
  if (stream) {
    schedulerStatus.textContent = 'Scheduled mode - monitoring, stops automatically at ' + s.end + '.'
  } else if (Date.now() < schedulerBlockedUntil) {
    schedulerStatus.textContent = 'Scheduled mode - could not start, retrying in a minute (window ' + win + ').'
  } else {
    schedulerStatus.textContent = 'Scheduled mode - idle, starts automatically at ' + s.start + ' (window ' + win + ').'
  }
}

async function scheduleTick() {
  if (schedulerBusy) return
  if (!isScheduledMode()) { updateModeUI(); return }

  const want = isWithinWindow(config.schedule)
  if (want && !stream) {
    if (Date.now() < schedulerBlockedUntil) { updateModeUI(); return }
    schedulerBusy = true
    appendEventLog('Schedule: window opened at ' + new Date().toLocaleTimeString())
    const ok = await beginCapture()
    schedulerBlockedUntil = ok ? 0 : Date.now() + SCHEDULER_RETRY_MS
    schedulerBusy = false
  } else if (!want && stream) {
    schedulerBusy = true
    appendEventLog('Schedule: window closed at ' + new Date().toLocaleTimeString())
    endCapture()
    schedulerBusy = false
  }
  updateModeUI()
}

// Live feedback while picking a mode, before the config is saved.
;[modeManual, modeScheduled].forEach(radio => radio.addEventListener('change', () => {
  const scheduled = modeScheduled.checked
  cfgStart.disabled = !scheduled
  cfgEnd.disabled = !scheduled
  scheduleRow.classList.toggle('disabled', !scheduled)
  schedulerStatus.textContent = (scheduled ? 'Scheduled' : 'Manual') +
    ' mode selected - press "Save config" to apply it.'
}))

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
function applyConfig(cfg) {
  // Changing mode hands control to the other side, so any running session
  // belongs to the old owner and has to end. Enforced here rather than in the
  // Save handler so it holds however the config arrives.
  const modeChanged = !!config && config.mode !== cfg.mode
  config = cfg
  if (modeChanged && stream) endCapture()
  preBufferSeconds = cfg.preBufferSeconds
  cooldownSeconds = cfg.cooldownSeconds
  cfgStart.value = cfg.schedule.start
  cfgEnd.value = cfg.schedule.end
  cfgPrebuffer.value = cfg.preBufferSeconds
  cfgCooldown.value = cfg.cooldownSeconds
  cfgRetention.value = cfg.retentionDays
  updateModeUI()
}

async function loadConfigUI() {
  try {
    applyConfig(await window.api.getConfig())
  } catch (err) {
    showError('Could not load configuration: ' + errMessage(err))
  }
}

saveCfgBtn.addEventListener('click', async () => {
  saveCfgBtn.disabled = true
  try {
    const res = await window.api.setConfig({
      mode: modeScheduled.checked ? 'scheduled' : 'manual',
      schedule: { start: cfgStart.value, end: cfgEnd.value },
      preBufferSeconds: cfgPrebuffer.value,
      cooldownSeconds: cfgCooldown.value,
      retentionDays: cfgRetention.value
    })
    if (res && res.ok) {
      applyConfig(res.config) // stops a running session if the mode changed
      schedulerBlockedUntil = 0
      await scheduleTick()
      showMessage('Configuration saved.', 'ok')
    } else {
      showError('Could not save configuration')
    }
  } catch (err) {
    showError('Could not save configuration: ' + errMessage(err))
  }
  saveCfgBtn.disabled = false
})

cleanupBtn.addEventListener('click', async () => {
  cleanupBtn.disabled = true
  try {
    const res = await window.api.cleanupNow()
    if (res && res.ok) showMessage('Cleanup done, ' + res.removed + ' file(s) removed.', 'ok')
    else showError('Cleanup failed: ' + ((res && res.error) || 'unknown error'))
  } catch (err) {
    showError('Cleanup failed: ' + errMessage(err))
  }
  cleanupBtn.disabled = false
})

// ---------------------------------------------------------------------------
// Recordings
// ---------------------------------------------------------------------------
async function playRecording(file) {
  try {
    const res = await window.api.readRecording(file)
    if (!res || !res.ok) {
      showError('Playback failed: ' + ((res && res.error) || 'unknown error'))
      return
    }
    if (currentObjectUrl) URL.revokeObjectURL(currentObjectUrl)
    currentObjectUrl = URL.createObjectURL(new Blob([res.data], { type: res.mimeType || 'video/webm' }))
    player.src = currentObjectUrl
    player.hidden = false
    player.load()
    player.play().catch(() => {})
  } catch (err) {
    showError('Playback failed: ' + errMessage(err))
  }
}

async function loadRecordings() {
  recordingList.textContent = 'Loading...'
  try {
    const items = await window.api.listRecordings()
    if (!items || items.length === 0) {
      recordingList.textContent = 'No recordings yet.'
      return
    }
    recordingList.innerHTML = ''
    items.forEach(it => {
      const row = document.createElement('div')
      row.className = 'recordingRow'

      const playBtn = document.createElement('button')
      const when = new Date(it.savedAt).toLocaleString()
      const reason = it.meta && it.meta.reason ? it.meta.reason : 'event'
      playBtn.textContent = when + ' - ' + reason + ' (' + formatBytes(it.size) + ')'
      playBtn.addEventListener('click', () => playRecording(it.file))

      const del = document.createElement('button')
      del.textContent = 'Delete'
      del.className = 'danger'
      del.addEventListener('click', async () => {
        if (!confirm('Delete this recording?')) return
        const res = await window.api.deleteRecording(it.file)
        if (res && res.ok) loadRecordings()
        else showError('Delete failed: ' + ((res && res.error) || 'unknown error'))
      })

      row.appendChild(playBtn)
      row.appendChild(del)
      recordingList.appendChild(row)
    })
  } catch (err) {
    recordingList.textContent = 'Error loading recordings: ' + errMessage(err)
  }
}

document.getElementById('refreshRecordings').addEventListener('click', () => loadRecordings())

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------
let reportDays = []

async function loadReports() {
  reportsList.textContent = 'Loading...'
  try {
    reportDays = await window.api.getDailyReport()
    daySelect.innerHTML = ''
    if (!reportDays || reportDays.length === 0) {
      reportsList.textContent = 'No data'
      clearChart()
      return
    }
    reportDays.forEach((d, idx) => {
      const opt = document.createElement('option')
      opt.value = String(idx)
      opt.textContent = d.day + ' (' + d.count + ')'
      daySelect.appendChild(opt)
    })
    daySelect.selectedIndex = reportDays.length - 1
    renderDayReport(reportDays[daySelect.selectedIndex])
  } catch (err) {
    reportsList.textContent = 'Error loading reports: ' + errMessage(err)
  }
}

daySelect.addEventListener('change', () => {
  const idx = parseInt(daySelect.value, 10)
  renderDayReport(reportDays[idx])
})

function clearChart() {
  const ctx = reportsChart.getContext('2d')
  ctx.clearRect(0, 0, reportsChart.width, reportsChart.height)
}

function renderDayReport(dayObj) {
  if (!dayObj || !dayObj.events) {
    reportsList.textContent = 'No events for that day'
    clearChart()
    return
  }

  // The event list used to be wiped right after rendering, leaving the panel
  // permanently blank.
  reportsList.innerHTML = ''
  const summary = document.createElement('div')
  summary.className = 'reportSummary'
  summary.textContent = dayObj.day + ': ' + dayObj.count + ' event(s)'
  reportsList.appendChild(summary)

  dayObj.events.forEach(ev => {
    const line = document.createElement('div')
    line.className = 'reportRow'
    line.textContent = new Date(ev.time).toLocaleTimeString() + ' - ' + (ev.reason || 'event')
    reportsList.appendChild(line)
  })

  const hours = new Array(24).fill(0)
  dayObj.events.forEach(ev => {
    const t = new Date(ev.time)
    if (!isNaN(t.getTime())) hours[t.getHours()]++
  })

  const ctx = reportsChart.getContext('2d')
  const w = reportsChart.width
  const h = reportsChart.height
  ctx.clearRect(0, 0, w, h)
  const max = Math.max(1, ...hours)
  const pad = 30
  const barW = (w - pad * 2) / 24
  ctx.font = '10px sans-serif'
  hours.forEach((c, i) => {
    const x = pad + i * barW
    const barH = (c / max) * (h - pad * 1.5)
    ctx.fillStyle = '#4a90e2'
    ctx.fillRect(x, h - pad - barH, barW * 0.9, barH)
    ctx.fillStyle = '#000'
    ctx.fillText(String(i), x + 2, h - 6)
    if (c > 0) ctx.fillText(String(c), x + 2, h - pad - barH - 2)
  })
  ctx.fillStyle = '#666'
  ctx.fillText('max ' + max + '/h', 2, 10)
}

exportCsvBtn.addEventListener('click', async () => {
  exportCsvBtn.disabled = true
  try {
    const res = await window.api.exportReportCsv()
    if (res && res.ok) showMessage('CSV exported (' + res.rows + ' rows): ' + res.path, 'ok')
    else showError('Export failed: ' + ((res && res.error) || 'unknown error'))
  } catch (err) {
    showError('Export failed: ' + errMessage(err))
  }
  exportCsvBtn.disabled = false
})

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------
loadConfigUI().then(() => scheduleTick())
// The scheduler runs always; it no-ops unless the mode is 'scheduled'.
setInterval(() => { scheduleTick() }, SCHEDULER_TICK_MS)
populateDeviceSelectors().catch(err => console.warn('device list error', err))
if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) {
  navigator.mediaDevices.addEventListener('devicechange', () => {
    populateDeviceSelectors().catch(err => console.warn('device list error', err))
  })
}
