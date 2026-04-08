import { useEffect, useRef, useState } from 'react'

const CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789.:/-_'

interface Props {
  text: string
  className?: string
  trigger?: boolean   // if true, scramble on mount; if undefined, scramble on hover
}

export function TextScramble({ text, className, trigger }: Props) {
  const [display, setDisplay] = useState(text)
  const raf   = useRef<ReturnType<typeof requestAnimationFrame> | null>(null)

  const scramble = () => {
    let iteration = 0
    const total = text.length * 2

    const step = () => {
      setDisplay(
        text.split('').map((ch, i) => {
          if (ch === ' ') return ' '
          if (i < iteration / 2) return text[i]
          return CHARS[Math.floor(Math.random() * CHARS.length)]
        }).join('')
      )
      iteration++
      if (iteration < total) {
        raf.current = requestAnimationFrame(step)
      } else {
        setDisplay(text)
      }
    }

    if (raf.current) cancelAnimationFrame(raf.current)
    raf.current = requestAnimationFrame(step)
  }

  useEffect(() => {
    setDisplay(text)
  }, [text])

  useEffect(() => {
    if (trigger) scramble()
  }, [trigger]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    return () => { if (raf.current) cancelAnimationFrame(raf.current) }
  }, [])

  const handlers = trigger === undefined
    ? { onMouseEnter: scramble }
    : {}

  return (
    <span
      className={`mono ${className ?? ''}`}
      style={{ cursor: trigger === undefined ? 'default' : undefined }}
      {...handlers}
    >
      {display}
    </span>
  )
}
