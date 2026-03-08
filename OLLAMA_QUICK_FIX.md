# Ollama Optimization - Quick Reference

## 🚀 One-Liner Implementation

**Fastest way to reduce load (adds 5 min auto-unload + 4 CPU threads):**

```bash
ssh miquel@192.168.50.2 "sudo sed -i 's/\[Service\]/[Service]\nEnvironment=\"OLLAMA_KEEP_ALIVE=5m\"\nEnvironment=\"OLLAMA_NUM_THREAD=4\"/' /etc/systemd/system/ollama.service && sudo systemctl daemon-reload && sudo systemctl restart ollama && echo '✅ Ollama optimized' && sleep 3 && ps aux | grep ollama"
```

---

## 📋 Manual Steps (If one-liner fails)

### Step 1: Connect to Ollama host
```bash
ssh miquel@192.168.50.2
```

### Step 2: Edit systemd service
```bash
sudo nano /etc/systemd/system/ollama.service
```

### Step 3: Find `[Service]` section and add these lines:
```ini
Environment="OLLAMA_KEEP_ALIVE=5m"
Environment="OLLAMA_NUM_THREAD=4"
```

**Full example [Service] section:**
```ini
[Service]
Type=simple
User=ollama
Group=ollama
ExecStart=/usr/local/bin/ollama serve
Restart=always
RestartSec=3
StartLimitIntervalSec=60
StartLimitBurst=3
Environment="OLLAMA_KEEP_ALIVE=5m"
Environment="OLLAMA_NUM_THREAD=4"
```

### Step 4: Save and apply
```bash
# Exit nano: Ctrl+X, then Y, then Enter

sudo systemctl daemon-reload
sudo systemctl restart ollama
sleep 3
ps aux | grep ollama
```

---

## 🔄 Model Downgrade (If still overloaded)

### Step 1: Pull optimized quantization
```bash
ssh miquel@192.168.50.2
ollama pull qwen3.5:q4_k_s       # 19GB instead of 23.8GB
```

### Step 2: Verify download complete
```bash
ollama list | grep qwen
```

### Step 3: Update Conway config
Edit [automaton-config.json](automaton-config.json):
```json
{
  "inferenceModel": "qwen3.5:q4_k_s"  // Changed from qwen3.5:35b
}
```

### Step 4: Redeploy to remote
```bash
scp automaton-config.json miquel@192.168.50.44:~/automaton-web4-SIGIL-conway-/
ssh miquel@192.168.50.44 "cd ~/automaton-web4-SIGIL-conway- && npm run build"
ssh miquel@192.168.50.44 "sudo systemctl restart conway"
```

---

## 📊 Impact Matrix

| Option | Memory Freed | CPU Impact | Latency | Setup Time |
|--------|-------------|-----------|---------|-----------|
| `OLLAMA_KEEP_ALIVE=5m` | 23GB (after idle) | None | None | 2 min |
| `OLLAMA_NUM_THREAD=4` | None | Reduced load | ~0.2s slower | 2 min |
| `Q4_K_S` model | -4.8GB persistent | None | +0.5s | 2hr download |
| **All three** | **27.8GB** | **Low** | **4.5s total** | **2hr 4min** |

---

## ✅ Verification Commands

### Check if changes applied
```bash
ssh miquel@192.168.50.2 "systemctl cat ollama | grep -E 'OLLAMA_KEEP_ALIVE|OLLAMA_NUM_THREAD'"
```

### Monitor live memory usage
```bash
ssh miquel@192.168.50.2 "watch -n 3 'echo \"=== Ollama Memory ===\" && ps aux | grep [o]llama | awk \"{print \\\\\$6, \\\"MB\\\"}\" && echo \"\" && echo \"=== System Memory ===\" && free -h'"
```

### Check loaded models in VRAM
```bash
curl -s http://192.168.50.2:11434/api/tags | jq '.models[] | {name, size}' 2>/dev/null || echo "Ollama unreachable"
```

### Test inference latency
```bash
time curl -s -X POST http://192.168.50.2:11434/api/generate \
  -H "Content-Type: application/json" \
  -d '{"model":"qwen3.5:35b","prompt":"What is 2+2?","stream":false}' | jq '.response' | head -c 50 && echo ""
```

---

## 🛠️ If Something Goes Wrong

### Ollama won't start after changes
```bash
ssh miquel@192.168.50.2
sudo systemctl status ollama
journalctl -u ollama -n 30 --no-pager

# Revert to backup
sudo cp /etc/systemd/system/ollama.service.backup.* /etc/systemd/system/ollama.service
sudo systemctl daemon-reload && sudo systemctl restart ollama
```

### High latency after optimization
**Normal behavior:** First inference after 5min idle takes 7-8s (model reload)
**Subsequent queries:** 4-5s (cached context)

### Model appears stuck downloading
```bash
ps aux | grep ollama                    # Check if process running
lsof | grep qwen3.5-q4_k_s            # Check disk activity
# Let it run, or Ctrl+C and restart: ollama pull qwen3.5:q4_k_s
```

---

## 📖 Full Documentation

See: [OLLAMA_OPTIMIZATION.md](OLLAMA_OPTIMIZATION.md)

---

## 🎯 Execution Order (Recommended)

1. **Apply Phase 1** (Immediate): `OLLAMA_KEEP_ALIVE=5m` + `OLLAMA_NUM_THREAD=4`
   - Time: 2 minutes
   - Result: Frees 23GB VRAM after idle + reduced CPU contention
   - Expected load: ~50% reduction

2. **Monitor 24 hours** to see if load acceptable

3. **If still overloaded**, apply Phase 2: Switch to `qwen3.5:q4_k_s`
   - Time: ~2 hours (model download) + 5 minutes (config update)
   - Result: Additional 4.8GB freed + ~0.5s latency increase
   - Expected load: ~70-80% reduction total

4. **If desperate**, switch to `qwen3-coder:30b` (11GB, faster)
   - Trade: Better code understanding, smaller footprint
   - Ollama command: `ollama pull qwen3-coder:30b`

---

## 🔗 Related Configuration Files

- Main config: [automaton-config.json](automaton-config.json)
- Inference exec: [src/agent/executor.ts](src/agent/executor.ts#L65)
- Heartbeat tasks: [src/heartbeat/tasks.ts](src/heartbeat/tasks.ts)
- Systemd service (remote): `/etc/systemd/system/conway.service`

---

**Status: Ready to optimize. Execute Phase 1 command above when ready.**
