import { parentPort } from 'worker_threads';

parentPort?.on('message', async (payload) => {
    try {
        const res = await fetch(payload.targetUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
        });

        if (!res.ok) {
            parentPort?.postMessage({ success: false, error: `HTTP ${res.status}` });
        } else {
            parentPort?.postMessage({ success: true });
        }
    } catch (err) {
        parentPort?.postMessage({ success: false, error: (err as Error).message });
    }
});
