import { exec } from 'child_process';

export const executeAgathaCommand = (command: string) => {
    console.log(`\x1b[36m[AGATHA EXECUTING]: ${command}\x1b[0m`);
    exec(command, (error, stdout, stderr) => {
        if (error) console.error(`Error: ${error.message}`);
        if (stdout) console.log(`Output: ${stdout}`);
    });
};