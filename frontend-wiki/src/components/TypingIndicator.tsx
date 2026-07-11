import styles from './TypingIndicator.module.css'

export function TypingIndicator() {
  return (
    <div className={styles.typingIndicator}>
      <div className={styles.typing}>
        <span></span>
        <span></span>
        <span></span>
      </div>
    </div>
  )
}
