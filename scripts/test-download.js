const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const apiKey = process.env.API_KEY;
const port = process.env.PORT || 3000;
const url = process.argv[2];

if (!url) {
    console.error("Please provide a YouTube URL as an argument.");
    console.log("Usage: node scripts/test-download.js <youtube_url>");
    process.exit(1);
}

if (!apiKey) {
    console.error("API_KEY not found in .env file");
    process.exit(1);
}

const apiBase = `http://localhost:${port}`;

async function runTest() {
    console.log(`Sending download request for: ${url}`);
    console.log(`Target: ${apiBase}/download`);

    try {
        const response = await fetch(`${apiBase}/download`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "x-api-key": apiKey,
            },
            body: JSON.stringify({ url }),
        });

        if (!response.ok) {
            const text = await response.text();
            throw new Error(`HTTP ${response.status}: ${text}`);
        }

        const data = await response.json();
        console.log("Download started successfully!");
        console.log("Job ID:", data.jobId);

        // Poll status
        pollStatus(data.jobId);

    } catch (error) {
        console.error("Error starting download:", error.message);
        if (error.cause) console.error(error.cause);
    }
}

async function pollStatus(jobId) {
    console.log("\nPolling status (Ctrl+C to stop)...");
    const interval = setInterval(async () => {
        try {
            const res = await fetch(`${apiBase}/status/${jobId}`, {
                headers: { "x-api-key": apiKey }
            });

            if (!res.ok) throw new Error(`Status check failed: ${res.status}`);

            const job = await res.json();

            process.stdout.write(`\rStatus: ${job.status.toUpperCase()} | Progress: ${job.progress ? Number(job.progress).toFixed(1) : 0}% `);

            if (job.status === 'completed') {
                clearInterval(interval);
                console.log("\n\n✅ Job Completed!");
                console.log("S3 URL:", job.s3Url);
            } else if (job.status === 'error') {
                clearInterval(interval);
                console.log("\n\n❌ Job Failed!");
                console.log("Error:", job.error);
            }
        } catch (err) {
            console.error("\nError polling status:", err.message);
            clearInterval(interval);
        }
    }, 1000);
}

runTest();
