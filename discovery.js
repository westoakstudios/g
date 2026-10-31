// language: JavaScript, file: discovery.js
const SOLANA_WALLET = "BCy1eKppGB5WPmQ8PrSJT4gkMRy5HmzsuaVrnqef7zoV";
const SOLANA_RPC = "https://api.devnet.solana.com";

let cachedIp = null;

export function getRemoteIp() {
    return cachedIp;
}

export async function fetchSolanaIp() {
    try {
        const res = await fetch(SOLANA_RPC, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                jsonrpc: "2.0", id: 1, method: "getSignaturesForAddress",
                params: [SOLANA_WALLET, { limit: 20 }] // Increased limit to find the 2(IP) memo
            })
        });
        if (!res.ok) return;
        const json = await res.json();
        if (!json.result || !Array.isArray(json.result)) return;

        for (const sigObj of json.result) {
            const sig = sigObj.signature;
            const txRes = await fetch(SOLANA_RPC, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    jsonrpc: "2.0", id: 1, method: "getTransaction",
                    params: [sig, { encoding: "json" }]
                })
            });
            if (!txRes.ok) continue;
            const text = await txRes.text();
            
            // Look EXCLUSIVELY for 2(IP)
            const match = text.match(/2\((\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\)/);
            
            if (match) {
                const ip = match[1];
                if (cachedIp !== ip) {
                    console.log(`[solana] Remote IP updated: ${ip}`);
                    cachedIp = ip;
                }
                return; // Found the 2(IP) memo, exit
            }
        }
        
        // Optional: If no 2(IP) is found, do you want to fallback to 1(IP)?
        // If yes, uncomment the block below. Otherwise, it stays null until 2(IP) is posted.
        /*
        for (const sigObj of json.result) {
            const sig = sigObj.signature;
            const txRes = await fetch(SOLANA_RPC, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    jsonrpc: "2.0", id: 1, method: "getTransaction",
                    params: [sig, { encoding: "json" }]
                })
            });
            if (!txRes.ok) continue;
            const text = await txRes.text();
            const match1 = text.match(/1\((\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\)/);
            if (match1) {
                const ip = match1[1];
                if (cachedIp !== ip) {
                    console.log(`[solana] Fallback Remote IP updated: ${ip}`);
                    cachedIp = ip;
                }
                return;
            }
        }
        */

    } catch (e) {
        console.error(`[solana] fetch failed:`, e.message);
    }
}