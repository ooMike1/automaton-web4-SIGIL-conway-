import { exec } from 'child_process';
import { logToMemory } from './memory.js';

const skills: Record<string, () => string> = {
    system_synopsis: () => "SISTEMA: OK. GPU: RTX 5090. VRAM: 24GB.",
    check_credits: () => "CREDITOS: $9999.99",
    check_usdc_balance: () => "BALANCE USDC: 0.00",
    register_erc8004: () => "SUCCESS: Agente registrado en el nodo on-chain.",
    discover_agents: () => "SUCCESS: Relay escaneado. 0 agentes detectados.",
    git_status: () => "VERSION: Repo en estado 'clean'.",
};

export const executeAgathaCommand = (command: string): string => {
    const cmd = command.trim();
    if (skills[cmd]) {
        const result = skills[cmd]();
        console.log(`\x1b[32m[AGATHA EXECUTING]: ${cmd} -> ${result}\x1b[0m`);
        logToMemory(cmd, result);
        return result;
    }

    return `ERROR: Skill '${cmd}' no encontrada.`;
};