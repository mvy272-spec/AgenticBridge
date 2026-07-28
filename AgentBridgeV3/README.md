# Agent Bridge v3 (Node.js)

Dependency-free Node.js 20+ control bridge for Windows/Unity. It keeps port `8080`, so Tuna does not need reconfiguration.

## Capabilities

- Authenticated file list/download/atomic upload/delete/move/copy.
- Git init/status/log/commit.
- Timestamped ZIP backups through Windows PowerShell.
- Unity Editor command queue and JSON results.
- Unity launch via an explicit `Unity.exe` path.
- Full Windows desktop PNG capture.
- Tail of `%LOCALAPPDATA%\Unity\Editor\Editor.log`.
- Server-Sent Events stream.
- No arbitrary remote shell endpoint.

## Start

1. Install Node.js 20 LTS or newer from https://nodejs.org/en/download if `node -v` does not work.
2. Stop the old Python bridge with Ctrl+C.
3. Double-click `start-bridge.cmd`.
4. Keep the existing Tuna forwarding to local port 8080.

Optional environment variables:

```cmd
set BRIDGE_ROOT=C:\YnityProjects
set BRIDGE_TOKEN=your-long-token
start-bridge.cmd
```

Health check: `GET /api/health` with header `X-Bridge-Token`.

## Unity commands

`POST /api/unity/command`:

```json
{
  "project": "dzielnica RIp-off upgraded version",
  "id": "movement-001",
  "action": "run_movement_smoke_test",
  "argument": "Assets/Game/Generated/Scenes/VerticalSlice.unity"
}
```

Read result:

```text
GET /api/unity/result?project=dzielnica%20RIp-off%20upgraded%20version&id=movement-001
```

Supported Unity actions are intentionally allowlisted in `AgentEditorBridge.cs`: ping, open_scene, run_bootstrap, play, stop, status, capture_game, run_movement_smoke_test.
