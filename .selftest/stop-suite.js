// Regression suite for pressing Stop while an event is still being captured.
// This is the path that used to write a corrupt WebM: teardown cleared the
// buffer, the final async chunk from stop() refilled it, and that chunk became
// the clip's "header".
(async () => {
  const R = []
  const t = (name, pass, info) => R.push({ name, pass: !!pass, info: info === undefined || info === null ? '' : String(info) })
  const wait = (ms) => new Promise(r => setTimeout(r, ms))
  const pollUntil = async (fn, timeoutMs, stepMs) => {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (fn()) return true
      await wait(stepMs || 250)
    }
    return false
  }

  const cfg = await window.api.setConfig({
    mode: 'manual',
    schedule: { start: '00:00', end: '23:59' },
    preBufferSeconds: 5,
    cooldownSeconds: 600,
    retentionDays: 14
  })
  applyConfig(cfg.config)

  const before = await window.api.listRecordings()
  const beforeFiles = new Set(before.map(i => i.file))

  motionThreshInput.value = '999'
  audioThreshInput.value = '999'
  startBtn.click()

  const started = await pollUntil(() => stream && mediaRecorder && mediaRecorder.state === 'recording', 15000)
  t('capture started', started)
  if (!started) return R

  // Roll long enough that the header chunk has left the buffer - the exact
  // condition that produced the corrupt file.
  await wait(13000)
  t('header aged out of the buffer', !chunksBuffer.some(c => c.blob === headerBlob))

  motionThreshInput.value = '0.05'
  const triggered = await pollUntil(() => eventOngoing === true, 15000, 100)
  t('event triggered', triggered)
  if (!triggered) { stopBtn.click(); return R }

  // Let a few seconds of the event accumulate, then yank the stream mid-event.
  await wait(3000)
  stopBtn.click()
  t('stop released the stream immediately', stream === null)

  const finished = await pollUntil(() => eventOngoing === false, 30000, 200)
  t('in-flight event unwound promptly after stop', finished)
  await wait(1500)

  const after = await window.api.listRecordings()
  const fresh = after.filter(i => !beforeFiles.has(i.file))
  t('interrupted event still produced exactly one file', fresh.length === 1,
    'new=' + fresh.map(f => f.file).join(',') + ' log=' + eventLog.textContent)
  if (fresh.length !== 1) return R

  const rec = fresh[0]
  const read = await window.api.readRecording(rec.file)
  t('interrupted recording reads back', !!(read && read.ok), read && read.error)
  if (!read || !read.ok) return R

  const d = read.data
  t('interrupted file starts with EBML/WebM magic', d[0] === 0x1a && d[1] === 0x45 && d[2] === 0xdf && d[3] === 0xa3,
    [d[0], d[1], d[2], d[3]].map(x => x.toString(16)).join(' '))

  const url = URL.createObjectURL(new Blob([d], { type: 'video/webm' }))
  const probe = document.createElement('video')
  probe.muted = true
  probe.preload = 'metadata'
  const meta = await new Promise((resolve) => {
    let settled = false
    const done = (v) => { if (!settled) { settled = true; resolve(v) } }
    probe.addEventListener('loadedmetadata', () => done({ ok: true, w: probe.videoWidth, h: probe.videoHeight }))
    probe.addEventListener('error', () => done({ ok: false, err: probe.error ? probe.error.message || probe.error.code : 'unknown' }))
    setTimeout(() => done({ ok: false, err: 'timeout' }), 10000)
    probe.src = url
    probe.load()
  })
  t('interrupted file decodes', meta.ok, meta.ok ? meta.w + 'x' + meta.h : meta.err)
  URL.revokeObjectURL(url)
  t('interrupted clip covers the pre-roll, not just a stray chunk', rec.size > 50000, formatBytes(rec.size))

  // A fresh Start must come up clean after the interrupted event. Disarm first:
  // Start deliberately clears the cooldown, so a live threshold would fire again.
  motionThreshInput.value = '999'
  startBtn.click()
  const restarted = await pollUntil(() => stream && mediaRecorder && mediaRecorder.state === 'recording', 15000)
  t('restart after an interrupted event works', restarted)
  await wait(2500) // the first chunk of the new session only lands after a timeslice
  t('restart began a clean session with a fresh header',
    headerBlob !== null && chunksBuffer.length > 0 && chunksBuffer.length <= 4 && chunksBuffer[0].blob === headerBlob,
    'chunks=' + chunksBuffer.length + ' header=' + (headerBlob && headerBlob.size))
  stopBtn.click()
  await pollUntil(() => stream === null, 5000)
  await wait(1500)
  t('final teardown left no buffered state', chunksBuffer.length === 0 && headerBlob === null,
    'chunks=' + chunksBuffer.length)

  const del = await window.api.deleteRecording(rec.file)
  t('artifact cleaned up', !!(del && del.ok), del && del.error)
  await window.api.setConfig({
    mode: 'manual',
    schedule: { start: '00:00', end: '23:59' },
    preBufferSeconds: 30,
    cooldownSeconds: 10,
    retentionDays: 14
  })
  return R
})()
