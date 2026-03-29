/**
 * NotificationService
 * Handles browser notifications + Web Audio API sound alerts.
 * All prefs stored in localStorage so they survive page reload.
 */

type Severity = 'critical' | 'warning' | 'info' | 'ok'

interface NotifPrefs {
  soundEnabled:   boolean
  browserEnabled: boolean
  soundCritical:  boolean
  soundWarning:   boolean
  soundInfo:      boolean
  browserCritical:boolean
  browserWarning: boolean
  browserInfo:    boolean
}

const PREF_KEY = 'star_notif_prefs'
const COOLDOWN_MS = 10_000  // don't re-notify same fingerprint within 10s

const defaultPrefs: NotifPrefs = {
  soundEnabled:    true,
  browserEnabled:  true,
  soundCritical:   true,
  soundWarning:    true,
  soundInfo:       false,
  browserCritical: true,
  browserWarning:  true,
  browserInfo:     false,
}

class NotificationService {
  private audioCtx: AudioContext | null = null
  private cooldowns = new Map<string, number>()  // fingerprint → last notif timestamp

  // ─── Prefs ──────────────────────────────────────────────────
  getPrefs(): NotifPrefs {
    try {
      const raw = localStorage.getItem(PREF_KEY)
      return raw ? { ...defaultPrefs, ...JSON.parse(raw) } : { ...defaultPrefs }
    } catch {
      return { ...defaultPrefs }
    }
  }

  savePrefs(prefs: Partial<NotifPrefs>): void {
    const current = this.getPrefs()
    localStorage.setItem(PREF_KEY, JSON.stringify({ ...current, ...prefs }))
  }

  // ─── Permissions ────────────────────────────────────────────
  async requestBrowserPermission(): Promise<NotificationPermission> {
    if (!('Notification' in window)) return 'denied'
    if (Notification.permission === 'granted') {
      return 'granted'
    }
    const result = await Notification.requestPermission()
    return result
  }

  getBrowserPermission(): NotificationPermission {
    return 'Notification' in window ? Notification.permission : 'denied'
  }

  // ─── Main entry point ────────────────────────────────────────
  notify(alert: { severity: Severity; title: string; fingerprint?: string; source?: string }): void {
    const prefs = this.getPrefs()
    const fp = alert.fingerprint ?? alert.title
    const now = Date.now()

    // Cooldown check
    const last = this.cooldowns.get(fp)
    if (last && now - last < COOLDOWN_MS) return
    this.cooldowns.set(fp, now)

    const sev = alert.severity

    // Sound
    if (prefs.soundEnabled) {
      const shouldSound =
        (sev === 'critical' && prefs.soundCritical) ||
        (sev === 'warning'  && prefs.soundWarning)  ||
        (sev === 'info'     && prefs.soundInfo)
      if (shouldSound) this.playTone(sev)
    }

    // Browser notification
    if (prefs.browserEnabled && this.getBrowserPermission() === 'granted') {
      const shouldNotify =
        (sev === 'critical' && prefs.browserCritical) ||
        (sev === 'warning'  && prefs.browserWarning)  ||
        (sev === 'info'     && prefs.browserInfo)
      if (shouldNotify) this.showBrowserNotif(alert)
    }
  }

  // ─── Sound synthesis (Web Audio API — no files needed) ──────
  private getAudioCtx(): AudioContext {
    if (!this.audioCtx) {
      this.audioCtx = new AudioContext()
    }
    // Resume if suspended (browser autoplay policy)
    if (this.audioCtx.state === 'suspended') {
      this.audioCtx.resume()
    }
    return this.audioCtx
  }

  private playTone(severity: Severity): void {
    try {
      const ctx = this.getAudioCtx()
      const master = ctx.createGain()
      master.gain.value = 0.18
      master.connect(ctx.destination)

      const patterns: Record<Severity, Array<{ freq: number; start: number; dur: number }>> = {
        critical: [
          { freq: 880, start: 0,    dur: 0.12 },
          { freq: 880, start: 0.15, dur: 0.12 },
          { freq: 660, start: 0.30, dur: 0.22 },
        ],
        warning: [
          { freq: 660, start: 0,    dur: 0.15 },
          { freq: 550, start: 0.20, dur: 0.20 },
        ],
        info: [
          { freq: 440, start: 0, dur: 0.18 },
        ],
        ok: [
          { freq: 523, start: 0,    dur: 0.12 },
          { freq: 659, start: 0.15, dur: 0.18 },
        ],
      }

      const now = ctx.currentTime
      for (const { freq, start, dur } of patterns[severity]) {
        const osc  = ctx.createOscillator()
        const gain = ctx.createGain()
        osc.type = severity === 'critical' ? 'square' : 'sine'
        osc.frequency.value = freq
        gain.gain.setValueAtTime(0.8, now + start)
        gain.gain.exponentialRampToValueAtTime(0.001, now + start + dur)
        osc.connect(gain)
        gain.connect(master)
        osc.start(now + start)
        osc.stop(now + start + dur + 0.01)
      }
    } catch {
      // Audio not available — silent fail
    }
  }

  // ─── Browser notification ────────────────────────────────────
  private showBrowserNotif(alert: { severity: Severity; title: string; source?: string }): void {
    const icons: Record<Severity, string> = {
      critical: '🔴',
      warning:  '🟡',
      info:     '🔵',
      ok:       '🟢',
    }
    try {
      const n = new Notification(
        `${icons[alert.severity]} ${alert.severity.toUpperCase()} — ${alert.source ?? 'Alert'}`,
        {
          body: alert.title,
          tag:  alert.title,
          requireInteraction: alert.severity === 'critical',
        }
      )
      // Auto-close non-critical after 5s
      if (alert.severity !== 'critical') {
        setTimeout(() => n.close(), 5000)
      }
    } catch {
      // Notification blocked or not supported
    }
  }
}

export const notificationService = new NotificationService()
export type { NotifPrefs, Severity }
