// Test harness: boots the real app (registers its IPC handlers, loads the real
// renderer) and runs suite.js inside the live renderer.
const path = require('path')
const fs = require('fs')

const PROJECT = path.resolve(__dirname, '..')
require(path.join(PROJECT, 'main.js'))

const { app, BrowserWindow } = require('electron')

const consoleErrors = []

app.whenReady().then(async () => {
  let win = null
  for (let i = 0; i < 150 && !win; i++) {
    const all = BrowserWindow.getAllWindows()
    if (all.length) win = all[0]
    else await new Promise(r => setTimeout(r, 100))
  }
  if (!win) {
    console.log('SELFTEST_FATAL no window created')
    app.exit(1)
    return
  }

  win.webContents.on('console-message', (ev, level, message, line, sourceId) => {
    // level 2 = warning, 3 = error
    if (level >= 2) consoleErrors.push(level + ': ' + message + ' (' + sourceId + ':' + line + ')')
  })

  if (win.webContents.isLoading()) {
    await new Promise(r => win.webContents.once('did-finish-load', r))
  }
  await new Promise(r => setTimeout(r, 600)) // let bootstrap finish

  try {
    const suiteArg = process.argv.find(a => a.startsWith('--suite='))
    const suite = suiteArg ? suiteArg.slice('--suite='.length) : 'suite.js'
    const src = fs.readFileSync(path.join(__dirname, path.basename(suite)), 'utf8')
    const results = await win.webContents.executeJavaScript(src, true)
    const failed = results.filter(r => !r.pass)
    console.log('SELFTEST_BEGIN')
    for (const r of results) {
      console.log((r.pass ? '  PASS  ' : '  FAIL  ') + r.name + (r.info ? '   [' + r.info + ']' : ''))
    }
    console.log('SELFTEST_SUMMARY ' + (results.length - failed.length) + '/' + results.length + ' passed')
    if (consoleErrors.length) {
      console.log('SELFTEST_CONSOLE')
      consoleErrors.forEach(e => console.log('  ' + e))
    } else {
      console.log('SELFTEST_CONSOLE clean (no renderer warnings or errors)')
    }
    console.log('SELFTEST_END')
    app.exit(failed.length === 0 ? 0 : 1)
  } catch (err) {
    console.log('SELFTEST_FATAL ' + (err && err.stack ? err.stack : String(err)))
    app.exit(1)
  }
})
