#!/usr/bin/env bash
# UsageLens — Start the server (Linux / macOS / WSL)

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

PORT="${1:-8000}"
HOST="0.0.0.0"
LOG_FILE="/tmp/usagelens.log"
PID_FILE="/tmp/usagelens.pid"

echo "========================================="
echo "  UsageLens — System Usage Tracker"
echo "========================================="
echo ""

# Check Python
if ! command -v python3 &>/dev/null; then
    echo "[ERROR] python3 not found. Please install Python 3.8+."
    exit 1
fi

# Install dependencies if needed
echo "[1/3] Checking dependencies..."
MISSING=0
python3 -c "import fastapi" 2>/dev/null || MISSING=1
python3 -c "import paramiko" 2>/dev/null || MISSING=1
python3 -c "import yaml" 2>/dev/null || MISSING=1
python3 -c "import filelock" 2>/dev/null || MISSING=1
python3 -c "import sse_starlette" 2>/dev/null || MISSING=1

if [ "$MISSING" -eq 1 ]; then
    echo "    Installing missing packages..."
    pip3 install --quiet fastapi uvicorn paramiko pyyaml filelock sse-starlette 2>/dev/null \
    || pip3 install --quiet --break-system-packages fastapi uvicorn paramiko pyyaml filelock sse-starlette
    echo "    Done."
else
    echo "    All dependencies installed."
fi

# Create data directory
mkdir -p "$SCRIPT_DIR/data"

# Stop existing instance if running
echo "[2/3] Checking for existing instance..."
if [ -f "$PID_FILE" ]; then
    OLD_PID=$(cat "$PID_FILE")
    if kill -0 "$OLD_PID" 2>/dev/null; then
        echo "    Stopping existing server (PID $OLD_PID)..."
        kill "$OLD_PID" 2>/dev/null || true
        sleep 2
    fi
    rm -f "$PID_FILE"
fi

# Start server
echo "[3/3] Starting server on http://$HOST:$PORT ..."
echo ""

if [ "${2}" = "--foreground" ] || [ "${2}" = "-f" ]; then
    echo "  Running in foreground (Ctrl+C to stop)"
    echo ""
    python3 -m uvicorn backend.server:app --host "$HOST" --port "$PORT"
else
    nohup python3 -m uvicorn backend.server:app --host "$HOST" --port "$PORT" > "$LOG_FILE" 2>&1 &
    SERVER_PID=$!
    echo "$SERVER_PID" > "$PID_FILE"

    # Wait for startup
    echo "  Waiting for server to start..."
    for i in $(seq 1 60); do
        if curl -s -o /dev/null "http://127.0.0.1:$PORT/api/hosts" 2>/dev/null; then
            echo ""
            echo "========================================="
            echo "  Server is running!"
            echo ""
            echo "  Local:   http://localhost:$PORT"
            echo "  Network: http://$(hostname -I 2>/dev/null | awk '{print $1}' || echo '<your-ip>'):$PORT"
            echo ""
            echo "  PID: $SERVER_PID"
            echo "  Log: $LOG_FILE"
            echo ""
            echo "  To stop: ./stop.sh"
            echo "========================================="
            exit 0
        fi
        sleep 1
    done
    echo "  [WARNING] Server may still be starting (cache preload can take a minute)."
    echo "  Check: curl http://localhost:$PORT/api/hosts"
    echo "  Log:   tail -f $LOG_FILE"
fi
