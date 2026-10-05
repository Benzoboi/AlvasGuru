// Verifies the either/or: manual mode is driven by the buttons and ignores the
// clock; scheduled mode is driven by the clock and ignores the buttons.
(async () => {
  const R = []
  const t = (name, pass, info) => R.push({ name, pass: !!pass, info: info === undefined || info === null ? '' : String(info) })
  const wait = (ms) => new Promise(r => setTimeout(r, ms))
  const pollUntil = async (fn, timeoutMs, stepMs) => {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (fn()) return true
      await wait(stepMs || 200)
    }
    return false
  }

  const pad = (n) => String(n).padStart(2, '0')
  const at = (offsetMin) => {
    const d = new Date(Date.now() + offsetMin * 60000)
    return pad(d.getHours()) + ':' + pad(d.getMinutes())
  }
  const setMode = async (mode, start, end) => {
    const res = await window.api.setConfig({
      mode,
      schedule: { start, end },
      preBufferSeconds: 5,
      cooldownSeconds: 600,
      retentionDays: 14
    })
    applyConfig(res.config)
    await scheduleTick()
    return res.config
  }

  // Nothing should ever trigger during this suite - we only care about capture
  // starting and stopping, not about events.
  motionThreshInput.value = '999'
  audioThreshInput.value = '999'

  // ---- MANUAL mode ignores the clock ------------------------------------
  // A window that contains right now, but the mode is manual.
  const manualCfg = await setMode('manual', at(-60), at(60))
  t('manual mode stored', manualCfg.mode === 'manual', manualCfg.mode)
  await wait(1000)
  t('manual mode does NOT auto-start inside a live window', stream === null)
  t('manual mode enables the Start button', startBtn.disabled === false)
  t('manual mode disables the schedule fields', cfgStart.disabled === true && cfgEnd.disabled === true)
  t('manual mode says so in the status line', /Manual mode/.test(schedulerStatus.textContent),
    schedulerStatus.textContent)

  startBtn.click()
  const manualStarted = await pollUntil(() => stream && mediaRecorder && mediaRecorder.state === 'recording', 15000)
  t('manual Start button starts capture', manualStarted)
  t('Stop button becomes available', stopBtn.disabled === false && startBtn.disabled === true)
  stopBtn.click()
  t('manual Stop button stops capture', await pollUntil(() => stream === null, 5000))

  // ---- SCHEDULED mode starts itself --------------------------------------
  const openCfg = await setMode('scheduled', at(-1), at(30))
  t('scheduled mode stored', openCfg.mode === 'scheduled', openCfg.mode)
  const autoStarted = await pollUntil(() => stream && mediaRecorder && mediaRecorder.state === 'recording', 20000)
  t('scheduled mode auto-starts inside the window', autoStarted,
    'window ' + openCfg.schedule.start + '-' + openCfg.schedule.end)
  t('scheduled mode enables the schedule fields', cfgStart.disabled === false && cfgEnd.disabled === false)
  t('scheduled mode disables BOTH buttons', startBtn.disabled === true && stopBtn.disabled === true)
  t('status line reports scheduled monitoring', /Scheduled mode - monitoring/.test(schedulerStatus.textContent),
    schedulerStatus.textContent)

  // Buttons must be inert here, not merely greyed out.
  stopBtn.click()
  await wait(500)
  t('clicking Stop in scheduled mode does nothing', stream !== null)

  // ---- SCHEDULED mode stops itself when the window closes -----------------
  const closedCfg = await setMode('scheduled', at(-120), at(-60))
  t('window now in the past', isWithinWindow(closedCfg.schedule) === false,
    closedCfg.schedule.start + '-' + closedCfg.schedule.end)
  const autoStopped = await pollUntil(() => stream === null, 20000)
  t('scheduled mode auto-stops once the window closes', autoStopped)
  t('status line reports waiting for the next window',
    /Scheduled mode - idle, starts automatically at/.test(schedulerStatus.textContent),
    schedulerStatus.textContent)

  startBtn.click()
  await wait(500)
  t('clicking Start in scheduled mode does nothing', stream === null)

  // ---- switching modes hands control over cleanly -------------------------
  await setMode('scheduled', at(-1), at(30))
  t('back inside a live window', await pollUntil(() => stream !== null, 20000))
  await setMode('manual', at(-1), at(30))
  t('switching to manual stops the scheduled session',
    await pollUntil(() => stream === null, 10000))
  t('buttons are usable again after the switch',
    startBtn.disabled === false && stopBtn.disabled === true)
  await wait(6000) // more than one scheduler tick
  t('manual mode stays idle even though the window is open', stream === null)

  const events = await window.api.listRecordings()
  t('no stray recordings were produced', events.length === 0, 'count=' + events.length)

  await window.api.setConfig({
    mode: 'manual',
    schedule: { start: '22:00', end: '08:00' },
    preBufferSeconds: 30,
    cooldownSeconds: 10,
    retentionDays: 14
  }).then(r => applyConfig(r.config))
  return R
})()
