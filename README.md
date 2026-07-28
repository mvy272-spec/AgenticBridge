# AgenticBridge v4 MAX

Максимально мощный мост для Arena.ai агентов.

## Возможности
- Один токен — неограниченное количество агентов
- Полноценный shell (любые команды)
- Управление процессами
- Реестр Windows
- Task Queue с автосохранением
- Полная автономия (self-loop)
- Логирование всех действий

## Запуск
```bash
node src/server.js
```

## Основные эндпоинты
- `POST /api/shell/exec` — выполнение любых команд
- `GET  /api/processes` — список процессов
- `POST /api/process/kill`
- `POST /api/registry/get`
- `POST /api/agent/tasks` — добавить задачу
- `GET  /api/agent/tasks` — получить очередь

## Headers
- `X-Bridge-Token` (обязательно)
- `X-Agent-ID` (опционально, для multi-agent)