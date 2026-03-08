import fs from 'fs';
import path from 'path';

const MEMORY_FILE = path.join(process.env.HOME || '.', '.automaton', 'LOG.md');

export const logToMemory = (command: string, result: string): void => {
    const dir = path.dirname(MEMORY_FILE);
    fs.mkdirSync(dir, { recursive: true });
    const timestamp = new Date().toISOString();
    fs.appendFileSync(MEMORY_FILE, `[${timestamp}] ${command} -> ${result}\n`, 'utf8');
};

export const getContextualMemory = (limit: number = 5): string[] => {
    if (!fs.existsSync(MEMORY_FILE)) {
        return [];
    }

    const content = fs.readFileSync(MEMORY_FILE, 'utf8');
    const lines = content
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0);

    return lines.slice(-Math.max(0, limit));
};

export const manage_memory = (action: "summarize" | "clear") => {
    if (action === "clear") {
        fs.writeFileSync(MEMORY_FILE, "");
        return "[SYSTEM] Memoria purgada exitosamente.";
    }
    if (action === "summarize") {
        if (!fs.existsSync(MEMORY_FILE)) {
            return "[SYSTEM] Estado de memoria: 0 bytes. Esperando resumen.";
        }
        const content = fs.readFileSync(MEMORY_FILE, 'utf8');
        // Aquí podrías enviar este contenido a la GPU para que lo resuma
        // Pero por ahora, simplemente marcamos que se ha solicitado una gestión
        return "[SYSTEM] Estado de memoria: " + content.length + " bytes. Esperando resumen.";
    }
};