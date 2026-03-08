#!/bin/bash
# Ollama Optimization Deployment Script
# Run on 192.168.50.2 with: bash ollama-optimize.sh

set -e

echo "====== OLLAMA OPTIMIZATION SCRIPT ======"
echo ""
echo "This script will optimize Ollama configuration for resource-constrained environments."
echo ""

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Function to print status
status() {
    echo -e "${GREEN}[✓]${NC} $1"
}

warning() {
    echo -e "${YELLOW}[!]${NC} $1"
}

error() {
    echo -e "${RED}[✗]${NC} $1"
}

# Pre-flight checks
echo "Running pre-flight checks..."
if ! command -v ollama &> /dev/null; then
    error "Ollama not installed"
    exit 1
fi

if ! systemctl is-active ollama > /dev/null 2>&1; then
    error "Ollama service not running"
    exit 1
fi

status "Ollama service is running"

# Current system info
echo ""
echo "Current System Information:"
echo "============================"
TOTAL_MEM=$(free -h | awk '/^Mem:/ {print $2}')
FREE_MEM=$(free -h | awk '/^Mem:/ {print $7}')
CORES=$(nproc)
echo "Total Memory: $TOTAL_MEM"
echo "Free Memory: $FREE_MEM"
echo "CPU Cores: $CORES"

# Check currently loaded models
echo ""
echo "Currently Loaded Models:"
echo "======================="
MODELS=$(curl -s http://localhost:11434/api/tags 2>/dev/null | grep -o '"name":"[^"]*"' || echo "Unable to fetch")
if [ "$MODELS" != "Unable to fetch" ]; then
    echo "$MODELS" | sed 's/"name":"/  - /' | sed 's/"//'
else
    warning "Could not fetch model list"
fi

# Menu for optimization level
echo ""
echo "Select Optimization Level:"
echo "========================="
echo "1) Conservative (OLLAMA_KEEP_ALIVE=10m) - Minimal impact, test first"
echo "2) Balanced (OLLAMA_KEEP_ALIVE=5m + OLLAMA_NUM_THREAD=4) - Recommended"
echo "3) Aggressive (Q4_K_S model + OLLAMA_KEEP_ALIVE=3m) - Need model download"
echo "0) Cancel"
echo ""
read -p "Select option (0-3): " CHOICE

case $CHOICE in
    1)
        warning "Applying Conservative optimization..."
        OLLAMA_KEEP_ALIVE="10m"
        OLLAMA_NUM_THREAD=""
        ;;
    2)
        status "Applying Balanced optimization..."
        OLLAMA_KEEP_ALIVE="5m"
        OLLAMA_NUM_THREAD=$((CORES / 2))
        ;;
    3)
        warning "Aggressive optimization requires model download (~2-3 hours)"
        warning "Current model: qwen3.5:35b (23.8GB)"
        read -p "Download qwen3.5:q4_k_s (~19GB)? (y/n): " CONFIRM
        if [ "$CONFIRM" = "y" ]; then
            OLLAMA_KEEP_ALIVE="3m"
            OLLAMA_NUM_THREAD=$((CORES / 2))
            CHANGE_MODEL=true
        else
            warning "Skipping aggressive optimization"
            exit 0
        fi
        ;;
    0)
        warning "Cancelled"
        exit 0
        ;;
    *)
        error "Invalid option"
        exit 1
        ;;
esac

echo ""
echo "Applying Configuration Changes..."
echo "================================="

# Backup systemd service
SERVICE_FILE="/etc/systemd/system/ollama.service"
BACKUP_FILE="${SERVICE_FILE}.backup.$(date +%s)"

sudo cp "$SERVICE_FILE" "$BACKUP_FILE"
status "Backup created: $BACKUP_FILE"

# Read current service file
CURRENT_SERVICE=$(sudo cat "$SERVICE_FILE")

# Update OLLAMA_KEEP_ALIVE
if echo "$CURRENT_SERVICE" | grep -q "OLLAMA_KEEP_ALIVE"; then
    CURRENT_SERVICE=$(echo "$CURRENT_SERVICE" | sed "s/OLLAMA_KEEP_ALIVE=.*/OLLAMA_KEEP_ALIVE=$OLLAMA_KEEP_ALIVE/")
else
    CURRENT_SERVICE=$(echo "$CURRENT_SERVICE" | sed "/Environment=/a Environment=\"OLLAMA_KEEP_ALIVE=$OLLAMA_KEEP_ALIVE\"")
fi

# Update OLLAMA_NUM_THREAD if needed
if [ ! -z "$OLLAMA_NUM_THREAD" ]; then
    if echo "$CURRENT_SERVICE" | grep -q "OLLAMA_NUM_THREAD"; then
        CURRENT_SERVICE=$(echo "$CURRENT_SERVICE" | sed "s/OLLAMA_NUM_THREAD=.*/OLLAMA_NUM_THREAD=$OLLAMA_NUM_THREAD/")
    else
        CURRENT_SERVICE=$(echo "$CURRENT_SERVICE" | sed "/Environment=/a Environment=\"OLLAMA_NUM_THREAD=$OLLAMA_NUM_THREAD\"")
    fi
fi

# Write updated service file
echo "$CURRENT_SERVICE" | sudo tee "$SERVICE_FILE" > /dev/null
status "Service configuration updated"

# Reload systemd
sudo systemctl daemon-reload
status "Systemd daemon reloaded"

# Handle model change if needed
if [ "$CHANGE_MODEL" = true ]; then
    echo ""
    echo "Downloading Optimized Model..."
    echo "=============================="
    echo "This will take 2-3 hours. You can work with Conway in the meantime."
    echo "The model will switch automatically once download completes."
    echo ""
    
    # Download in background
    (ollama pull qwen3.5:q4_k_s) &
    PULL_PID=$!
    
    status "Model download started (PID: $PULL_PID)"
    warning "To monitor progress: ps aux | grep ollama"
    warning "Once complete, update automaton-config.json with model name"
fi

# Restart Ollama
echo ""
echo "Restarting Ollama Service..."
echo "==========================="
sudo systemctl restart ollama
sleep 3

if systemctl is-active ollama > /dev/null 2>&1; then
    status "Ollama restarted successfully"
else
    error "Ollama failed to restart"
    echo "Attempting to restore from backup..."
    sudo cp "$BACKUP_FILE" "$SERVICE_FILE"
    sudo systemctl daemon-reload
    sudo systemctl restart ollama
    error "Reverted to previous configuration"
    exit 1
fi

# Verify configuration
echo ""
echo "Verification..."
echo "==============="
OLLAMA_KEEP_ALIVE_VAL=$(systemctl cat ollama | grep OLLAMA_KEEP_ALIVE || echo "Not set")
OLLAMA_NUM_THREAD_VAL=$(systemctl cat ollama | grep OLLAMA_NUM_THREAD || echo "Not set")

echo "OLLAMA_KEEP_ALIVE: $OLLAMA_KEEP_ALIVE_VAL"
echo "OLLAMA_NUM_THREAD: $OLLAMA_NUM_THREAD_VAL"

# Memory check
echo ""
echo "New Resource Status:"
echo "==================="
free -h

# Test inference speed
echo ""
echo "Testing Inference Speed..."
echo "========================"
START=$(date +%s%N)
curl -s -X POST http://localhost:11434/api/generate \
  -H "Content-Type: application/json" \
  -d '{"model":"qwen3.5:35b","prompt":"What is 2+2?","stream":false}' > /dev/null 2>&1
END=$(date +%s%N)
ELAPSED=$(( (END - START) / 1000000 ))
echo "First inference took: ${ELAPSED}ms"

echo ""
status "Optimization complete!"
echo ""
echo "📊 Next Steps:"
echo "1. Monitor system load for 24 hours: watch -n 5 'free -h && ps aux | grep ollama'"
echo "2. If still overloaded, switch model: ollama pull qwen3.5:q4_k_s"
echo "3. For benchmark, run: curl -s -X POST http://localhost:11434/api/generate ... (repeat test)"
echo ""
echo "📄 For detailed guide, see OLLAMA_OPTIMIZATION.md"
echo ""
