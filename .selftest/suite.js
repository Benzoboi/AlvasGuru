(async () => {
  const R = []
  const t = (name, pass, info) => R.push({ name, pass: !!pass, info: info === undefined || info === null ? '' : String(info) })

  // ---- preload surface / sandbox ----------------------------------------
  t('api exposed with readRecording + cleanupNow',
    !!(window.api && typeof window.api.readRecording === 'function' && typeof window.api.cleanupNow === 'function'))
  t('renderer is sandboxed (no Buffer)', typeof Buffer === 'undefined')

  // ---- every DOM id the renderer needs actually exists -------------------
  const domRefs = {
    startBtn, stopBtn, status, messageBox, video, canvas, motionThreshInput, audioThreshInput,
    cameraSelect, micSelect, recordingList, player, reportsList, daySelect, exportCsvBtn,
    reportsChart, triggerIndicator, eventLog, modeManual, modeScheduled, schedulerStatus,
    scheduleRow, cfgStart, cfgEnd, cfgPrebuffer,
    cfgCooldown, cfgRetention, saveCfgBtn, cleanupBtn
  }
  const missing = Object.keys(domRefs).filter(k => !domRefs[k])
  t('all DOM refs resolved', missing.length === 0, missing.join(','))

  // ---- schedule logic (the inverted-Enabled bug) ------------------------
  const pad = (n) => String(n).padStart(2, '0')
  const base = new Date()
  const at = (offsetMin) => {
    const d = new Date(base.getTime() + offsetMin * 60000)
    return pad(d.getHours()) + ':' + pad(d.getMinutes())
  }

  // The window question is pure clock arithmetic...
  t('window containing now => inside', isWithinWindow({ start: at(-60), end: at(60) }) === true,
    at(-60) + '-' + at(60))
  t('future-only window => outside', isWithinWindow({ start: at(60), end: at(120) }) === false,
    at(60) + '-' + at(120))
  t('overnight window containing now => inside', isWithinWindow({ start: at(120), end: at(60) }) === true,
    at(120) + '-' + at(60))
  t('start === end means all day', isWithinWindow({ start: '09:00', end: '09:00' }) === true)
  t('missing schedule => outside', isWithinWindow(null) === false)

  // ...and the mode decides whether the clock is consulted at all.
  t('MANUAL mode never auto-captures, even in a full-day window',
    shouldBeCapturing({ mode: 'manual', schedule: { start: '00:00', end: '23:59' } }) === false)
  t('SCHEDULED mode inside the window => auto-capture',
    shouldBeCapturing({ mode: 'scheduled', schedule: { start: at(-60), end: at(60) } }) === true)
  t('SCHEDULED mode outside the window => no capture',
    shouldBeCapturing({ mode: 'scheduled', schedule: { start: at(60), end: at(120) } }) === false)
  t('missing config => no capture', shouldBeCapturing(null) === false)

  // ---- motion maths -----------------------------------------------------
  const mk = (v) => ({ data: new Uint8ClampedArray([v, v, v, 255, v, v, v, 255]) })
  t('frameDiff identical = 0', frameDiff(mk(10), mk(10)) === 0)
  t('frameDiff black vs white = 255', frameDiff(mk(0), mk(255)) === 255)
  t('frameDiff null-safe', frameDiff(null, mk(0)) === 0)

  // ---- rolling buffer + WebM header preservation ------------------------
  const B = (n) => new Blob([new Uint8Array(n)])
  const reset = () => { chunksBuffer = []; headerBlob = null; eventOngoing = false; preBufferSeconds = 30 }

  reset()
  onRecorderData({ data: B(100) })
  t('first chunk kept as header', headerBlob === chunksBuffer[0].blob)

  chunksBuffer[0].ts = Date.now() - 120000 // age the header chunk out of the window
  onRecorderData({ data: B(50) })
  t('stale chunk trimmed from buffer', chunksBuffer.length === 1, 'len=' + chunksBuffer.length)
  const clipTrimmed = buildClipBlob(chunksBuffer.slice())
  t('header re-prepended once header left buffer', clipTrimmed.size === 150, 'size=' + clipTrimmed.size)

  reset()
  onRecorderData({ data: B(100) })
  onRecorderData({ data: B(50) })
  const clipFresh = buildClipBlob(chunksBuffer.slice())
  t('header NOT duplicated while still buffered', clipFresh.size === 150, 'size=' + clipFresh.size)

  reset()
  onRecorderData({ data: B(100) })
  chunksBuffer[0].ts = Date.now() - 120000
  eventOngoing = true
  onRecorderData({ data: B(50) })
  t('trimming suspended during an event (pre-roll kept)', chunksBuffer.length === 2, 'len=' + chunksBuffer.length)
  eventOngoing = false
  reset()

  // ---- config validation / clamping over IPC ----------------------------
  const saved = await window.api.setConfig({
    mode: 'scheduled',
    schedule: { start: '25:99', end: '08:00' },
    preBufferSeconds: 99999,
    cooldownSeconds: -5,
    retentionDays: 0
  })
  t('set-config returns stored config', !!(saved && saved.ok && saved.config))
  t('mode round-trips', saved.config.mode === 'scheduled', saved.config.mode)
  const bogus = await window.api.setConfig({ mode: 'nonsense', schedule: { start: '01:00', end: '02:00' } })
  t('unknown mode falls back to manual', bogus.config.mode === 'manual', bogus.config.mode)
  t('no stale enabled flag is persisted', bogus.config.enabled === undefined)
  t('invalid start time falls back to the default', saved.config.schedule.start === '22:00', saved.config.schedule.start)
  t('valid end time kept', saved.config.schedule.end === '08:00', saved.config.schedule.end)
  t('preBufferSeconds clamped to 300', saved.config.preBufferSeconds === 300, saved.config.preBufferSeconds)
  t('cooldownSeconds clamped to 0', saved.config.cooldownSeconds === 0, saved.config.cooldownSeconds)
  t('retentionDays clamped to 1', saved.config.retentionDays === 1, saved.config.retentionDays)

  // ---- save -> list -> read -> delete round trip ------------------------
  const payload = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3, 4, 5, 6, 7, 8])
  const res = await window.api.saveEvent({
    mimeType: 'video/webm',
    meta: { reason: 'selftest', duration: 12.5 },
    blob: payload
  })
  t('save-event with Uint8Array succeeds', !!(res && res.ok), res && res.error)
  const savedFile = res && res.file

  const empty = await window.api.saveEvent({ mimeType: 'video/webm', meta: { reason: 'empty' } })
  t('empty payload rejected', !!(empty && empty.ok === false), empty && empty.error)

  const list = await window.api.listRecordings()
  t('saved recording appears in list', list.some(i => i.file === savedFile))
  t('list contains only .webm entries', list.every(i => i.file.toLowerCase().endsWith('.webm')))
  const listed = list.find(i => i.file === savedFile)
  t('listed size matches payload', !!(listed && listed.size === payload.length), listed && listed.size)
  t('listed metadata carries reason', !!(listed && listed.meta && listed.meta.reason === 'selftest'))

  const read = await window.api.readRecording(savedFile)
  t('read-recording succeeds', !!(read && read.ok), read && read.error)
  t('bytes round-trip intact',
    !!(read && read.ok && read.data.length === payload.length && read.data[0] === 0x1a && read.data[11] === 8))

  // ---- path traversal is refused ----------------------------------------
  const travRead = await window.api.readRecording('../../../../config.json')
  t('traversal read blocked', !!(travRead && travRead.ok === false), travRead && travRead.error)
  const travDel = await window.api.deleteRecording('../../config.json')
  t('traversal delete blocked', !!(travDel && travDel.ok === false), travDel && travDel.error)
  const nonWebm = await window.api.deleteRecording('config.json')
  t('non-webm delete blocked', !!(nonWebm && nonWebm.ok === false), nonWebm && nonWebm.error)
  const dots = await window.api.deleteRecording('..')
  t('".." delete blocked', !!(dots && dots.ok === false), dots && dots.error)

  // ---- reports / export --------------------------------------------------
  const report = await window.api.getDailyReport()
  t('daily report returns days', Array.isArray(report) && report.length > 0, report && report.length)
  const hasSelftest = report.some(d => d.events.some(e => e.reason === 'selftest'))
  t('report includes the selftest event', hasSelftest)

  const csv = await window.api.exportReportCsv()
  t('csv export succeeds', !!(csv && csv.ok), csv && csv.error)
  t('csv export counted rows', !!(csv && csv.rows > 0), csv && csv.rows)

  const listAfterCsv = await window.api.listRecordings()
  t('exported csv is NOT listed as a recording', listAfterCsv.every(i => !i.file.toLowerCase().endsWith('.csv')))

  const del = await window.api.deleteRecording(savedFile)
  t('delete succeeds', !!(del && del.ok), del && del.error)
  const listFinal = await window.api.listRecordings()
  t('deleted recording is gone', !listFinal.some(i => i.file === savedFile))

  const cleanup = await window.api.cleanupNow()
  t('cleanup-now runs', !!(cleanup && cleanup.ok), cleanup && cleanup.error)

  // restore a sane config
  await window.api.setConfig({
    mode: 'manual',
    schedule: { start: '22:00', end: '08:00' },
    preBufferSeconds: 30,
    cooldownSeconds: 10,
    retentionDays: 14
  })

  return R
})()
