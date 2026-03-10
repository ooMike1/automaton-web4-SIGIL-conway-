/**
 * Wake-on-LAN (WoL) Utilities
 * 
 * Sends Wake-on-LAN magic packets to remote machines over the network.
 * Useful for waking Ollama server when inference is needed but machine is sleeping.
 */

import { createSocket } from "dgram";

interface WolConfig {
    targetMac: string;        // Target machine MAC address (e.g., "AA:BB:CC:DD:EE:FF")
    broadcastAddr: string;    // Broadcast address (e.g., "192.168.50.255")
    port?: number;            // WoL port (default: 9)
    maxRetries?: number;      // Number of packets to send (default: 3)
}

/**
 * Convert MAC address string to byte format
 * Example: "AA:BB:CC:DD:EE:FF" → Buffer
 */
function parseMac(macStr: string): Buffer {
    const parts = macStr.split(":");
    if (parts.length !== 6) {
        throw new Error(`Invalid MAC address format: ${macStr}. Expected AA:BB:CC:DD:EE:FF`);
    }
    return Buffer.from(parts.map((p) => parseInt(p, 16)));
}

/**
 * Generate WoL magic packet
 * Format: 6 bytes of 0xFF, followed by 16 repetitions of the target MAC
 */
function generateMagicPacket(mac: Buffer): Buffer {
    const packet = Buffer.alloc(102);

    // Fill first 6 bytes with 0xFF (synchronization stream)
    packet.fill(0xFF, 0, 6);

    // Repeat MAC address 16 times
    for (let i = 0; i < 16; i++) {
        mac.copy(packet, 6 + i * 6);
    }

    return packet;
}

/**
 * Send Wake-on-LAN magic packet to target machine
 */
export async function sendWoLPacket(config: WolConfig): Promise<boolean> {
    return new Promise((resolve) => {
        const { targetMac, broadcastAddr, port = 9, maxRetries = 3 } = config;

        try {
            const mac = parseMac(targetMac);
            const packet = generateMagicPacket(mac);

            const socket = createSocket("udp4");

            socket.on("error", (err) => {
                console.error(`[WOL] Error: ${err.message}`);
                socket.close();
                resolve(false);
            });

            let sentCount = 0;
            const sendPacket = () => {
                if (sentCount >= maxRetries) {
                    socket.close();
                    resolve(true);
                    return;
                }

                socket.send(packet, 0, packet.length, port, broadcastAddr, (err) => {
                    if (err) {
                        console.error(`[WOL] Send error: ${err.message}`);
                        socket.close();
                        resolve(false);
                        return;
                    }

                    sentCount++;
                    console.log(`[WOL] Magic packet sent (${sentCount}/${maxRetries}) to ${targetMac}`);
                    // Send next packet after 100ms
                    if (sentCount < maxRetries) {
                        setTimeout(sendPacket, 100);
                    } else {
                        socket.close();
                        resolve(true);
                    }
                });
            };

            sendPacket();

            // Timeout after 5 seconds
            setTimeout(() => {
                socket.close();
            }, 5000);

        } catch (err: any) {
            console.error(`[WOL] Error: ${err.message}`);
            resolve(false);
        }
    });
}

/**
 * Check if remote machine is reachable via HTTP
 */
export async function isHostReachable(
    url: string,
    timeoutMs: number = 3000
): Promise<boolean> {
    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

        const response = await fetch(url, {
            method: "GET",
            signal: controller.signal,
        });

        clearTimeout(timeoutId);
        return response.ok || response.status < 500;
    } catch {
        return false;
    }
}

/**
 * Wake machine if not reachable, then wait for it to be available
 */
export async function wakeAndWait(
    config: WolConfig,
    checkUrl: string,
    maxWaitMs: number = 60000
): Promise<boolean> {
    // Check if already awake
    console.log(`[WOL] Checking if ${checkUrl} is reachable...`);
    const isAwake = await isHostReachable(checkUrl, 3000);
    if (isAwake) {
        console.log(`[WOL] ✅ Host already awake`);
        return true;
    }

    console.log(`[WOL] ⏰ Host not reachable. Sending WoL packets...`);
    const sent = await sendWoLPacket(config);

    if (!sent) {
        console.error(`[WOL] ❌ Failed to send WoL packet`);
        return false;
    }

    // Wait for machine to wake up
    console.log(`[WOL] 🛫 Waiting for machine to wake up (max ${maxWaitMs}ms)...`);
    const startTime = Date.now();

    while (Date.now() - startTime < maxWaitMs) {
        await new Promise((resolve) => setTimeout(resolve, 2000)); // Check every 2 seconds

        if (await isHostReachable(checkUrl, 3000)) {
            const elapsed = Date.now() - startTime;
            console.log(`[WOL] ✅ Host woke up after ${elapsed}ms`);
            return true;
        }
    }

    console.error(`[WOL] ⏱️ Timeout waiting for machine to wake up`);
    return false;
}
