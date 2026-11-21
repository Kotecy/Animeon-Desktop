// npm test: быстрые проверки без сети и без Electron-окна.
const { execFileSync } = require('node:child_process')
process.chdir(require('node:path').resolve(__dirname, '..'))
const checks = [
  'check-accounts-tabs',     // профили читаются без лишних записей, вкладки закрываются чисто
  'check-collection-delay',  // случайные задержки сбора и их отмена
  'check-feature-auth',      // без входа функции выключены, выход их останавливает
  'check-followback-host',   // сторона приложения для пользовательского скрипта Followback
  'check-oauth-safety',      // нет импорта cookies из Chrome и подмены входа
  'check-profile-reset',     // сброс и удаление профиля
  'check-renderer',          // экраны приложения рендерятся
  'check-session-owner'      // определение вошедшего аккаунта (ник владельца сессии)
]
for (const file of checks) {
  execFileSync(process.execPath, [`scripts/${file}.cjs`], { stdio: 'inherit' })
}
