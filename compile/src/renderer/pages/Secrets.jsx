import { useEffect, useMemo, useRef, useState } from 'react'

const CODE_ALIASES = { secret_midnight_start: 'secret_midnight_premiere', secret_exchange: 'secret_equivalent_exchange', secret_midnight_anomaly: 'secret_anomaly_midnight' }
const NAME_ALIASES = { 'ровно в полночь': 'полночная премьера', 'тайминг': 'внахлёст', 'отошел за чаем': 'ушёл за чаем', 'отошёл за чаем': 'ушёл за чаем', 'ушел за чаем': 'ушёл за чаем' }
const ACHIEVEMENT_DETAILS = {
  'ушёл за чаем': { description: 'Чай остыл.', steps: `1. Начните смотреть серию.
2. Поставьте её на паузу на один час или дольше.
3. Снимите с паузы и досмотрите серию до конца.` },
  'za warudo': { description: 'Токи во томарэ.', steps: `1. Во время просмотра поставьте серию на паузу на 9-й секунде (допуск: от 8,5 до 9,5 секунды).
2. Возобновите воспроизведение.
3. Повторите такую паузу три раза за одну серию, возвращаясь к нужному моменту.` },
  'теневое клонирование': { description: 'Каге Буншин но Дзюцу!', steps: 'Откройте AnimeOn одновременно как минимум в пяти вкладках одного браузера.' },
  'слоу-мо': { description: 'Каждый кадр — картина.', steps: `1. Включите серию на скорости 0,5×.
2. Смотрите на этой скорости не менее 90% проигранного времени.
3. Доведите прогресс просмотра до 80% длительности серии.` },
  'возвращение смертью': { description: 'Снова здесь. Снова с начала.', steps: `1. Начните смотреть серию и дождитесь момента после 10-й секунды.
2. Перемотайте в самое начало, на первые 0–2 секунды.
3. Повторите это минимум семь раз.
4. Досмотрите серию до конца: прогресс должен достичь 80%, а реально проигранное время — минимум 60%.

На коротком тайтле условие не работает.` },
  'код на память': {
    description: 'Вверх, вверх, вниз, вниз... дальше ты помнишь.',
    steps: `1. Откройте главную страницу AnimeOn.
2. Переключите клавиатуру на английскую раскладку.
3. Последовательно нажмите:
↑ ↑ ↓ ↓ ← → ← → B A

Проще всего выполнить с компьютера. На телефоне понадобится экранная клавиатура, способная отправлять стрелки и клавиши B/A.`
  },
  iddqd: {
    description: 'Некоторые коды переживают свои игры.',
    steps: `1. Откройте раздел с аниме.
2. Нажмите на строку поиска тайтлов.
3. Введите IDDQD.
4. Нажмите Enter или кнопку поиска.

Вводить нужно именно в поиск аниме, а не в адресную строку браузера.`
  },
  'не туда свернул': {
    description: 'Иногда самое интересное там, где ничего нет.',
    steps: `1. Откройте любую несуществующую страницу AnimeOn.
2. Например: https://animeon.cc/2501
3. Дождитесь появления страницы ошибки 404.

Для получения достижения достаточно попасть на страницу 404. Нажимать на призрака не требуется.`
  },
  '13:37': {
    description: 'Одна минута в сутках, которую помнят все.',
    steps: `1. Заранее откройте любую серию.
2. В 13:37 по московскому времени запустите просмотр.
3. Оставьте серию включённой до окончания этой минуты.
4. Убедитесь, что просмотр засчитался сайтом.

Ориентироваться нужно именно на московское время.`
  },
  дежавю: {
    description: 'Один и тот же тайтл целиком. Трижды.',
    steps: `1. Выберите короткий тайтл, желательно состоящий из одной серии.
2. Полностью посмотрите его.
3. Повторите полный просмотр этого же тайтла ещё два раза.
4. Каждый просмотр должен отдельно засчитаться в истории.

В чате использовали тайтл «Чей-то взгляд»: у него одна короткая серия.

Простое обновление страницы не считается. Нужно три раза добиться полного засчитывания просмотра.`
  },
  'три часа ночи': {
    steps: `1. Зайдите на AnimeOn ночью после 03:00.
2. Побудьте на сайте некоторое время.
3. Повторяйте это в течение семи дней.

Главное условие: семь дней находиться на сайте ночью после 03:00.

Нулевой онлайн не требуется. Ждать, когда на сайте никого не будет, тоже не нужно. Условие про отдельное трёхминутное окно было ошибочным.`
  },
  ровесник: {
    description: 'Кто-то вышел в эфир в один день с тобой.',
    steps: `1. Откройте свой профиль.
2. Посмотрите дату регистрации аккаунта.
3. Найдите аниме с такой датой выхода.
4. Откройте найденный тайтл.
5. Запустите серию и дождитесь, пока просмотр засчитается.

Если достижение не появляется сразу, продолжите просмотр до момента фактического засчитывания серии.

Если в каталоге нет подходящего тайтла, подтверждённого обходного способа пока нет.`
  },
  'первая минута': {
    description: 'Аномалии не спят в полночь.',
    steps: `1. Заранее откройте AnimeOn.
2. Дождитесь 00:00 по московскому времени.
3. В первую минуту новых суток найдите появившуюся аномальную сущность.
4. Нажмите на неё и заберите.

Не путайте с достижением «Ровно в полночь». Здесь нужно именно поймать аномалию.`
  },
  'полночная премьера': {
    description: 'Новые сутки начинаются с первого кадра.',
    steps: `1. Заранее откройте страницу любой серии.
2. Подготовьте плеер к запуску.
3. Ровно в 00:00 по московскому времени начните просмотр.
4. Убедитесь, что видео действительно запустилось.

Не путайте с «Первой минутой»: здесь нужно начать просмотр, а не ловить аномалию.`
  },
  'все голоса': {
    description: 'У этого тайтла не осталось голоса, которого ты не слышал.',
    steps: `1. Найдите тайтл с несколькими доступными озвучками.
2. Выберите первую озвучку.
3. Посмотрите серию до момента засчитывания просмотра.
4. Переключитесь на следующую озвучку.
5. Повторите это для всех доступных озвучек тайтла.

Простого переключения озвучки недостаточно. Просмотр каждой версии должен отдельно засчитаться в истории.

В чате часто использовали «Чей-то взгляд»: одна серия и несколько озвучек.

У некоторых достижение появлялось с задержкой. После последней озвучки обновите страницу и проверьте профиль.`
  },
  'внахлёст': {
    description: 'Ты закрыл серию ровно в ту минуту, когда вышла следующая.',
    steps: `1. Выберите выходящий онгоинг с известным временем публикации новой серии.
2. Последняя доступная серия не должна быть заранее отмечена просмотренной.
3. Откройте эту серию перед выходом следующей.
4. В минуту публикации новой серии завершите просмотр предыдущей.
5. Дождитесь, пока сайт отметит её просмотренной.

По сообщениям участников, просмотр может засчитываться примерно за минуту до окончания серии.

Если достижение не появилось:
1. Перейдите к эндингу.
2. Завершите просмотр.
3. Обновите страницу.
4. Повторно доведите серию до засчитывания.

Ачивка иногда срабатывает не с первой попытки или появляется с задержкой.`
  },
  'на флажке': {
    description: 'Закрыть последнее задание дня в последнюю минуту суток.',
    steps: `1. Выполните все ежедневные задания, кроме одного.
2. Оставьте на конец самое простое задание.
3. Подготовьте последнее необходимое действие заранее.
4. В 23:59 по московскому времени завершите это задание.
5. Оно должно стать последним закрытым заданием дня.`
  },
  'свидетель патча': {
    description: 'Мир моргнул. Ты это видел.',
    steps: `1. Находиться на AnimeOn в момент установки обновления сайта.
2. Лучше держать сайт открытым или смотреть серию.
3. После выхода обновления перезагрузить страницу.
4. Проверить список достижений.

Заранее выбрать время выполнения нельзя: достижение зависит от реального выхода обновления.

Нулевой онлайн для этой ачивки не требуется, в чате был случай получения примерно в 23:30 во время обновления сайта.`
  },
  'равноценный обмен': {
    steps: `1. Дождитесь полуночи и начала нового дня.
2. Получите ежедневный бонус.
3. Откройте магазин.
4. Купите том опыта на общую сумму ровно 630 очков.
5. После покупки достижение должно засчитаться.

Секретное достижение выполнять не нужно. Весь способ связан только с ежедневным бонусом и покупкой томов опыта в магазине.

630 — это общая сумма покупки томов опыта, а не количество очков, которое должно появиться после ежедневного бонуса.`
  },
  'ноль в ноль': {
    description: 'Ровно столько. Ни единицей больше.',
    steps: `Точное условие пока не подтверждено.

Основная версия: получить точное круглое значение общего XP без остатка. Например:
1000 XP
2000 XP
10000 XP
100000 XP

Обычная шкала профиля может округлять количество опыта. Для проверки точного значения используйте точные данные профиля AnimeOn.

В чате был случай случайного получения достижения во время просмотра серии, но точное значение XP и последовательность действий тогда не записали.`
  },
  'двадцать четвёртый кадр': {
    description: 'Моргнёшь — пропустишь.',
    steps: `Во время анимации получения другой скрытой ачивки на долю секунды появляется персональный код. Его нужно успеть сохранить и активировать через поиск аниме.

Как выполнить с компьютера:
1. Выберите любую скрытую ачивку, которую ваш аккаунт ещё не получил.
2. До её выполнения запустите NYA Logger.
3. Перезагрузите страницу AnimeOn.
4. Выполните выбранное скрытое достижение.
5. Дождитесь полной анимации получения.
6. Посмотрите найденный код в панели логгера или выгруженном файле.
7. Введите полученный код в поиск аниме.
8. После правильного ввода кот замурлычет.
9. Проверьте получение «Двадцать четвёртого кадра».

Как выполнить через запись экрана:
1. До получения новой скрытой ачивки включите запись экрана.
2. Выполните достижение.
3. Не закрывайте анимацию сразу.
4. Остановите запись.
5. Просмотрите видео покадрово.
6. Найдите момент появления кода.
7. Перепишите код.
8. Введите его в поиск аниме.

На телефоне проще использовать системную запись экрана. Если вместо сайта записался экран, попробуйте другой браузер или выполните достижение с компьютера через NYA Logger.

Коду у каждого аккаунта свой. Чужой код не подойдёт.

Если анимация уже прошла и код не был сохранён, понадобится другая скрытая ачивка, которую аккаунт ещё не выполнял. Повторное появление кода после уже закрытого достижения работает нестабильно.`
  },
  idkfa: {
    description: 'Все ключи. Всё оружие.',
    steps: `1. Сначала получите IDDQD.
2. Получите «Десять жизней».
3. Получите 2501.
4. Получите «Двадцать четвёртый кадр».
5. Откройте скрытый терминал /2501.
6. Введите IDKFA.

При выполненных условиях терминал ответит: «Все ключи. Всё оружие».`
  },
  'омэдэто': {
    description: 'Все хлопают.',
    steps: `1. Полностью посмотрите «Евангелион нового поколения» (Neon Genesis Evangelion) 1995 года.
2. Полностью посмотрите «Евангелион нового поколения: Смерть и перерождение» (Neon Genesis Evangelion: Death & Rebirth).
3. Полностью посмотрите «Евангелион нового поколения: Конец Евангелиона» (The End of Evangelion).
4. Важно: просмотр засчитывается только при полном просмотре всех трёх тайтлов на скорости х1 без перемотки!
5. Дождитесь, пока просмотр всех трёх тайтлов засчитается в профиле.`
  },
  'хроника по порядку': {
    description: 'Так, как это выходило.',
    steps: `1. Откройте блок «Хронология франшизы» (проверено и подтверждено на «Доктор Стоун» / Dr. STONE).
2. Посмотрите все сезоны и спецвыпуски франшизы строго по порядку выхода:
• 1. Доктор Стоун (2019, TV Сериал)
• 2. Доктор Стоун: Каменные войны (2020, Спецвыпуск)
• 3. Доктор Стоун: Каменные войны (2021, TV Сериал)
• 4. Доктор Стоун: Рюсуй (2022, TV Спецвыпуск)
• 5. Доктор Стоун: Новый мир (2023, TV Сериал)
• 6. Доктор Стоун: Новый мир. Часть 2 (2023, TV Сериал)
• 7. Доктор Стоун: Научное будущее (2025, TV Сериал)
• 8. Доктор Стоун: Научное будущее... (2025, TV Сериал)
• 9. Доктор Стоун: Научное будущее... (2026, TV Сериал)
3. Дождитесь полного засчитывания просмотра всех частей в профиле.

Награда: 300 Трофеев, 500 AniMON (Легендарное достижение, раздел «Просмотр»).
Примечание: возможно, условие работает и для других франшиз с блоком хронологии, либо привязано исключительно к «Доктору Стоуну».`
  }
}
const BASE_SECRETS = [
  ['secret_iddqd', 'IDDQD', 'Раздел «Аниме»: ввести IDDQD в поиск, Enter'], ['secret_konami', 'Код на память', 'На главной с компьютера: ↑↑↓↓←→←→BA, английская раскладка'], ['secret_deep_night', 'Три часа ночи', '7 раз зайти около 03:00 МСК, когда на сайте никого нет'], ['secret_rewatch', 'Дежавю', 'Полностью посмотреть один тайтл трижды'], ['secret_leet_minute', '13:37', 'Смотреть аниме в 13:37 по Москве'], ['secret_not_found', 'Не туда свернул', 'Открыть несуществующую страницу (ошибка 404)'], ['secret_round_xp', 'Ноль в ноль', 'Круглый общий опыт (например, 1000 или 2000 XP)'], ['secret_witness', 'Свидетель патча', 'Быть на сайте в момент установки обновления'], ['secret_midnight_start', 'Полночная премьера', 'Начать просмотр аниме ровно в 00:00 МСК'], ['secret_same_day_release', 'Ровесник', 'Начать смотреть аниме, вышедшее в день твоей регистрации'], ['secret_frame_24', 'Двадцать четвёртый кадр', 'Код из анимации другой секретки — в поиск на главной'], ['secret_exchange', 'Равноценный обмен', 'Потратить ровно столько монеток, сколько заработал после 00:00'], ['secret_binge_finish', 'Тайминг', 'Досмотреть к релизу новой серии'], ['secret_midnight_anomaly', 'Первая минута', 'Поймать аномальную сущность ровно в 00:00 МСК'], ['secret_nine_lives', 'Девять жизней', 'Собрать 9 кодов формата NYA-****-****'], ['secret_2501', '2501', 'Пройти 2 этап в терминале'], ['secret_thousand_minus_seven', '1000-7', 'Вписать в консоль 1000-7'], ['secret_last_second', 'На флажке', 'Завершить последнее задание дня в 23:59 МСК'], ['secret_third_september', 'Третье сентября', 'Я календарь переверну — и снова третье сентября.'], ['secret_omedeto', 'Омэдэто', 'Посмотреть полностью Евангелион (1995), Смерть и перерождение и Конец Евангелиона на скорости х1 без перемотки'], [null, 'Хроника по порядку', 'Посмотреть аниме франшизу по порядку выхода (проверено на «Доктор Стоун»)'], [null, 'Все голоса', 'Минимум по серии в каждой озвучке одного тайтла'], [null, 'Внахлёст', 'Закончить последнюю серию в момент выхода новой']
].filter(([, name]) => name !== 'Тайминг').map(([code, name, desc], index) => { const resolved = CODE_ALIASES[code] || code; return { code: resolved, key: resolved || `community_${index}`, name, desc, category: 'standard' } })
for (const name of ['Za Warudo', 'Теневое клонирование', 'Слоу-мо', 'Возвращение смертью', 'Ушёл за чаем']) {
  BASE_SECRETS.push({ code: null, key: 'guide_' + name.toLowerCase(), name, desc: ACHIEVEMENT_DETAILS[name.toLowerCase()].description, category: 'standard' })
}
BASE_SECRETS.push({ code: 'secret_idkfa', key: 'secret_idkfa', name: 'IDKFA', desc: 'Открыть скрытый терминал /2501 после выполнения условий.', category: 'standard' })
const IMPOSSIBLE_SECRETS = [{ key: 'impossible_first_key', code: null, name: 'Первый ключ', desc: 'Ты был первым. Это уже не изменить.', category: 'impossible', holder: 'kattwod' }]
const OBSOLETE = new Set(['secret_anniversary', 'secret_registration_date', 'secret_registration', 'secret_quest_deadline', 'secret_midnight_start', 'secret_exchange', 'secret_midnight_anomaly'])

const rawCodeOf = item => {
  const direct = item?.code || item?.slug || item?.achievement_code || item?.achievement_key || item?.achievementKey
  const key = String(item?.key || '').trim()
  return String(direct || (isSecretCode(key.toLowerCase()) ? key : '')).trim().toLowerCase()
}
const codeOf = item => CODE_ALIASES[rawCodeOf(item)] || rawCodeOf(item)
const rawNameOf = item => String(item?.name || item?.title || item?.achievement_name || '').trim()
const nameOf = item => { const name = rawNameOf(item).toLowerCase(); return NAME_ALIASES[name] || name }
const detailsFor = item => ACHIEVEMENT_DETAILS[nameOf(item)] || null
const isSecretCode = code => code.startsWith('secret_') || code.startsWith('secret-')
const isCompleted = item => item?.completed === true || item?.is_completed === true || item?.isCompleted === true || item?.unlocked === true || item?.status === 'completed' || Boolean(item?.unlocked_at || item?.completed_at || item?.received_at)
const isImpossible = item => item?.category === 'impossible' || nameOf(item) === 'первый ключ'
const isSecretRemote = item => {
  const kind = String(item?.type || item?.category || item?.group || '').toLowerCase()
  return (Boolean(nameOf(item)) && BASE_SECRETS.some(secret => nameOf(secret) === nameOf(item))) || isSecretCode(codeOf(item)) || item?.is_secret === true || item?.isSecret === true || kind === 'secret' || kind === 'secrets'
}

// Не используем key интерфейса как код API. Если сайт отдаст секретку без
// secret_*, фиксируем её по имени и не теряем при следующих синхронизациях.
const collectRemoteSecrets = (value, found = new Map(), seen = new WeakSet(), parentKey = '') => {
  const inheritedCode = isSecretCode(String(parentKey).toLowerCase()) ? String(parentKey).trim().toLowerCase() : ''
  if (value === null || value === undefined) return found
  if (typeof value !== 'object') {
    if (inheritedCode && value !== false && value !== 0 && value !== '') found.set(inheritedCode, { code: inheritedCode, received: true })
    return found
  }
  if (seen.has(value)) return found
  seen.add(value)
  if (Array.isArray(value)) { value.forEach((item, index) => collectRemoteSecrets(item, found, seen, String(index))); return found }
  const code = codeOf(value) || inheritedCode
  const candidate = code && !codeOf(value) ? { ...value, code } : value
  const name = nameOf(candidate)
  if (isSecretRemote(candidate) && !OBSOLETE.has(code)) found.set(code || `name:${name}`, candidate)
  Object.entries(value).forEach(([key, item]) => collectRemoteSecrets(item, found, seen, key))
  return found
}

const LockIcon = () => <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="5" y="10" width="14" height="10" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3" /></svg>
const SparkIcon = () => <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="m12 3 1.5 5.5L19 10l-5.5 1.5L12 17l-1.5-5.5L5 10l5.5-1.5L12 3Z"/><path d="m19 16 .7 2.3L22 19l-2.3.7L19 22l-.7-2.3L16 19l2.3-.7L19 16Z"/></svg>

export default function Secrets() {
  const [achievements, setAchievements] = useState(null)
  const [catalog, setCatalog] = useState([...BASE_SECRETS, ...IMPOSSIBLE_SECRETS])
  const [synced, setSynced] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [query, setQuery] = useState('')
  const syncGeneration = useRef(0)
  const [cursorHint, setCursorHint] = useState(null)

  const showCursorHint = (event, item) => {
    if (!detailsFor(item)) return
    setCursorHint({ item, x: event.clientX, y: event.clientY })
  }
  const hideCursorHint = () => setCursorHint(null)
  useEffect(() => { const close = event => { if (event.key === 'Escape') setCursorHint(null) }; window.addEventListener('keydown', close); return () => window.removeEventListener('keydown', close) }, [])

  const mergeCatalog = (previous, remote) => {
    const next = [...previous]
    remote.forEach(item => {
      const index = next.findIndex(secret => (item.code && codeOf(secret) === item.code) || (nameOf(secret) && nameOf(secret) === nameOf(item)))
      if (index >= 0) next[index] = { ...next[index], ...item, category: isImpossible(next[index]) ? 'impossible' : item.category }
      else next.push(item)
    })
    return next
  }

  const sync = async () => {
    const generation = ++syncGeneration.current
    setLoading(true); setError('')
    setAchievements(null); setSynced(false)
    try {
      const result = await window.api?.achievementsFetch()
      if (generation !== syncGeneration.current) return
      if (!result?.ok) { setError(String(result?.error) === '401' ? 'Войдите в аккаунт AnimeOn для синхронизации' : 'Не удалось загрузить достижения'); return }
      setAchievements(result.data)
      const remote = [...collectRemoteSecrets(result.data)].map(([identity, item]) => {
        const code = codeOf(item), name = rawNameOf(item) || code || 'Неизвестная секретка'
        return { key: code || identity, sourceIdentity: identity, code: code || null, name, desc: String(item?.description || item?.desc || item?.hint || 'Секретка из профиля AnimeOn'), received: true, completed: isCompleted(item), category: isImpossible(item) ? 'impossible' : 'standard' }
      })
      setCatalog(previous => {
        const next = mergeCatalog(previous, remote)
        window.api?.storeSet?.('secretsCatalog', next)
        return next
      })
      setSynced(true)
    } catch (reason) { if (generation === syncGeneration.current) setError(String(reason)) } finally { if (generation === syncGeneration.current) setLoading(false) }
  }

  useEffect(() => {
    const bootstrap = async () => {
      const saved = await window.api?.storeGet?.('secretsCatalog')
      if (Array.isArray(saved) && saved.length) {
        const savedSecrets = saved.filter(item => !OBSOLETE.has(codeOf(item)) && (item?.received || isSecretCode(codeOf(item)) || isImpossible(item) || !codeOf(item)))
        setCatalog(mergeCatalog([...BASE_SECRETS, ...IMPOSSIBLE_SECRETS], savedSecrets))
      }
      await sync()
    }
    bootstrap()
    const unsubscribe = window.api?.onAccountsUpdated?.(() => { setAchievements(null); setSynced(false); sync() })
    return () => { syncGeneration.current++; unsubscribe?.() }
  }, [])

  const remoteEntries = useMemo(() => [...collectRemoteSecrets(achievements)].map(([identity, item]) => ({ identity, code: codeOf(item), name: nameOf(item), item })), [achievements])
  const allSecrets = useMemo(() => catalog.filter(item => item?.key && !OBSOLETE.has(codeOf(item))), [catalog])
  const standardSecrets = useMemo(() => allSecrets.filter(item => !isImpossible(item)), [allSecrets])
  const impossibleSecrets = useMemo(() => allSecrets.filter(isImpossible), [allSecrets])
  const stateFor = item => {
    const code = codeOf(item), name = nameOf(item)
    const remote = remoteEntries.find(entry => (code && entry.code === code) || (name && entry.name === name))
    const done = Boolean(synced && remote)
    return { ...item, name: nameOf(item) === 'ушёл за чаем' ? 'Ушёл за чаем' : item.name, desc: detailsFor(item)?.description || remote?.item?.description || (nameOf(item) === 'три часа ночи' ? 'Семь ночей после 03:00.' : item.desc), code, done, visibleCode: synced && done && code ? code : '······' }
  }
  const displayed = standardSecrets.map(stateFor).filter(item => (item.name + ' ' + (item.code || '')).toLowerCase().includes(query.trim().toLowerCase()))

  const received = standardSecrets.filter(item => stateFor(item).done).length
  const percent = standardSecrets.length ? Math.round(received / standardSecrets.length * 100) : 0

  const selectedDetails = cursorHint ? detailsFor(cursorHint.item) : null
  const section = (title, items) => items.length > 0 && <section className="signal-secret-group"><div className="signal-kicker">{title} · {items.length}</div>{items.map(item => <article key={item.key} className={'signal-secret-row' + (item.done ? ' done' : '')}><span className="signal-secret-number">{String(standardSecrets.findIndex(secret => secret.key === item.key) + 1).padStart(2, '0')}</span><div className="signal-secret-copy"><h2>{item.name}</h2><p>{item.desc}</p></div><small>{item.done ? 'получено' : synced ? 'не открыто' : 'не проверено'}</small>{detailsFor(item) && <button className="signal-hint" aria-label={'Инструкция: ' + item.name} onClick={event => showCursorHint(event, item)}>?</button>}</article>)}</section>
  return <div className="signal-page">
    <div className="signal-kicker">КОЛЛЕКЦИЯ · {synced ? received : '—'}/{standardSecrets.length} · {synced ? percent + '%' : 'не синхронизировано'}</div>
    <h1>Секреты</h1><p className="signal-lede">Скрытые задания AnimeOn. Нажми на ? — покажем, как выполнить.</p>
    <div className="signal-search"><input value={query} onChange={event => setQuery(event.target.value)} placeholder="Найти секрет…" aria-label="Найти секрет" /><button className="signal-primary" onClick={sync} disabled={loading}>{loading ? 'Загрузка…' : 'Синхронизировать'}</button></div>
    {error && <p role="alert" className="signal-note">{error}. Проверьте вкладку AnimeOn и вход в аккаунт.</p>}
    {!query.trim() && impossibleSecrets.map(item => <details key={item.key} className="signal-impossible-spoiler"><summary>Секретка в единственном экземпляре</summary><article className="signal-impossible"><small>ЕДИНСТВЕННАЯ В МИРЕ · ВНЕ КОЛЛЕКЦИИ</small><h2>{item.name}</h2><p>{item.desc}</p><footer><span>Владелец: <button onClick={() => window.api?.tabsCreate?.('https://v2.animeon.co/user/' + item.holder)}>{item.holder}</button></span><span>недостижима</span></footer></article></details>)}
    {section(synced ? 'ОСТАЛОСЬ ПОЛУЧИТЬ' : 'КОЛЛЕКЦИЯ', displayed.filter(item => !item.done))}
    {section('ПОЛУЧЕНО', displayed.filter(item => item.done))}
    {!displayed.length && <div className="signal-empty"><b>Ничего не найдено</b><p>Попробуй другое название или очисти поиск.</p><button onClick={() => setQuery('')}>Очистить поиск</button></div>}
    {cursorHint && selectedDetails && <div className="signal-overlay" onClick={hideCursorHint}><aside className="signal-instruction" role="dialog" aria-modal="true" aria-labelledby="instruction-title" onClick={event => event.stopPropagation()}><button className="signal-close" aria-label="Закрыть инструкцию" onClick={hideCursorHint}>×</button><small className="signal-kicker">КАК ВЫПОЛНИТЬ</small><h2 id="instruction-title">{cursorHint.item.name}</h2><p>{selectedDetails.description}</p>{selectedDetails.steps && <div className="signal-instruction-steps">{selectedDetails.steps}</div>}<button autoFocus className="signal-primary" onClick={hideCursorHint}>Понятно</button></aside></div>}
  </div>
}
