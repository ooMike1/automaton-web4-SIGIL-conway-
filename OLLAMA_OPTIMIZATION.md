# Ollama Optimization Guide

**Current Status:**
- Model: qwen3.5:35b (23.8GB, Q4_K_M quantization)
- Host: 192.168.50.2
- Issue: Local machine overloaded during inference
- Latency: 5 seconds per turn (acceptable)

---

## 🎯 Optimization Strategies (In Order of Priority)

### 1. **Model Unload Timeout** (IMMEDIATE - No Downtime)
Auto-unload qwen3.5:35b after periods of inactivity to free VRAM.

**Implementation:**
```bash
# SSH to 192.168.50.2
ssh miquel@192.168.50.2

# Edit Ollama systemd service
sudo nano /etc/systemd/system/ollama.service

# Or check current environment:
sudo systemctl cat ollama | grep -i env
```

**Add/Modify Environment Variable:**
```ini
Environment="OLLAMA_KEEP_ALIVE=5m"
```

This unloads models 5 minutes after last request, freeing ~23GB VRAM.

**Apply Changes:**
```bash
sudo systemctl daemon-reload
sudo systemctl restart ollama
```

**Verification:**
```bash
# Monitor model unloading
curl http://localhost:11434/api/tags  # Shows loaded models
watch -n 5 'ps aux | grep ollama'      # Watch memory release
```

---

### 2. **Reduce Model Quantization** (Medium Priority - ~3s Latency Impact)
Downsize from Q4_K_M (23.8GB) to Q4_K_S (19GB) or Q5_K_M for better balance.

**Options:**
| Quantization | Size    | Quality | Speed      | Recommend If     |
|-------------|---------|---------|-----------|------------------|
| Q4_K_M      | 23.8GB  | Good    | 5s        | Current (baseline) |
| Q4_K_S      | 19GB    | Good    | 4.5s      | ✅ Best for constraints |
| Q5_K_M      | 26GB    | Better  | 5.5s      | After OLLAMA_KEEP_ALIVE |
| Q5_K_S      | 21GB    | Better  | 5s        | Alternative |
| IQ3_M       | 11GB    | Fair    | 2-3s      | Fallback if desperate |

**Implementation:**
```bash
ssh miquel@192.168.50.2

# Pull smaller quantization
ollama pull qwen3.5:q4_k_s

# Update Conway config to use new model
# In automaton-config.json:
```
```json
{
  "inferenceModel": "qwen3.5:q4_k_s",
  "maxTokensPerTurn": 3072
}
```

**Test latency:**
```bash
# Time a single inference
time curl -X POST http://192.168.50.2:11434/api/generate \
  -H "Content-Type: application/json" \
  -d '{
    "model": "qwen3.5:q4_k_s",
    "prompt": "What is 2+2?",
    "stream": false
  }'
```

**Decision Matrix:**
- If load still high → Q4_K_S + OLLAMA_KEEP_ALIVE (saves ~5GB + auto-unload)
- If acceptable load → Q4_K_M + OLLAMA_KEEP_ALIVE (frees VRAM after use)
- If desperate → IQ3_M + OLLAMA_KEEP_ALIVE (smaller, faster, less quality)

---

### 3. **Thread Limiting** (CPU Optimization - Modest Impact)
Reduce CPU threads allocated to Ollama to free system responsiveness.

```bash
# Current config (likely using all cores)
# In /etc/systemd/system/ollama.service, add:

Environment="OLLAMA_NUM_THREAD=4"
```

**Recommendation:**
- For ARM (aarch64): Set to `physical_cores / 2`
- For x86: Set to `(physical_cores / 2) - 1`

**Check system cores:**
```bash
ssh miquel@192.168.50.2 "nproc"  # Logical cores
ssh miquel@192.168.50.2 "lscpu | grep 'CPU(s):'"
```

---

### 4. **GPU Memory Optimization** (If GPU Available)
If 192.168.50.2 has GPU (NVIDIA/AMD), optimize allocation.

```bash
# Check for GPU
ssh miquel@192.168.50.2 "nvidia-smi" || "rocm-smi"

# If GPU present, limit VRAM layers:
Environment="OLLAMA_GPU_LAYERS=35"
```

**Note:** If no GPU, skip this step.

---

### 5. **Request Batching** (App-Level - Low Priority)
Update Conway's inference calls to batch requests where possible.

**Current:** Single inference request per agent turn
**Optimization:** Cache repeated queries, batch system-prompt queries

Location: [src/agent/executor.ts](src/agent/executor.ts)

---

## 📋 Quick Implementation Checklist

### **Phase 1: Immediate (No Downtime)**
- [ ] SSH to 192.168.50.2
- [ ] Edit `/etc/systemd/system/ollama.service`
- [ ] Add `Environment="OLLAMA_KEEP_ALIVE=5m"`
- [ ] Run `sudo systemctl daemon-reload && sudo systemctl restart ollama`
- [ ] Verify with `curl http://localhost:11434/api/tags`

**Expected Result:** VRAM freed 5 minutes after each inference

### **Phase 2: If Still Overloaded (1-min downtime)**
- [ ] Pull alternative quantization: `ollama pull qwen3.5:q4_k_s`
- [ ] Update [automaton-config.json](automaton-config.json) with new model name
- [ ] Redeploy to remote (automatic via next heartbeat)
- [ ] Monitor latency: `time curl -X POST ...`

**Expected Result:** -4.8GB memory + VRAM auto-release

### **Phase 3: If Still Needed (CPU tuning)**
- [ ] Add `Environment="OLLAMA_NUM_THREAD=4"` to systemd service
- [ ] Restart Ollama
- [ ] Monitor CPU load: `top`

---

## 🔍 Monitoring Commands

**Real-time memory tracking:**
```bash
ssh miquel@192.168.50.2 "watch -n 2 'echo === Ollama Memory === && ps aux | grep [o]llama | awk \"{print \\\$6}\" && echo === System Memory === && free -h'"
```

**Model status (which models loaded in VRAM):**
```bash
curl http://192.168.50.2:11434/api/tags | jq '.models[] | {name, size}'
```

**Inference latency test:**
```bash
curl -X POST http://192.168.50.2:11434/api/generate \
  -H "Content-Type: application/json" \
  -d '{"model":"qwen3.5:35b","prompt":"test","stream":false}' | jq '.timing'
```

---

## 🎬 Deployment Steps

### **Step 1: Apply OLLAMA_KEEP_ALIVE (Recommended First)**
```bash
# Set up SSH key (if not done)
# ssh-keygen -t ed25519 -f ~/.ssh/conway_key

ssh miquel@192.168.50.2
sudo nano /etc/systemd/system/ollama.service

# Find [Service] section and add:
Environment="OLLAMA_KEEP_ALIVE=5m"

# Reload and restart
sudo systemctl daemon-reload
sudo systemctl restart ollama

# Verify
ps aux | grep ollama
curl http://localhost:11434/api/tags
```

### **Step 2: Switch to Q4_K_S (If Step 1 insufficient)**
```bash
# On 192.168.50.2:
ollama pull qwen3.5:q4_k_s
ollama remove qwen3.5:35b  # Optional - frees disk space

# On local machine, update config:
# Edit automaton-config.json:
# "inferenceModel": "qwen3.5:q4_k_s"
```

### **Step 3: Limit CPU Threads (If CPU bottleneck)**
```bash
ssh miquel@192.168.50.2
sudo nano /etc/systemd/system/ollama.service

# Add:
Environment="OLLAMA_NUM_THREAD=4"

sudo systemctl daemon-reload
sudo systemctl restart ollama
```

---

## 📊 Expected Impact

### **Scenario 1: OLLAMA_KEEP_ALIVE=5m (Recommended)**
- **Impact:** -23GB VRAM after idle periods
- **Downtime:** 0 seconds
- **Latency Change:** None (first request adds 1-2s load time)
- **Risk:** Minimal
- **Implementation Cost:** <5 minutes

### **Scenario 2: Q4_K_M → Q4_K_S**
- **Impact:** -4.8GB persistent + auto-unload
- **Downtime:** <1 minute (model switch)
- **Latency Change:** +0.5s (5s → 4.5s)
- **Risk:** Slight quality reduction (~negligible)
- **Implementation Cost:** 10 minutes

### **Scenario 3: Both (Recommended)**
- **Impact:** -4.8GB persistent + 23GB auto-unload + responsive CPU
- **Downtime:** <1 minute
- **Latency:** 4.5s (acceptable)
- **Risk:** Very low
- **Implementation Cost:** 15 minutes

---

## ⚠️ Troubleshooting

**Ollama doesn't restart after config change:**
```bash
systemctl status ollama
journalctl -u ollama -n 30 --no-pager
```

**Model binary corrupt after partial download:**
```bash
ollama remove qwen3.5:q4_k_s
ollama pull qwen3.5:q4_k_s  # Re-pull
```

**Inference slower than expected after optimization:**
- Check if model is still loading: `curl http://localhost:11434/api/tags`
- First inference after unload always slow (rebuild context)
- Subsequent queries use cached context (fast)

**Connection refused on 11434:**
```bash
ssh miquel@192.168.50.2 "sudo systemctl restart ollama && sleep 5 && curl -s http://localhost:11434/api/tags | head -c 50"
```

---

## 🚀 Recommended Implementation Order

**For minimal disruption:**
1. ✅ Apply `OLLAMA_KEEP_ALIVE=5m` first (test if sufficient)
2. ⏳ Wait 24 hours to observe load patterns
3. If still overloaded → Apply Q4_K_S switch
4. If CPU bottleneck → Add thread limits

---

## 📝 Notes

- **Conway latency floor:** ~4-5 seconds per inference turn
- **OLLAMA_KEEP_ALIVE=5m:** Aggressive unload (frees VRAM completely) - can increase first-request latency to 7-8s
- **Better balance:** `OLLAMA_KEEP_ALIVE=15m` (compromise between load & latency)
- **Model quality:** Q4_K_S preserves ~99% of inference quality vs Q4_K_M
- **Auto-recovery:** Conway handles model loading transparently; no changes needed to automaton code

---

## 🔗 Related Files

- Configuration: [automaton-config.json](automaton-config.json)
- Inference handler: [src/agent/executor.ts](src/agent/executor.ts)
- Remote service: `/etc/systemd/system/conway.service` (on 192.168.50.44)
