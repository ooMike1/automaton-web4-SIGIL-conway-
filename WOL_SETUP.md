# Wake-on-LAN (WoL) Setup Guide

Enable Conway (Pi5) to automatically wake the Ollama server when RPC syncs and inference is needed.

---

## 📋 Prerequisites

### Ollama Server (192.168.50.2)
- [ ] Physical Ethernet connection (WoL requires LAN, not WiFi)
- [ ] BIOS/UEFI supports Wake-on-LAN
- [ ] WoL enabled in system settings

### Pi5 (Conway)
- [ ] Same network as Ollama server (192.168.50.x)
- [ ] Network access to broadcast UDP packets

---

## 🔧 Step 1: Enable WoL on Ollama Server

### On Ubuntu/Debian:

```bash
# Check if Ethernet interface supports WoL
ethtool eth0 | grep Wake

# Expected output:
# Supports Wake-on: g
#   Wake-on: d            ← (d = disabled, need to enable)

# Enable WoL (permanent)
sudo nano /etc/netplan/01-netcfg.yaml
```

**Add this to the file:**
```yaml
network:
  version: 2
  ethernets:
    eth0:
      dhcp4: true
      wakeonlan: true
```

**Then apply:**
```bash
sudo netplan apply
sudo systemctl restart networking

# Verify
ethtool eth0 | grep Wake-on
# Should show: Wake-on: g
```

### On CentOS/RHEL:
```bash
# Check WoL support
ethtool eth0 | grep Wake

# Enable (temporary)
sudo ethtool -s eth0 wol g

# For permanent, add to /etc/sysconfig/network-scripts/ifcfg-eth0:
ETHTOOL_OPTS="wol g"
```

---

## 🔍 Step 2: Get Ollama Server MAC Address

Run on **Ollama server**:

```bash
# Find MAC of ethernet interface
ip link show | grep -A1 "eth0\|eno1\|enp" | grep link/ether | awk '{print $2}'

# Or use ifconfig
ifconfig eth0 | grep "HWaddr\|ether" | awk '{print $NF}'

# Or check ARP from another machine
arp-scan -l | grep "192.168.50.2"

# Example output: aa:bb:cc:dd:ee:ff
```

**Save this MAC address.**

---

## 🎯 Step 3: Configure Conway

Run these commands on **Pi5 (Conway)**:

### Option A: Via Database (One-time setup)

```bash
# SSH or direct access to Pi5
sqlite3 ~/.automaton/state.db "INSERT OR REPLACE INTO state (key, value) VALUES ('ollama_mac_address', 'AA:BB:CC:DD:EE:FF');"

# Verify
sqlite3 ~/.automaton/state.db "SELECT * FROM state WHERE key='ollama_mac_address';"
```

### Option B: Via Conway Tool (If implemented)

```bash
conway set-ollama-mac AA:BB:CC:DD:EE:FF
```

---

## 🧪 Step 4: Test Wake-on-LAN

### Test 1: Manual WoL Wake

On Pi5, create a test script `test_wol.mjs`:

```javascript
import { sendWoLPacket } from "./src/utilities/wake-on-lan.js";

const result = await sendWoLPacket({
  targetMac: "AA:BB:CC:DD:EE:FF", // Replace with actual MAC
  broadcastAddr: "192.168.50.255",
  port: 9,
  maxRetries: 3,
});

console.log("WoL sent:", result);
```

Run:
```bash
node test_wol.mjs
```

Expected output:
```
[WOL] Magic packet sent (1/3) to AA:BB:CC:DD:EE:FF
[WOL] Magic packet sent (2/3) to AA:BB:CC:DD:EE:FF
[WOL] Magic packet sent (3/3) to AA:BB:CC:DD:EE:FF
```

### Test 2: Verify Server Wakes

1. **Shut down Ollama server**:
   ```bash
   sudo systemctl stop ollama
   sudo shutdown -h now  # Or sleep
   ```

2. **Wait 30 seconds** for it to power down

3. **On Pi5, send WoL packet** (as above)

4. **Verify server wakes up**:
   ```bash
   # On Pi5:
   curl http://192.168.50.2:11434/api/tags
   # Should work once server is up
   ```

---

## 🚀 Step 5: Enable Auto-Wake on RPC Sync

Once WoL is working:

1. **Restart Conway**:
   ```bash
   ssh miquel@192.168.50.44 "sudo systemctl restart conway"
   ```

2. **Monitor logs** for auto-wake trigger:
   ```bash
   ssh miquel@192.168.50.44 "sudo journalctl -u conway -f --no-pager" | grep "RPC SYNC\|WoL"
   ```

3. **Expected sequence**:
   - RPC detects balance
   - Conway checks if Ollama reachable
   - If sleeping → sends WoL packet
   - Waits up to 60 seconds for Ollama to wake
   - Resumes inference

---

## 📊 Behavior

| Scenario | Behavior |
|----------|----------|
| **Ollama already running** | Skip WoL, start inference immediately |
| **Ollama sleeping** | Send WoL → wait up to 60s → start inference |
| **Ollama unreachable** | Log warning, continue with sandbox mode |
| **WoL not configured** | Skip WoL, use Ollama when available |

---

## 🔍 Troubleshooting

### WoL Packet Sent But Server Doesn't Wake

**Check BIOS settings:**
```bash
# On Ollama server boot, enter BIOS/UEFI and look for:
- "Wake on LAN" or "WoL"
- "Power Management"
- "Resume from S5" or "Resume by Magic Packet"
# Enable all related options
```

**Check if WoL is actually enabled:**
```bash
ethtool eth0 | grep -i wake
# Should show: Wake-on: g (not d)

# If disabled, enable:
sudo ethtool -s eth0 wol g
```

**Verify Ethernet is active:**
```bash
ip link show eth0 | grep "state"
# Should show: state UP
```

### Server Wakes But Ollama Takes Too Long

Increase WoL wait time in code:
```typescript
// In src/heartbeat/tasks.ts:
const wokeUp = await wakeAndWait(
  { ... },
  `${ollamaUrl}/api/tags`,
  120000  // ← Increase from 60s to 120s
);
```

### Network Issues

**Check broadcast address matches your subnet:**
```bash
# On Pi5 or Ollama server:
ip route | grep default
# If network is 192.168.50.0/24, broadcast is 192.168.50.255
```

---

## 📝 Configuration Summary

**Core Config** (stored in DB):
```
ollama_mac_address: AA:BB:CC:DD:EE:FF
ollama_broadcast: 192.168.50.255
ollama_url: http://192.168.50.2:11434
```

**Hardcoded Defaults** (can customize):
```typescript
// WoL Port: 9 (standard)
// WoL Max Wait: 60 seconds
// WoL Retries: 3 packets
```

---

## ✅ Status Check

Once configured:

```bash
# On Pi5, check if MAC is set
sqlite3 ~/.automaton/state.db "SELECT value FROM state WHERE key='ollama_mac_address';"

# Watch Conway logs during RPC sync
sudo journalctl -u conway -f | grep WoL
```

Expected during RPC sync:
```
[RPC SYNC] 🎉 Balance synced: $10.0000
[RPC SYNC] 🎯 Attempting to wake Ollama server...
[WOL] Checking if http://192.168.50.2:11434/api/tags is reachable...
[WOL] ⏰ Host not reachable. Sending WoL packets...
[WOL] Magic packet sent (1/3) to AA:BB:CC:DD:EE:FF
[WOL] 🛫 Waiting for machine to wake up (max 60000ms)...
[WOL] ✅ Host woke up after 15000ms
[RPC SYNC] ✅ Ollama server is ready for inference
```

---

## 🔗 Related Files

- WoL Utils: [src/utilities/wake-on-lan.ts](src/utilities/wake-on-lan.ts)
- Heartbeat Integration: [src/heartbeat/tasks.ts](src/heartbeat/tasks.ts) (check_usdc_balance)
- Configuration Storage: Database key `ollama_mac_address`

---

**Status: ✅ Ready to configure**

Once you enable WoL on the Ollama server and set the MAC address in Conway, it will automatically wake Ollama whenever the RPC syncs!
