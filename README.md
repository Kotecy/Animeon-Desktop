<p align="center">
  <img src="https://i.ibb.co/N6tTm6X4/logo.png" width="160" alt="AnimeOn Desktop">
</p>
<h1 align="center">AnimeOn Desktop</h1>
<p align="center">Неофициальный десктоп-клиент для <a href="https://animeon.cc">AnimeOn</a>.<br>Сайт, профили и полезные функции — в одном окне.</p>
<p align="center">
  <a href="https://github.com/Kotecy/Animeon-Desktop/releases/latest"><img src="https://img.shields.io/github/v/release/Kotecy/Animeon-Desktop?color=bba7ec" alt="Последний релиз"></a>
  <img src="https://img.shields.io/badge/Windows-x64-0078D4" alt="Windows x64">
  <img src="https://img.shields.io/badge/license-MIT-90d4bc" alt="MIT">
</p>

## ✨ Возможности

- 🗂️ **Вкладки сайта** — до 7 вкладок, закреплённые слева, обычные справа, сохранение порядка закреплённых после перезапуска, индикатор звука и отключение звука по вкладкам.
- 👥 **Мультипрофили** — до 4 изолированных сессий с переключением и сохранением авторизации.
- 🧩 **Пользовательские функции** — до 12 слотов для загрузки собственных JavaScript-скриптов (`.js`).
- 🏆 **Секреты** — каталог секретных достижений с отслеживанием прогресса и подсказками по получению.
- 🧹 **Очистка кэша** — быстрое освобождение дискового пространства в один клик без сброса авторизации и сохранённых профилей.
- 🔄 **Обновления** — встроенная проверка новых версий через GitHub Releases прямо из настроек.

## 🖼️ Скриншоты

| Главная | Функции | Секретки | Настройки |
|:--:|:--:|:--:|:--:|
| <a href="https://i.ibb.co/Z6XpF38q/image.png" target="_blank"><img src="https://i.ibb.co/Z6XpF38q/image.png" width="200" alt="Главная"></a> | <a href="https://i.ibb.co/FLMnM5S2/image.png" target="_blank"><img src="https://i.ibb.co/FLMnM5S2/image.png" width="200" alt="Функции"></a> | <a href="https://i.ibb.co/7xsYzpwd/image.png" target="_blank"><img src="https://i.ibb.co/7xsYzpwd/image.png" width="200" alt="Секретки"></a> | <a href="https://i.ibb.co/kVTzj1y1/image.png" target="_blank"><img src="https://i.ibb.co/kVTzj1y1/image.png" width="200" alt="Настройки"></a> |

На скриншотах показан интерфейс версии `0.4.20`.

## 📦 Установка

1. Скачайте **AnimeOn.Desktop.exe** из [последнего релиза](https://github.com/Kotecy/Animeon-Desktop/releases/latest).
2. Запустите файл. Установка не требуется.
3. Если у вас уже есть сохранённая сессия, откройте свой профиль. Для входа можно использовать Telegram.

Данные приложения находятся в `%LOCALAPPDATA%\AnimeonDesktop`.
Для обновления закройте приложение и запустите новый EXE. Он использует тот же каталог настроек и профилей.

Если Google отклоняет вход во встроенном браузере, воспользуйтесь входом через Telegram.

<details>
<summary>🛠️ Сборка из исходников</summary>

Для сборки portable EXE под Windows x64 нужны Node.js 24.13.0 или новее и npm.

```cmd
cd compile
npm ci
npm run lint
npm test
npm run build:public
```

Файл `AnimeOn Desktop.exe` появится в `compile/release`.

</details>

## ⚠️ Дисклеймер

Клиент не связан с администрацией AnimeOn. Соблюдайте правила сайта: автоматизация действий аккаунта может быть ограничена правилами сайта.

## 📄 Лицензия

[MIT](LICENSE).
