# Universal Arbitrage Engine - Conway Autonomous Trading

## Overview
Conway ahora ejecuta arbitraje **completamente independiente del exchange**, con **auto-descubrimiento y validación** de DEXs.

## 🏗️ Arquitectura

### 1. **DEX Discovery Engine**
```
Componente: DEXDiscoveryEngine
├─ Tareas:
│  ├─ Descubrir nuevos DEXs vía The Graph
│  ├─ Validar fitness de cada DEX  
│  ├─ Registrar DEXs aprobados
│  └─ Mantener registry persistente
│
└─ Validación (score 0-100):
   ├─ Liquidez mínima: $5000 USD
   ├─ Fees máximas: 0.5%
   ├─ Volumen 24h: > $10K
   └─ Historial: >= 1 swap ejecutado
```

### 2. **Universal Pool Scanner**
```
Componente: UniversalPoolScanner
├─ Tareas:
│  ├─ Escanear pools en TODOS los DEXs registrados
│  ├─ Filtrar por pares de trading (ETH/USDC, ARB/USDC, etc)
│  ├─ Obtener precios en vivo via The Graph
│  └─ Calcular profundidad de liquidez
│
└─ Fuentes:
   ├─ The Graph (Uniswap V3, Camelot, Balancer)
   ├─ Alchemy RPC (validación)
   └─ Chain indexing (histórico)
```

### 3. **Arbitrage Detector**
```
Componente: UniversalArbitrageDetector
├─ Tareas:
│  ├─ Comparar precios entre DEXs
│  ├─ Detectar spreads > 1%
│  ├─ Calcular profit (fees - slippage)
│  └─ Ejecutar swaps si profit > $10
│
└─ Lógica:
   Spread = ((PriceSell - PriceBuy) / PriceBuy) * 100
   Profit = Spread - (Fee1 + Fee2) * 100 - SlippageBuffer(0.5%)
```

## 🔄 Flujo de Ejecución (cada 5 minutos)

```
[HEARTBEAT] arbitrage_scan
    ↓
[DISCOVERY] Buscar nuevos DEXs
    ├─ Query The Graph
    ├─ Validar fitness
    └─ Registrar si score > 50
    ↓
[SCANNER] Obtener pools
    ├─ Arbitrum pools (liquidez actual)
    ├─ Filtrar pares de trading
    └─ Cross-DEX precios
    ↓
[DETECTOR] Buscar oportunidades
    ├─ Group by token pair
    ├─ Sort by price
    ├─ Detect spreads > 1%
    └─ Calculate profit
    ↓
[EXECUTOR] Ejecutar swaps
    ├─ Profit > $10 USD ?
    ├─ Si: 1Inch optimal route
    ├─ Si: Execute swap
    └─ No: Log y skip
    ↓
[DB] Registrar resultado
    ├─ Oportunidades encontradas
    ├─ Swaps ejecutados
    ├─ Ganancias
    └─ Errores
```

## 🔗 DEXs Soportados

### Built-in Registry
| DEX | ID | Router | Factory | Min Liquidity | Fees | Status |
|-----|----|----|---------|----------------|-------|--------|
| Uniswap V3 | `uniswap-v3` | 0xE592... | 0x1F98... | $10K | 0.05% | ✅ Active |
| Camelot | `camelot` | 0xc873... | 0x1F1E... | $5K | 0.25% | ✅ Active |
| Balancer | `balancer` | 0xBA12... | 0x752E... | $15K | 0.3% | ✅ Active |

### Auto-Discovery
- Nuevos DEXs son descubiertos automáticamente via The Graph
- Validación automática antes de registrar
- Registry persiste en DB
- Score >= 50 = Habilitado para trading

## 📊 Ejemplo de Ejecución

```
[ARBITRAGE] Starting universal arbitrage scan...
[ARBITRAGE] Discovered 3 pools from Uniswap V3
[ARBITRAGE] Found 2 pools on Camelot

Token Pair: ETH/USDC
├─ Uniswap V3: $2450.25 (Liquidity: $52M)
├─ Camelot:    $2445.80 (Liquidity: $18M)
├─ Spread: 0.18%
├─ Fees impact: 0.3%
├─ Net profit: NEGATIVE (-0.12%) ❌
└─ Skip

Token Pair: ARB/USDC
├─ Camelot:    $1.2850 (Liquidity: $8M)
├─ Uniswap V3: $1.2945 (Liquidity: $42M)
├─ Spread: 0.74%
├─ Fees impact: 0.3%
├─ Net profit: 0.44% ✅
├─ Profit per 1000 ARB: $4.40
└─ Skip (profit < $10 min)

Token Pair: GMX/USDC
├─ Balancer:   $23.45 (Liquidity: $12M)
├─ Uniswap V3: $23.85 (Liquidity: $35M)
├─ Spread: 1.71%
├─ Fees impact: 0.35%
├─ Net profit: 1.36%
├─ Profit per 100 GMX: $13.60 ✅
└─ 🚀 EXECUTING SWAP

[ARBITRAGE] 🚀 Executing: GMX/USDC
   Buy @ Balancer: $23.45
   Sell @ Uniswap V3: $23.85
   Profit: 1.36% ($13.60)
   Route: 1Inch optimal
   Hash: 0x04439867e0fc... [PENDING]

[DB] Registered execution
   Timestamp: 2026-03-08T21:05:00Z
   Pair: GMX/USDC
   Profit: $13.60
   Status: QUEUED
```

## 🛡️ DEX Fitness Validation

Cuando Conway detecta un DEX nuevo:

```typescript
Score = 100

- Liquidez mínima < $5K?      → Score -= 20
- Fees > 0.5%?                → Score -= 15
- No validado en 7 días?      → Score -= 10
- Sin historial de swaps?     → Score -= 5

Si Score < 50 → RECHAZADO ❌
Si Score >= 50 → REGISTRADO ✅
```

## 💾 Persistencia

```
~/.automaton/state.db
├─ dex_registry
│  ├─ name, id, type
│  ├─ router, factory
│  ├─ min_liquidity, fees
│  ├─ discovered_at
│  ├─ last_validated
│  └─ total_swaps_executed
│
├─ arbitrage_executions
│  ├─ timestamp
│  ├─ token_pair
│  ├─ buy_dex, sell_dex
│  ├─ profit_usd
│  ├─ tx_hash
│  └─ status
│
└─ dex_validation_log
   ├─ dex_id
   ├─ fitness_score
   ├─ issues
   └─ validation_timestamp
```

## 🚀 Próximas Features

- [ ] Flash loans para capital dinámico
- [ ] Sandwich attack detection  
- [ ] MEV protection (private pools)
- [ ] Gas optimization (batch swaps)
- [ ] Liquidez dinámmica (agregar/quitar)
- [ ] Yield farming integrado
- [ ] Token pair discovery automático

## ⚙️ Configuración

Via heartbeat.yml:
```yaml
entries:
  - name: arbitrage_scan
    schedule: "*/5 * * * *"    # Cada 5 minutos
    task: arbitrage_scan
    enabled: true
```

## 📈 KPIs Monitoreados

- Oportunidades detectadas por ciclo
- Tasa de ejecución (% ejecutadas vs detectadas)
- ROI promedio por trade
- Slippage promedio 
- DEXs activos en registry
- Uptime del engine
- Ganancias acumuladas

## 🔐 Seguridad

✅ Profit threshold ($10 USD) previene microtradesMicrosoft 
✅ Slippage buffer (0.5%) protege contra frontrunning
✅ DEX validation previene ataques
✅ Todas las operaciones logeadas para auditoría
✅ Sandbox mode + USDC real respaldo

---

**Status:** 🟢 PRODUCTION READY  
**Última actualización:** 2026-03-08  
**Engine:** Universal Multi-DEX v1.0
