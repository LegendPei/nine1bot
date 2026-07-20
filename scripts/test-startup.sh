#!/bin/bash
set -e

# ============================================
# Nine1Bot 启动测试脚本（编译后二进制版本）
# 用法: ./test-startup.sh <platform> <arch> <build_dir>
# 返回: 0 成功, 1 失败
# ============================================

PLATFORM=$1
ARCH=$2
BUILD_DIR=$3
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

if [ -z "$PLATFORM" ] || [ -z "$ARCH" ] || [ -z "$BUILD_DIR" ]; then
    echo "Usage: $0 <platform> <arch> <build_dir>"
    exit 1
fi

echo "Testing Nine1Bot startup for ${PLATFORM}-${ARCH}..."
echo "Build directory: $BUILD_DIR"

# 验证构建目录存在
if [ ! -d "$BUILD_DIR" ]; then
    echo "ERROR: Build directory does not exist: $BUILD_DIR"
    exit 1
fi

BUILD_DIR="$(cd "$BUILD_DIR" && pwd)"

echo "Verifying packaged platform resources..."
bun run "$SCRIPT_DIR/verify-platform-resources.ts" --build-dir "$BUILD_DIR"

# 根据平台确定二进制文件
if [ "$PLATFORM" = "windows" ]; then
    BINARY="$BUILD_DIR/nine1bot.exe"
else
    BINARY="$BUILD_DIR/nine1bot"
fi

# 验证二进制文件存在
if [ ! -f "$BINARY" ]; then
    echo "ERROR: Binary not found: $BINARY"
    exit 1
fi

echo "Binary: $BINARY"

# 创建最小测试配置 (无需 API key)
TEST_CONFIG="$BUILD_DIR/nine1bot.config.jsonc"

cat > "$TEST_CONFIG" << 'EOF'
{
  "server": {
    "port": 4097,
    "hostname": "127.0.0.1",
    "openBrowser": false
  },
  "auth": {
    "enabled": false
  },
  "tunnel": {
    "enabled": false
  }
}
EOF

echo "Created test config: $TEST_CONFIG"

# 超时设置
TIMEOUT_SECONDS=60
HEALTH_URL="http://127.0.0.1:4097/healthz"

# 启动服务器并捕获输出
LOG_FILE=$(mktemp)
ERROR_LOG_FILE=$(mktemp)
PID_FILE=$(mktemp)
WINDOWS_PROC_PID=""

print_server_output() {
    echo "=== Server Output ==="
    cat "$LOG_FILE"
    if [ -s "$ERROR_LOG_FILE" ]; then
        cat "$ERROR_LOG_FILE"
    fi
    echo "===================="
}

echo "Starting Nine1Bot with test configuration..."
echo "Waiting for startup (timeout: ${TIMEOUT_SECONDS}s)..."

# 启动二进制
cd "$BUILD_DIR"
if [ "$PLATFORM" = "windows" ]; then
    # Windows: 由 PowerShell 启动并写出原生 PID，避免 Git Bash PID 与 Windows PID 不一致。
    BINARY_WINDOWS=$(cygpath -w "$BINARY")
    BUILD_DIR_WINDOWS=$(cygpath -w "$BUILD_DIR")
    LOG_FILE_WINDOWS=$(cygpath -w "$LOG_FILE")
    ERROR_LOG_FILE_WINDOWS=$(cygpath -w "$ERROR_LOG_FILE")
    PID_FILE_WINDOWS=$(cygpath -w "$PID_FILE")
    NINE1BOT_SMOKE_BINARY="$BINARY_WINDOWS" \
    NINE1BOT_SMOKE_BUILD_DIR="$BUILD_DIR_WINDOWS" \
    NINE1BOT_SMOKE_STDOUT="$LOG_FILE_WINDOWS" \
    NINE1BOT_SMOKE_STDERR="$ERROR_LOG_FILE_WINDOWS" \
    NINE1BOT_SMOKE_PID_FILE="$PID_FILE_WINDOWS" \
    powershell.exe -NoProfile -NonInteractive -Command \
        '$process = Start-Process -FilePath $env:NINE1BOT_SMOKE_BINARY -WorkingDirectory $env:NINE1BOT_SMOKE_BUILD_DIR -RedirectStandardOutput $env:NINE1BOT_SMOKE_STDOUT -RedirectStandardError $env:NINE1BOT_SMOKE_STDERR -PassThru; Set-Content -LiteralPath $env:NINE1BOT_SMOKE_PID_FILE -Value $process.Id -Encoding ascii; $process.WaitForExit(); exit $process.ExitCode' &
    PROC_PID=$!
    for _ in $(seq 1 100); do
        if [ -s "$PID_FILE" ]; then
            break
        fi
        if ! kill -0 "$PROC_PID" 2>/dev/null; then
            break
        fi
        sleep 0.1
    done
    if [ ! -s "$PID_FILE" ]; then
        echo "ERROR: Windows process launcher did not report a native PID"
        print_server_output
        wait "$PROC_PID" 2>/dev/null || true
        rm -f "$LOG_FILE" "$ERROR_LOG_FILE" "$PID_FILE" "$TEST_CONFIG"
        exit 1
    fi
    WINDOWS_PROC_PID=$(tr -d '\r\n ' < "$PID_FILE")
else
    # Unix: 直接执行
    ./nine1bot > "$LOG_FILE" 2>&1 &
    PROC_PID=$!
fi

echo "Process started with PID: $PROC_PID"

# 监控启动状态
START_TIME=$(date +%s)
SUCCESS=0

while true; do
    CURRENT_TIME=$(date +%s)
    ELAPSED=$((CURRENT_TIME - START_TIME))

    # 检查进程是否还在运行
    if ! kill -0 "$PROC_PID" 2>/dev/null; then
        echo "Process exited unexpectedly"
        print_server_output
        SUCCESS=0
        break
    fi

    # 使用公开的最小健康端点确认 HTTP 服务已经真正可用。
    if curl --fail --silent --show-error --max-time 2 "$HEALTH_URL" 2>/dev/null | grep -q '"ok":true'; then
        echo "SUCCESS: Server health check passed!"
        print_server_output
        SUCCESS=1
        break
    fi

    # 检查超时
    if [ "$ELAPSED" -ge "$TIMEOUT_SECONDS" ]; then
        echo "TIMEOUT: Server did not start within ${TIMEOUT_SECONDS} seconds"
        print_server_output
        SUCCESS=0
        break
    fi

    sleep 1
done

if [ "$SUCCESS" -eq 1 ]; then
    echo "Probing running platform resource paths..."
    if bun run "$SCRIPT_DIR/probe-platform-runtime-resources.ts" \
        --base-url "http://127.0.0.1:4097" \
        --build-dir "$BUILD_DIR"; then
        echo "SUCCESS: Platform runtime resources are available"
    else
        echo "ERROR: Platform runtime resource probe failed"
        SUCCESS=0
    fi
fi

# 清理: 终止服务器进程
echo "Stopping server..."
if [ "$PLATFORM" = "windows" ]; then
    if ! NINE1BOT_SMOKE_PROCESS_ID="$WINDOWS_PROC_PID" powershell.exe -NoProfile -NonInteractive -Command \
        '$id = [int]$env:NINE1BOT_SMOKE_PROCESS_ID; Stop-Process -Id $id -Force -ErrorAction SilentlyContinue; Start-Sleep -Milliseconds 100; if (Get-Process -Id $id -ErrorAction SilentlyContinue) { exit 1 }' 2>/dev/null; then
        echo "ERROR: Failed to stop Windows smoke process $WINDOWS_PROC_PID"
        SUCCESS=0
    fi
    wait "$PROC_PID" 2>/dev/null || true
else
    kill "$PROC_PID" 2>/dev/null || true
    sleep 1
    kill -9 "$PROC_PID" 2>/dev/null || true
fi

# 清理临时文件
rm -f "$LOG_FILE" "$ERROR_LOG_FILE" "$PID_FILE" "$TEST_CONFIG"

# 返回结果
if [ "$SUCCESS" -eq 1 ]; then
    echo "Startup test PASSED for ${PLATFORM}-${ARCH}"
    exit 0
else
    echo "Startup test FAILED for ${PLATFORM}-${ARCH}"
    exit 1
fi
