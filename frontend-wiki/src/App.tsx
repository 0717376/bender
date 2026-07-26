import { useState, useEffect } from 'react'
import { checkAuthStatus } from './lib/api'
import { AuthScreen } from './components/AuthScreen'
import { WikiApp } from './components/WikiApp'
import { UiProvider } from './components/Ui'

type Screen = 'loading' | 'auth' | 'app'

export default function App() {
  const [screen, setScreen] = useState<Screen>('loading')

  useEffect(() => {
    checkAuthStatus().then(ok => setScreen(ok ? 'app' : 'auth'))
  }, [])

  return (
    <UiProvider>
      {screen === 'auth' && <AuthScreen onSuccess={() => setScreen('app')} />}
      {screen === 'app' && <WikiApp onLogout={() => setScreen('auth')} />}
    </UiProvider>
  )
}
