import { useEffect, useState } from 'react'

const formatter = new Intl.DateTimeFormat('ru-RU', { timeZone: 'Europe/Moscow', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })
export const moscowTime = (date = Date.now()) => formatter.format(new Date(date))
export default function MoscowClock() {
  const [time, setTime] = useState(() => moscowTime())
  useEffect(() => { const timer = setInterval(() => setTime(moscowTime()), 1000); return () => clearInterval(timer) }, [])
  return <span className="moscow-clock" title="Московское время">{time} МСК</span>
}
