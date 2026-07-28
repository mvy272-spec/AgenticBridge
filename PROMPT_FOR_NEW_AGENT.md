ПРОМПТ ДЛЯ НОВОГО АГЕНТА (безобидный чеклист)

1. Выполни сначала:
$ curl -v -H "X-Bridge-Token: CHANGE-ME-TO-A-LONG-RANDOM-TOKEN" https://ndjxy-5-53-27-248.free.pinggy.net/api/health 2>&1 | head -n 25

2. Если отвечает — продолжи по чеклисту из TODO_CHECKLIST.md:
- /api/health
- /api/self/request
- /api/shell
- /api/processes
- /api/registry
- /api/task
- /api/heartbeat
- /api/audit
- Файловые операции

3. Для каждого пункта запиши результат в лог.
4. Не распространяй репозиторий. Пользователь берёт риски.
