import { useEffect, useState } from 'react'

import type { DesktopAppInfo, PetState, PlatformInfo } from '../../shared/ipc-channels'

function App(): React.JSX.Element {
  const route = window.location.hash.replace(/^#/, '') || '/'

  if (route === '/pet') {
    return <PetWindow />
  }

  return <MainWindow />
}

function MainWindow(): React.JSX.Element {
  const [appInfo, setAppInfo] = useState<DesktopAppInfo | null>(null)
  const [platform, setPlatform] = useState<PlatformInfo | null>(null)
  const [petState, setPetState] = useState<PetState | null>(null)
  const [isMaximized, setIsMaximized] = useState(false)
  const [events, setEvents] = useState<string[]>([])

  useEffect(() => {
    void refreshState()

    const offMessage = window.desktop.events.onMainProcessMessage((message) => {
      pushEvent(`main loaded at ${message}`)
    })
    const offMaximized = window.desktop.window.onMaximizedChanged((value) => {
      setIsMaximized(value)
      pushEvent(value ? 'window maximized' : 'window restored')
    })

    return () => {
      offMessage()
      offMaximized()
    }
  }, [])

  const refreshState = async (): Promise<void> => {
    const [info, platformInfo, maximized, pet] = await Promise.all([
      window.desktop.app.getInfo(),
      window.desktop.app.getPlatform(),
      window.desktop.window.isMaximized(),
      window.desktop.pet.getState()
    ])

    setAppInfo(info)
    setPlatform(platformInfo)
    setIsMaximized(maximized)
    setPetState(pet)
  }

  const runAction = async (label: string, action: () => Promise<unknown>): Promise<void> => {
    try {
      await action()
      await refreshState()
      pushEvent(label)
    } catch (error) {
      pushEvent(`${label} failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const pushEvent = (message: string): void => {
    setEvents((current) => [message, ...current].slice(0, 6))
  }

  return (
    <main className="desktop-shell">
      <header className="titlebar">
        <div>
          <p className="eyebrow">Desktop Template</p>
          <h1>OpenHarness Desktop Console</h1>
        </div>
        <div className="window-actions" aria-label="Window controls">
          <button type="button" onClick={() => void window.desktop.window.minimize()}>
            Minimize
          </button>
          <button type="button" onClick={() => void window.desktop.window.toggleMaximize()}>
            {isMaximized ? 'Restore' : 'Maximize'}
          </button>
          <button type="button" onClick={() => void window.desktop.window.close()}>
            Close
          </button>
        </div>
      </header>

      <section className="status-grid" aria-label="Desktop status">
        <StatusTile label="App" value={appInfo?.name ?? 'OpenHarness'} detail={appInfo?.version} />
        <StatusTile label="Platform" value={platform?.platform ?? 'unknown'} detail={platform?.isWindows ? 'Windows' : platform?.isMac ? 'macOS' : platform?.isLinux ? 'Linux' : undefined} />
        <StatusTile
          label="Pet"
          value={petState?.visible ? 'Visible' : 'Hidden'}
          detail={petState?.alwaysOnTop ? 'Always on top' : 'Normal layer'}
        />
        <StatusTile
          label="Click-through"
          value={petState?.ignoreMouseEvents ? 'On' : 'Off'}
          detail="Useful for display-only desktop mode"
        />
      </section>

      <section className="workspace">
        <div className="panel">
          <h2>Window</h2>
          <div className="button-row">
            <button type="button" onClick={() => void runAction('show main window', window.desktop.window.showMain)}>
              Show main
            </button>
            <button type="button" onClick={() => void runAction('flash tray', window.desktop.tray.flash)}>
              Flash tray
            </button>
            <button type="button" onClick={() => void runAction('stop tray flash', window.desktop.tray.stopFlash)}>
              Stop flash
            </button>
            <button
              type="button"
              onClick={() =>
                void runAction('send notification', () =>
                  window.desktop.tray.notify({
                    title: 'OpenHarness',
                    body: 'Desktop notification bridge is wired.',
                    showWhenFocused: true
                  })
                )
              }
            >
              Notify
            </button>
          </div>
        </div>

        <div className="panel">
          <h2>Desktop Pet</h2>
          <div className="button-row">
            <button type="button" onClick={() => void runAction('show pet', window.desktop.pet.show)}>
              Show pet
            </button>
            <button type="button" onClick={() => void runAction('hide pet', window.desktop.pet.hide)}>
              Hide pet
            </button>
            <button type="button" onClick={() => void runAction('toggle pet', window.desktop.pet.toggle)}>
              Toggle pet
            </button>
            <button
              type="button"
              onClick={() =>
                void runAction('toggle pet always-on-top', () =>
                  window.desktop.pet.setAlwaysOnTop(!petState?.alwaysOnTop)
                )
              }
            >
              {petState?.alwaysOnTop ? 'Unset top' : 'Always on top'}
            </button>
            <button
              type="button"
              onClick={() =>
                void runAction('toggle pet click-through', () =>
                  window.desktop.pet.setIgnoreMouseEvents(!petState?.ignoreMouseEvents)
                )
              }
            >
              {petState?.ignoreMouseEvents ? 'Disable pass-through' : 'Enable pass-through'}
            </button>
          </div>
        </div>

        <div className="panel event-panel">
          <h2>Events</h2>
          <ol aria-live="polite">
            {events.length ? (
              events.map((event) => <li key={event}>{event}</li>)
            ) : (
              <li>Waiting for desktop events</li>
            )}
          </ol>
        </div>
      </section>
    </main>
  )
}

function StatusTile({
  label,
  value,
  detail
}: {
  label: string
  value: string
  detail?: string
}): React.JSX.Element {
  return (
    <article className="status-tile">
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{detail ?? 'ready'}</small>
    </article>
  )
}

function PetWindow(): React.JSX.Element {
  const [time, setTime] = useState(() => new Date().toLocaleTimeString())

  useEffect(() => {
    const timer = setInterval(() => {
      setTime(new Date().toLocaleTimeString())
    }, 1000)

    return () => clearInterval(timer)
  }, [])

  return (
    <main className="pet-shell" aria-label="OpenHarness Pet">
      <div className="pet-drag-region">
        <div className="pet-mark">OH</div>
        <div>
          <strong>OpenHarness</strong>
          <span>{time}</span>
        </div>
      </div>
      <button type="button" className="pet-close" onClick={() => void window.desktop.pet.hide()}>
        Hide
      </button>
    </main>
  )
}

export default App
