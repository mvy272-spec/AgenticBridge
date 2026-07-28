ИНСТРУКЦИИ ДЛЯ АГЕНТА (как пользоваться AgenticBridge)

ТОКЕН: Hdljkhg423N1gger5fdhgsfhg
BASE URL: https://mzipf-2a09-bac1-61e0-3380--388-76.free.pinggy.net

=== БАЗОВЫЙ ЗАПРОС (пример — shell) ===
$ curl -s -X POST -H "X-Bridge-Token: Hdljkhg423N1gger5fdhgsfhg" -H "Content-Type: application/json" \
  https://mzipf-2a09-bac1-61e0-3380--388-76.free.pinggy.net/api/shell \
  -d '{"command":"dir"}'

=== ВСЕ ENDPOINT'Ы ===
GET  /api/health
GET  /api/windows
GET  /api/processes
GET  /api/env
GET  /api/list?path=.
GET  /api/download?path=...
GET  /api/heartbeat
GET  /api/audit
GET  /api/events (SSE)
PUT  /api/file?path=... (upload)
DEL  /api/path?path=...
POST /api/action (mkdir/move/copy/git/zip)
POST /api/unity/command
GET  /api/unity/result?project=...&id=...
POST /api/desktop/capture
GET  /api/editor/log?bytes=...
POST /api/unity/launch
POST /api/self/request (self-loop)
POST /api/shell
POST /api/registry
POST /api/task (multi-agent queue)
POST /api/agent/coord (multi-agent)
POST /api/arena/sdk
POST /api/window/message
POST /api/process/kill
POST /api/env/set
POST /api/install

=== ПРАВИЛА ===
- Всегда используй заголовок X-Bridge-Token.
- Для POST добавляй Content-Type: application/json.
- Для загрузки файлов используй PUT /api/file.
- Не распространяй токен и репозиторий.
- Пользователь берёт все риски.
