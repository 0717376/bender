import { useState } from 'react'
import { login } from '../lib/api'
import { setToken } from '../lib/auth'
import styles from './AuthScreen.module.css'
import { t } from '../lib/i18n'

interface AuthScreenProps {
  onSuccess: () => void
}

export function AuthScreen({ onSuccess }: AuthScreenProps) {
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!password || busy) return
    setBusy(true)
    setError('')
    const res = await login(password)
    setBusy(false)
    if (res.token) {
      setToken(res.token)
      onSuccess()
    } else {
      setError(res.error || t('loginError'))
    }
  }

  return (
    <div className={styles.screen}>
      <form className={styles.box} onSubmit={submit}>
        <h1 className={styles.title}>Wiki</h1>
        <input
          className={styles.input}
          type="password"
          placeholder={t('password')}
          value={password}
          autoFocus
          onChange={e => setPassword(e.target.value)}
        />
        {error && <div className={styles.error}>{error}</div>}
        <button className={styles.btn} type="submit" disabled={busy}>
          {busy ? '…' : t('signIn')}
        </button>
      </form>
    </div>
  )
}
