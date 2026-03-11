# Dashboard Redesign Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Redesign `/home/miquel/dashboard/server.py` so that agent state, current activity, and financials are immediately visible without scrolling.

**Architecture:** Single Python file. Same HTTP server on port 3702, same `/api` JSON endpoint. The backend `get_status()` function gains new computed fields (strategy intel, loop detection, ANSI-stripped logs, sleep countdown). The entire HTML/CSS/JS string is replaced with the new layout.

**Tech Stack:** Python 3 stdlib only (`http.server`, `sqlite3`, `subprocess`, `json`, `re`, `os`, `datetime`). Vanilla JS with `fetch`. No new dependencies.

**Design doc:** `docs/plans/2026-03-11-dashboard-redesign-design.md`

---

### Task 1: Extend the `/api` backend

**Files:**
- Modify: `/home/miquel/dashboard/server.py` — imports and `get_status()` function only

**Context:** Add these fields to the returned dict:
- `strategy_intel` dict — active strategy, arbitrage summary + age, x402 income (all from KV; currently invisible in dashboard)
- `loop_detected` bool + `loop_tool` str — whether last 3 turns share the same first tool call
- `usdc_raw` float — raw USDC balance for color threshold logic (< $2 = amber)
- `credits_cents` int — for color threshold (< 10 cents = red)
- `is_free_inference` bool — "free inference" badge on credits card
- `wake_in_secs` int|null — seconds until next wakeup
- ANSI-stripped logs — current logs show raw escape sequences like `[32m`

**Step 1: Verify current API**

```bash
curl -s http://localhost:3702/api | python3 -m json.tool | head -30
```

Note which fields exist vs. which are missing (strategy_intel, loop_detected, usdc_raw etc.)

**Step 2: Replace imports and `get_status()` in server.py**

Replace everything from line 1 up to (but not including) `HTML = r"""` with:

```python
#!/usr/bin/env python3
"""Agatha Dashboard — port 3702"""
import http.server
import json
import sqlite3
import subprocess
import os
import re
from datetime import datetime, timezone

DB = os.path.expanduser("~/.automaton/state.db")
PORT = 3702

ANSI_ESCAPE = re.compile(r'\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])')

def strip_ansi(text):
    return ANSI_ESCAPE.sub('', text)


def get_status():
    try:
        db = sqlite3.connect(DB)
        kv = dict(db.execute("SELECT key, value FROM kv").fetchall())
        turns_raw = db.execute("""
            SELECT id, timestamp, thinking, state, token_usage, input_source, input
            FROM turns ORDER BY timestamp DESC LIMIT 15
        """).fetchall()
        tool_calls_raw = db.execute("""
            SELECT turn_id, name, arguments, result, error, duration_ms
            FROM tool_calls ORDER BY rowid ASC
        """).fetchall()
        db.close()
    except Exception:
        kv, turns_raw, tool_calls_raw = {}, [], []

    tools_by_turn = {}
    for tc in tool_calls_raw:
        tid = tc[0]
        if tid not in tools_by_turn:
            tools_by_turn[tid] = []
        tools_by_turn[tid].append({
            "name": tc[1], "arguments": tc[2] or "",
            "result": tc[3] or "", "error": tc[4] or "", "duration_ms": tc[5] or 0,
        })

    try:
        result = subprocess.run(["tail", "-n", "40", "/tmp/agatha.log"],
                                capture_output=True, text=True, timeout=5)
        logs = strip_ansi(result.stdout)
    except Exception:
        logs = "Could not fetch logs"

    credits_display, credits_cents = "?", 0
    try:
        cj = json.loads(kv.get("last_credit_check", "{}"))
        credits_cents = cj.get("credits", 0)
        credits_display = f"${credits_cents / 100:.2f}"
    except Exception:
        pass

    usdc_display, usdc_raw = "?", 0.0
    try:
        uj = json.loads(kv.get("last_usdc_check", "{}"))
        usdc_raw = float(uj.get("balance", 0))
        usdc_display = f"{usdc_raw:.4f}"
    except Exception:
        pass

    wake_in_secs = None
    if kv.get("sleep_until", ""):
        try:
            t = datetime.fromisoformat(kv["sleep_until"].replace("Z", "+00:00"))
            wake_in_secs = max(0, int((t - datetime.now(timezone.utc)).total_seconds()))
        except Exception:
            pass

    turns = []
    for row in turns_raw:
        turn_id, ts, thinking, state, token_usage_raw, input_source, input_text = row
        tokens = 0
        try:
            tokens = json.loads(token_usage_raw or "{}").get("totalTokens", 0)
        except Exception:
            pass
        turns.append({
            "id": turn_id, "time": ts, "state": state,
            "thought": thinking or "", "tokens": tokens,
            "input_source": input_source or "self",
            "input": (input_text or "")[:300],
            "tools": tools_by_turn.get(turn_id, []),
        })

    loop_detected, loop_tool = False, None
    if len(turns) >= 3:
        names = [t["tools"][0]["name"] if t["tools"] else None for t in turns[:3]]
        if names[0] and all(n == names[0] for n in names):
            loop_detected, loop_tool = True, names[0]

    strategy_intel = {}
    if kv.get("active_income_strategy"):
        strategy_intel["active_strategy"] = kv["active_income_strategy"]
    try:
        arb = json.loads(kv.get("last_universal_arbitrage", "{}"))
        if arb:
            first_line = next((l.strip() for l in arb.get("result","").split("\n") if l.strip()), "")
            age_min = None
            if arb.get("scanTime"):
                t_scan = datetime.fromisoformat(arb["scanTime"].replace("Z", "+00:00"))
                age_min = int((datetime.now(timezone.utc) - t_scan).total_seconds() / 60)
            if first_line:
                strategy_intel["arbitrage"] = {"summary": first_line[:120], "age_min": age_min}
    except Exception:
        pass
    if kv.get("x402_income_total"):
        strategy_intel["x402_income"] = kv["x402_income_total"]

    model = kv.get("inference_model", "")
    groq_pfx = ("llama","mixtral","gemma","deepseek-r1","qwen","whisper","openai/gpt-oss")
    is_free = "/" in model or any(model.lower().startswith(p) for p in groq_pfx)

    return {
        "state": kv.get("agent_state", "unknown"),
        "credits": credits_display, "credits_cents": credits_cents,
        "usdc": usdc_display, "usdc_raw": usdc_raw,
        "is_free_inference": is_free, "wake_in_secs": wake_in_secs,
        "next_steps": kv.get("next_steps", ""),
        "turns": turns, "logs": logs[-3000:], "total_turns": len(turns_raw),
        "loop_detected": loop_detected, "loop_tool": loop_tool,
        "strategy_intel": strategy_intel, "inference_model": model,
    }
```

**Step 3: Restart and verify new fields**

```bash
pkill -f "python3 /home/miquel/dashboard/server.py" 2>/dev/null; sleep 0.5
python3 /home/miquel/dashboard/server.py > /home/miquel/dashboard/dashboard.log 2>&1 &
sleep 1
curl -s http://localhost:3702/api | python3 -c "import json,sys; d=json.load(sys.stdin); print(sorted(d.keys()))"
```

Expected — all these keys present:
`['credits', 'credits_cents', 'inference_model', 'is_free_inference', 'loop_detected', 'loop_tool', 'logs', 'next_steps', 'state', 'strategy_intel', 'total_turns', 'turns', 'usdc', 'usdc_raw', 'wake_in_secs']`

Verify logs are ANSI-clean:
```bash
curl -s http://localhost:3702/api | python3 -c "import json,sys; d=json.load(sys.stdin); print('CLEAN' if '\x1b' not in d['logs'] else 'HAS ANSI')"
```
Expected: `CLEAN`

**Step 4: Commit**

```bash
git add /home/miquel/dashboard/server.py
git commit -m "feat(dashboard): extend API — strategy intel, loop detection, ANSI-clean logs"
```

---

### Task 2: Replace HTML structure and CSS

**Files:**
- Modify: `/home/miquel/dashboard/server.py` — replace the entire `HTML = r"""..."""` string

**Context:** Keep the Python handler and `if __name__` block unchanged. Only swap out the HTML constant.

**Step 1: Replace `HTML = r"""..."""` with the new markup**

Find the line `HTML = r"""` and replace the entire string (through the closing `"""`) with:

```python
HTML = r"""<!DOCTYPE html>
<html>
<head>
  <title>Agatha</title>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body { background: #0d0d0d; color: #c8c8c8; font-family: 'Courier New', monospace; font-size: 13px; }
    .titlebar { display: flex; align-items: center; justify-content: space-between; padding: 10px 16px; border-bottom: 1px solid #1e1e1e; background: #101010; position: sticky; top: 0; z-index: 10; }
    .titlebar-name { color: #00ffcc; font-size: 1.1em; font-weight: bold; letter-spacing: 0.05em; }
    .titlebar-meta { color: #444; font-size: 0.8em; }
    .stat-row { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; padding: 12px 16px; border-bottom: 1px solid #1e1e1e; }
    .stat-card { background: #111; border: 1px solid #1e1e1e; border-radius: 6px; padding: 10px 12px; border-left: 3px solid #333; }
    .stat-label { color: #555; font-size: 0.72em; letter-spacing: 0.08em; text-transform: uppercase; margin-bottom: 4px; }
    .stat-value { font-size: 1.4em; font-weight: bold; line-height: 1.1; }
    .stat-sub { color: #555; font-size: 0.78em; margin-top: 3px; }
    .content-grid { display: grid; grid-template-columns: 280px 1fr; gap: 12px; padding: 12px 16px; }
    .left-col { display: flex; flex-direction: column; gap: 10px; }
    .right-col { display: flex; flex-direction: column; gap: 8px; }
    .card { background: #111; border: 1px solid #1e1e1e; border-radius: 6px; padding: 12px; }
    .card-title { color: #00aaff; font-size: 0.72em; letter-spacing: 0.1em; text-transform: uppercase; font-weight: bold; margin-bottom: 10px; }
    .badge { display: inline-block; padding: 2px 8px; border-radius: 10px; font-size: 0.8em; border: 1px solid currentColor; }
    .badge-sm { padding: 1px 5px; font-size: 0.72em; border-radius: 8px; }
    .intel-row { padding: 4px 0; border-bottom: 1px solid #181818; font-size: 0.82em; }
    .intel-row:last-child { border-bottom: none; }
    .intel-key { color: #555; font-size: 0.85em; margin-bottom: 1px; }
    .intel-val { color: #999; }
    .turn-card { background: #0f0f0f; border: 1px solid #1a1a1a; border-radius: 6px; border-left: 3px solid #333; overflow: hidden; }
    .turn-header { display: flex; align-items: center; gap: 8px; padding: 10px 12px 6px; flex-wrap: wrap; }
    .turn-body { padding: 0 12px 12px; }
    .turn-thought { color: #aaa; line-height: 1.6; white-space: pre-wrap; word-break: break-word; max-height: 400px; overflow-y: auto; }
    .turn-time { color: #555; font-size: 0.78em; }
    .turn-tokens { color: #444; font-size: 0.78em; margin-left: auto; }
    .source-tag { font-size: 0.72em; padding: 1px 5px; border-radius: 3px; background: #1a1a2e; color: #5588aa; }
    .loop-badge { background: #2a1800; border: 1px solid #cc7700; color: #ffaa00; padding: 2px 8px; border-radius: 4px; font-size: 0.78em; }
    .tools-list { margin-top: 10px; display: flex; flex-direction: column; gap: 5px; border-top: 1px solid #1a1a1a; padding-top: 10px; }
    .tool-call { background: #0c180c; border: 1px solid #182818; border-radius: 4px; padding: 6px 8px; }
    .tool-call.err { background: #180c0c; border-color: #2e1818; }
    .tool-chip { display: inline-block; background: #1a301a; color: #55cc66; padding: 1px 7px; border-radius: 10px; font-size: 0.82em; font-weight: bold; margin-right: 6px; }
    .tool-args { color: #3a5a3a; font-size: 0.78em; }
    .tool-result { color: #6a8a6a; font-size: 0.78em; margin-top: 3px; white-space: pre-wrap; word-break: break-word; }
    .tool-result::before { content: '→ '; color: #3a5a3a; }
    .tool-error { color: #aa4444; font-size: 0.78em; margin-top: 3px; }
    .tool-error::before { content: '✗ '; }
    .tool-dur { color: #2a2a2a; font-size: 0.72em; margin-top: 2px; }
    .no-tools { color: #2a2a2a; font-size: 0.8em; font-style: italic; padding-top: 8px; }
    .history-item { background: #0d0d0d; border: 1px solid #1a1a1a; border-radius: 6px; border-left: 3px solid #333; margin-bottom: 5px; overflow: hidden; }
    .history-item:last-child { margin-bottom: 0; }
    .history-item.has-err { border-left-color: #883333 !important; }
    .history-summary { padding: 7px 12px; cursor: pointer; display: flex; align-items: center; gap: 8px; list-style: none; user-select: none; }
    .history-summary::-webkit-details-marker { display: none; }
    .history-summary:hover { background: #141414; }
    .h-arrow { color: #444; font-size: 0.75em; flex-shrink: 0; transition: transform 0.15s; }
    details[open] .h-arrow { transform: rotate(90deg); }
    .h-preview { color: #555; font-size: 0.8em; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .tool-count-chip { background: #141420; color: #446688; padding: 1px 6px; border-radius: 8px; font-size: 0.72em; flex-shrink: 0; }
    .history-body { padding: 0 12px 10px; }
    .log-section { padding: 0 16px 16px; }
    .log-toggle { display: flex; align-items: center; gap: 8px; padding: 10px 0 8px; cursor: pointer; list-style: none; color: #444; font-size: 0.75em; letter-spacing: 0.08em; text-transform: uppercase; user-select: none; }
    .log-toggle::-webkit-details-marker { display: none; }
    .log-toggle:hover { color: #666; }
    .log-arrow { transition: transform 0.15s; }
    details[open] .log-arrow { transform: rotate(90deg); }
    .log-pre { background: #080808; border: 1px solid #1a1a1a; border-radius: 4px; padding: 10px 12px; font-size: 0.77em; line-height: 1.55; max-height: 300px; overflow-y: auto; white-space: pre-wrap; word-break: break-word; }
    .ll-err { color: #884444; }
    .ll-warn { color: #886600; }
    .ll-tool { color: #448844; }
    .ll-inf { color: #446688; }
    .ll-def { color: #3a5a3a; }
    @media (max-width: 700px) {
      .stat-row { grid-template-columns: 1fr 1fr; }
      .content-grid { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <div class="titlebar">
    <span class="titlebar-name">&#x26A1; Agatha</span>
    <span class="titlebar-meta" id="ts">loading&#x2026;</span>
  </div>
  <div class="stat-row" id="stat-row"></div>
  <div class="content-grid">
    <div class="left-col" id="left-col"></div>
    <div class="right-col" id="right-col"></div>
  </div>
  <details class="log-section" id="log-details">
    <summary class="log-toggle">
      <span class="log-arrow">&#x25BA;</span>LIVE LOG
    </summary>
    <div class="log-pre" id="log-pre"></div>
  </details>
  <script>
  // PASTE JS HERE (Task 3)
  </script>
</body>
</html>
"""
```

**Step 2: Restart and smoke-test the skeleton**

```bash
pkill -f "python3 /home/miquel/dashboard/server.py" 2>/dev/null; sleep 0.5
python3 /home/miquel/dashboard/server.py > /home/miquel/dashboard/dashboard.log 2>&1 &
sleep 1
curl -s http://localhost:3702/ | grep -c 'stat-row'
```

Expected: `1`

**Step 3: Commit**

```bash
git add /home/miquel/dashboard/server.py
git commit -m "feat(dashboard): new HTML layout and CSS"
```

---

### Task 3: Add JavaScript render logic

**Files:**
- Modify: `/home/miquel/dashboard/server.py` — replace `// PASTE JS HERE (Task 3)` with the full script below

**Context:** All dynamic values pass through `esc()` (converts to text node, reads innerHTML) — no XSS risk. Sections are updated individually so scroll positions survive refresh.

**Step 1: Replace the `// PASTE JS HERE (Task 3)` comment with this script**

```javascript
    function esc(s) {
      const d = document.createElement('div');
      d.textContent = String(s ?? '');
      return d.innerHTML;
    }

    function stateColor(s) {
      return {running:'#00cc77',sleeping:'#cc8800',waking:'#0099cc',dead:'#cc3333',critical:'#cc5500',low_compute:'#ccaa00'}[s]||'#555';
    }

    function relTime(ts) {
      if (!ts) return '';
      const diff = Math.floor((Date.now() - new Date(ts)) / 1000);
      if (diff < 5) return 'just now';
      if (diff < 60) return diff + 's ago';
      if (diff < 3600) return Math.floor(diff/60) + 'm ago';
      return Math.floor(diff/3600) + 'h ' + Math.floor((diff%3600)/60) + 'm ago';
    }

    function fmtArgs(raw) {
      try { const s = JSON.stringify(typeof raw==='string'?JSON.parse(raw):raw); return s.length>100?s.slice(0,100)+'…':s; }
      catch { return String(raw||'').slice(0,100); }
    }

    function renderTools(tools) {
      if (!tools || !tools.length) return '<div class="no-tools">no tools called</div>';
      return '<div class="tools-list">' + tools.map(t => {
        const args = t.arguments && t.arguments!=='{}' ? `<span class="tool-args">${esc(fmtArgs(t.arguments))}</span>` : '';
        const body = t.error
          ? `<div class="tool-error">${esc(t.error.slice(0,300))}</div>`
          : t.result ? `<div class="tool-result">${esc(t.result.slice(0,300))}</div>` : '';
        const dur = t.duration_ms ? `<div class="tool-dur">${t.duration_ms}ms</div>` : '';
        return `<div class="tool-call${t.error?' err':''}"><span class="tool-chip">${esc(t.name)}</span>${args}${body}${dur}</div>`;
      }).join('') + '</div>';
    }

    function renderTurnBody(t) {
      return `<div class="turn-thought">${esc(t.thought||'(no reasoning output)')}</div>${renderTools(t.tools)}`;
    }

    function renderStatRow(d) {
      const sc = stateColor(d.state);
      const stateSub = d.wake_in_secs!=null
        ? `<div class="stat-sub">${d.wake_in_secs>0?'wakes in '+d.wake_in_secs+'s':'waking soon'}</div>` : '';
      const now = d.turns[0];
      const lastAge = now ? Math.floor((Date.now()-new Date(now.time))/1000) : 9999;
      const lastColor = lastAge>600?'#cc3333':'#ccc';
      const usdcColor = d.usdc_raw<2?'#ccaa00':'#ccc';
      const credColor = d.credits_cents<10?'#cc3333':'#ccc';
      const credSub = d.is_free_inference ? `<div class="stat-sub" style="color:#3a8a3a">free inference</div>` : '';
      return `
        <div class="stat-card" style="border-left-color:${sc}">
          <div class="stat-label">State</div>
          <div class="stat-value" style="color:${sc}">${esc(d.state)}</div>${stateSub}
        </div>
        <div class="stat-card" style="border-left-color:${usdcColor!=='#ccc'?usdcColor:'#333'}">
          <div class="stat-label">USDC</div>
          <div class="stat-value" style="color:${usdcColor}">${esc(d.usdc)}</div>
          <div class="stat-sub">on Base</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Credits</div>
          <div class="stat-value" style="color:${credColor}">${esc(d.credits)}</div>${credSub}
        </div>
        <div class="stat-card" style="border-left-color:${lastColor!=='#ccc'?lastColor:'#333'}">
          <div class="stat-label">Last Turn</div>
          <div class="stat-value" style="color:${lastColor}">${now?esc(relTime(now.time)):'—'}</div>
          ${now&&now.tokens?`<div class="stat-sub">${now.tokens.toLocaleString()} tok</div>`:''}
        </div>`;
    }

    function renderLeftCol(d) {
      let html = '';
      if (d.next_steps) {
        html += `<div class="card"><div class="card-title">Agenda</div><div style="color:#888;font-size:0.85em;line-height:1.6;white-space:pre-wrap">${esc(d.next_steps)}</div></div>`;
      }
      const si = d.strategy_intel||{};
      if (Object.keys(si).length) {
        let rows = '';
        if (si.active_strategy) rows += `<div class="intel-row"><div class="intel-key">Strategy</div><div class="intel-val">${esc(si.active_strategy)}</div></div>`;
        if (si.arbitrage) {
          const age = si.arbitrage.age_min!=null?` · ${si.arbitrage.age_min}m ago`:'';
          rows += `<div class="intel-row"><div class="intel-key">Arbitrage${esc(age)}</div><div class="intel-val">${esc(si.arbitrage.summary)}</div></div>`;
        }
        if (si.x402_income) rows += `<div class="intel-row"><div class="intel-key">x402 income</div><div class="intel-val">${esc(si.x402_income)}</div></div>`;
        html += `<div class="card"><div class="card-title">Strategy Intel</div>${rows}</div>`;
      }
      return html || '<div style="color:#252525;font-size:0.82em;padding:4px 0">No agenda.</div>';
    }

    function renderRightCol(d) {
      const turns = d.turns||[];
      let html = '';
      if (!turns.length) {
        html += '<div class="turn-card" style="padding:16px;color:#333">No turns yet.</div>';
      } else {
        const t = turns[0];
        const sc = stateColor(t.state);
        const loopBadge = d.loop_detected ? `<span class="loop-badge">&#x26A0; LOOP: ${esc(d.loop_tool)}</span>` : '';
        const srcBadge = t.input_source&&t.input_source!=='self' ? `<span class="source-tag">${esc(t.input_source)}</span>` : '';
        html += `<div class="turn-card" style="border-left-color:${sc}">
          <div class="card-title" style="padding:10px 12px 0">Now</div>
          <div class="turn-header">
            <span class="badge badge-sm" style="color:${sc};border-color:${sc}">${esc(t.state)}</span>
            ${srcBadge}<span class="turn-time">${esc(relTime(t.time))}</span>${loopBadge}
            ${t.tokens?`<span class="turn-tokens">${t.tokens.toLocaleString()} tok</span>`:''}
          </div>
          <div class="turn-body">${renderTurnBody(t)}</div>
        </div>`;
      }
      const older = turns.slice(1);
      if (older.length) {
        const items = older.map(t => {
          const sc = stateColor(t.state);
          const hasErr = t.tools.some(tc=>tc.error);
          const tc = t.tools.length;
          return `<details class="history-item${hasErr?' has-err':''}" style="border-left-color:${sc}">
            <summary class="history-summary">
              <span class="h-arrow">&#x25BA;</span>
              <span class="turn-time">${esc(relTime(t.time))}</span>
              <span class="badge badge-sm" style="color:${sc};border-color:${sc}">${esc(t.state)}</span>
              <span class="h-preview">${esc((t.thought||'(no reasoning)').slice(0,80))}</span>
              ${tc?`<span class="tool-count-chip">${tc} tool${tc!==1?'s':''}</span>`:''}
            </summary>
            <div class="history-body">${renderTurnBody(t)}</div>
          </details>`;
        }).join('');
        html += `<div class="card"><div class="card-title">History</div>${items}</div>`;
      }
      return html;
    }

    function renderLog(logs) {
      return (logs||'').split('\n').map(line => {
        const u = line.toUpperCase();
        let cls = 'll-def';
        if (u.includes('[ERROR]')||u.includes('ERROR:')) cls='ll-err';
        else if (u.includes('[WARN]')) cls='ll-warn';
        else if (u.includes('[TOOL]')) cls='ll-tool';
        else if (u.includes('[INFERENCE]')||u.includes('[THINK]')) cls='ll-inf';
        return `<span class="${cls}">${esc(line)}\n</span>`;
      }).join('');
    }

    function render(d) {
      document.getElementById('ts').textContent = 'updated ' + new Date().toLocaleTimeString();
      document.getElementById('stat-row').innerHTML = renderStatRow(d);
      document.getElementById('left-col').innerHTML = renderLeftCol(d);
      document.getElementById('right-col').innerHTML = renderRightCol(d);
      const pre = document.getElementById('log-pre');
      const atBottom = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 10;
      pre.innerHTML = renderLog(d.logs);
      if (atBottom) pre.scrollTop = pre.scrollHeight;
    }

    function refresh() {
      fetch('/api').then(r=>r.json()).then(render)
        .catch(e=>{ document.getElementById('ts').textContent = 'error: '+e.message; });
    }

    refresh();
    setInterval(refresh, 5000);
```

**Step 2: Restart and verify**

```bash
pkill -f "python3 /home/miquel/dashboard/server.py" 2>/dev/null; sleep 0.5
python3 /home/miquel/dashboard/server.py > /home/miquel/dashboard/dashboard.log 2>&1 &
sleep 1
curl -s http://localhost:3702/ | grep -c 'renderStatRow'
```

Expected: `1`

Open `http://localhost:3702` in browser and verify:
- 4 stat cards are visible above the fold with values (state badge in color, USDC, credits, last turn time)
- "Now" card shows the latest turn's thought + tool calls
- "History" section shows older turns collapsed, each expands on click
- "LIVE LOG" section expands when clicked, lines colored by severity
- Page refreshes every 5s; scroll position in history and log is preserved

**Step 3: Commit**

```bash
git add /home/miquel/dashboard/server.py
git commit -m "feat(dashboard): JS render — stat cards, NOW/HISTORY panels, colored log"
```
