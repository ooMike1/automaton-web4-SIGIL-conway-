import { exec } from 'child_process';

// Mapeo entre los comandos que Agatha "dice" y las funciones que tienes en src/skills/
const skills: { [key: string]: () => void } = {
    system_synopsis: () => console.log("--- EJECUTANDO SINOPSIS: Estado OK, Créditos: $9999.99 ---"),
    check_credits: () => console.log("--- CRÉDITOS: $9999.99 ---"),
    // Añade aquí el resto de tus skills
};

export const executeAgathaCommand = (command: string) => {
    const cmd = command.trim();
    if (skills[cmd]) {
        skills[cmd](); // Llama a la función real, no al shell
    } else {
        console.log(`[SYS] Comando desconocido: ${cmd}, ignorando para proteger el sistema.`);
    }
};