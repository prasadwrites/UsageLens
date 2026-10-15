#!/usr/bin/env bash
# UsageLens — Stop the server

PID_FILE="/tmp/usagelens.pid"

if [ -f "$PID_FILE" ]; then
    PID=$(cat "$PID_FILE")
    if kill -0 "$PID" 2>/dev/null; then
        echo "Stopping UsageLens server (PID $PID)..."
        kill "$PID"
        rm -f "$PID_FILE"
        echo "Stopped."
    else
        echo "Server not running (stale PID file)."
        rm -f "$PID_FILE"
    fi
else
    # Try to find it anyway
    PID=$(pgrep -f "uvicorn backend.server:app" 2>/dev/null || true)
    if [ -n "$PID" ]; then
        echo "Stopping UsageLens server (PID $PID)..."
        kill "$PID"
        echo "Stopped."
    else
        echo "UsageLens server is not running."
    fi
fi
