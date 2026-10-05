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

  // Short pre-buffer so the WebM header chunk is guaranteed to age out of the
  // rolling window before the event fires - that is the exact condition that
  // used to produce unplayable files.
  const cfg = await window.api.setConfig({
    mode: 'manual',
    schedule: { start: '00:00', end: '23:59' },
    preBufferSeconds: 5,
    cooldownSeconds: 600,
    retentionDays: 14
  })
  applyConfig(cfg.config)
  t('test config applied (preBuffer=5s)', preBufferSeconds === 5, 'preBufferSeconds=' + preBufferSeconds)

  const before = await window.api.listRecordings()
  const beforeFiles = new Set(before.map(i => i.file))

  // Start with thresholds high enough that nothing triggers yet.
  motionThreshInput.value = '999'
  audioThreshInput.value = '999'
  startBtn.click()

  const started = await pollUntil(() => stream && mediaRecorder && mediaRecorder.state === 'recording', 15000)
  t('capture started (camera + recorder running)', started,
    'recorder=' + (mediaRecorder && mediaRecorder.state) + ' audioTracks=' + (stream ? stream.getAudioTracks().length : 0))
  if (!started) return R

  t('mime type negotiated', !!recorderMime, recorderMime)

  // Let the buffer roll long enough that the header chunk is trimmed away.
  await wait(13000)

  t('chunks are accumulating', chunksBuffer.length > 0, 'chunks=' + chunksBuffer.length)
  t('buffer trimmed to the pre-buffer window', chunksBuffer.length <= 8, 'chunks=' + chunksBuffer.length)
  const headerStillBuffered = chunksBuffer.some(c => c.blob === headerBlob)
  t('header chunk HAS aged out of the buffer (the risky case)', headerStillBuffered === false)
  t('header chunk still retained separately', !!headerBlob && headerBlob.size > 0, 'headerBytes=' + (headerBlob && headerBlob.size))

  const statusSample = status.textContent
  t('detect loop is running and reporting motion', /motion \d/.test(statusSample), statusSample)

  // Now arm it for real: drop the motion threshold so the detect loop fires.
  motionThreshInput.value = '0.05'

  const triggered = await pollUntil(() => eventOngoing === true, 15000, 100)
  t('detect loop auto-triggered an event', triggered)

  // The fake camera never goes still, so the post-roll runs to its 60s cap.
  const finished = await pollUntil(() => eventOngoing === false, 120000, 500)
  t('event completed and released the lock', finished)
  motionThreshInput.value = '999'

  // The recorder must still be running: events are sliced out of the rolling
  // buffer now, not by stopping and restarting the recorder.
  t('recorder kept running through the event', mediaRecorder && mediaRecorder.state === 'recording',
    mediaRecorder && mediaRecorder.state)
  t('no error surfaced to the user', messageBox.hidden === true,
    messageBox.hidden ? '' : messageBox.textContent)

  const after = await window.api.listRecordings()
  const fresh = after.filter(i => !beforeFiles.has(i.file))
  t('exactly one new recording was written', fresh.length === 1, 'new=' + fresh.map(f => f.file).join(','))
  if (fresh.length !== 1) { stopBtn.click(); return R }

  const rec = fresh[0]
  t('recording is substantial, not a stub', rec.size > 50000, formatBytes(rec.size))
  t('metadata reason is motion', rec.meta && rec.meta.reason === 'motion', rec.meta && rec.meta.reason)
  t('metadata duration covers pre-roll + event', rec.meta && rec.meta.duration > 60,
    rec.meta && rec.meta.duration + 's')

  const read = await window.api.readRecording(rec.file)
  t('recording reads back', !!(read && read.ok), read && read.error)
  if (!read || !read.ok) { stopBtn.click(); return R }

  // A valid WebM/Matroska file starts with the EBML magic 1A 45 DF A3. If the
  // header chunk had been trimmed away, byte 0 would be cluster payload.
  const d = read.data
  const magicOk = d[0] === 0x1a && d[1] === 0x45 && d[2] === 0xdf && d[3] === 0xa3
  t('file starts with the EBML/WebM magic bytes', magicOk,
    [d[0], d[1], d[2], d[3]].map(x => x.toString(16)).join(' '))

  // Real playability check: hand it to Chromium's own demuxer.
  const url = URL.createObjectURL(new Blob([d], { type: 'video/webm' }))
  const probe = document.createElement('video')
  probe.muted = true
  probe.preload = 'metadata'
  const meta = await new Promise((resolve) => {
    let settled = false
    const done = (v) => { if (!settled) { settled = true; resolve(v) } }
    probe.addEventListener('loadedmetadata', () => done({ ok: true, w: probe.videoWidth, h: probe.videoHeight, rs: probe.readyState }))
    probe.addEventListener('error', () => done({ ok: false, err: probe.error ? probe.error.message || probe.error.code : 'unknown' }))
    setTimeout(() => done({ ok: false, err: 'timeout' }), 10000)
    probe.src = url
    probe.load()
  })
  t('decoder accepts the file (metadata loaded)', meta.ok, meta.ok ? (meta.w + 'x' + meta.h + ' readyState=' + meta.rs) : meta.err)
  t('video track has real dimensions', meta.ok && meta.w > 0 && meta.h > 0, meta.w + 'x' + meta.h)

  // And it actually decodes frames, not just headers.
  let played = false
  if (meta.ok) {
    probe.currentTime = 1
    played = await new Promise((resolve) => {
      let settled = false
      const done = (v) => { if (!settled) { settled = true; resolve(v) } }
      probe.addEventListener('seeked', () => done(true))
      probe.addEventListener('error', () => done(false))
      setTimeout(() => done(false), 10000)
    })
  }
  t('file is seekable/decodable past the first frame', played)
  URL.revokeObjectURL(url)

  // ---- teardown behaviour ------------------------------------------------
  stopBtn.click()
  const stopped = await pollUntil(() => stream === null, 5000)
  t('stop released the stream', stopped)
  t('stop closed the audio context', audioCtx === null && analyser === null)
  // Long enough for stop()'s final async dataavailable to have been delivered.
  await wait(2000)
  t('stop cleared the buffers (late chunk rejected)',
    chunksBuffer.length === 0 && headerBlob === null,
    'chunks=' + chunksBuffer.length + ' header=' + headerBlob)
  t('stop reset the event lock', eventOngoing === false)
  t('start button re-enabled', startBtn.disabled === false && stopBtn.disabled === true)

  // clean up the artifact and restore defaults
  const del = await window.api.deleteRecording(rec.file)
  t('test recording cleaned up', !!(del && del.ok), del && del.error)
  await window.api.setConfig({
    mode: 'manual',
    schedule: { start: '00:00', end: '23:59' },
    preBufferSeconds: 30,
    cooldownSeconds: 10,
    retentionDays: 14
  })

  return R
})()
