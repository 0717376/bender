import { useState, useEffect } from 'react'
import { checkAuthStatus } from './lib/api'
import { AuthScreen } from './components/AuthScreen'
import { WikiApp } from './components/WikiApp'

type Screen = 'loading' | 'auth' | 'app'

export default function App() {
  const [screen, setScreen] = useState<Screen>('loading')

  useEffect(() => {
    checkAuthStatus().then(ok => setScreen(ok ? 'app' : 'auth'))
  }, [])

  if (screen === 'loading') return null
  if (screen === 'auth') return <AuthScreen onSuccess={() => setScreen('app')} />
  return <WikiApp onLogout={() => setScreen('auth')} />
}
