# Dashboard Redesign Design

**Goal:** Reorganize the Agatha monitoring dashboard so that state, current activity, and financials are immediately visible without scrolling.

**Architecture:** Single Python file (`/home/miquel/dashboard/server.py`), same HTTP server, same `/api` JSON endpoint. Only the HTML/CSS/JS changes. No new dependencies.

---

## Layout

```
┌──────────────────────────────────────────────────────────┐
│  ⚡ Agatha                     [RUNNING] · updated 3s ago │  title bar
├──────────┬──────────┬──────────┬──────────────────────┤
│  STATE   │  USDC    │ CREDITS  │   LAST TURN           │  stat cards
├──────────┴──────────┴──────────┴──────────────────────┤
│  ┌─── LEFT (280px) ──────┐  ┌─── RIGHT (flex) ────────┐  │
│  │ AGENDA                │  │ NOW (always expanded)    │  │
│  │ STRATEGY INTEL        │  ├──────────────────────────┤  │
│  └───────────────────────┘  │ HISTORY (collapsible)    │  │
│                              └──────────────────────────┘  │
├──────────────────────────────────────────────────────────┤
│  LIVE LOG ▼  (full width, collapsible, 40 lines)          │
└──────────────────────────────────────────────────────────┘
```

Responsive: below 700px, stat cards go 2×2, columns stack vertically.

---

## Sections

### Stat Cards (top row, always visible)

Four cards in a row:

| Card | Data | Alert condition |
|------|------|-----------------|
| STATE | `agent_state` KV, color-coded badge. Below: "wakes in Xs" when sleeping | Red border if dead/critical |
| USDC | `last_usdc_check` KV → balance | Amber if < $2.00 |
| CREDITS | `last_credit_check` KV → cents. Shows "FREE" badge if free inference active | Red if < $0.10 |
| LAST TURN | Relative time of most recent turn + token count | Red if > 10 min ago (agent stuck) |

### Left Column

**AGENDA** — `next_steps` KV, pre-wrap, hidden if empty.

**STRATEGY INTEL** — hidden if all keys empty. Shows:
- `active_income_strategy` KV
- `last_universal_arbitrage` KV → first meaningful line + age in minutes
- `x402_income_total` KV

### Right Column

**NOW** — Latest turn, always fully expanded:
- Header: timestamp, token count, input source badge if not "self"
- Full thought text (max-height 400px, scrollable overflow)
- Tool calls: `⚡ tool_name {args}` → `→ result` or `✗ error` indented below
- Loop badge: amber `⚠ LOOP` if 3 consecutive turns share the same first tool call

**HISTORY** — Turns 2–15, each a collapsible card:
- Collapsed header: time ago · state badge · first 80 chars of thought · tool count chip
- Expanded: same layout as NOW panel
- Border-left color = state color
- Red border-left if turn has any tool error

### Live Log (full width, bottom)

- Collapsible section, collapsed by default, toggled by clicking header
- Last 40 lines from `/tmp/agatha.log`
- ANSI escape codes stripped
- Line coloring: `[ERROR]` → red, `[WARN]` → amber, `[TOOL]` → green, rest default

---

## UX Details

- **Auto-refresh**: every 5s
- **No full re-render on refresh**: update only changed DOM sections to prevent scroll jump in history/log
- **Same dark terminal aesthetic**: `#0d0d0d` background, `Courier New`, existing color palette
- **Stat card numbers**: 1.4em, unit text 0.8em below
- **Tool call chips**: pill-shaped tool name tag, args dimmer grey inline
- **History expand**: `▶` arrow rotates 90° on open, smooth transition
