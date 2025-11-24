/*
 * Simple Node script to exercise the `/download` and `/status` endpoints.
 *
 * Usage (Node 18+):
 *   API_KEY=your_key API_URL=http://localhost:3000 node scripts/testDownload.js
 *
 * It submits the provided YouTube URL, prints the job ID, and polls status until
 * the job finishes or fails. Adjust `TARGET_URL` if you want to fetch a different video.
 */
const dotenv = require('dotenv');
dotenv.config();
const TARGET_URL =
    'https://www.youtube.com/watch?v=LAEyVTAtyJA&pp=0gcJCQsKAYcqIYzv';
const API_KEY = process.env.API_KEY;
const API_URL = process.env.API_URL || 'http://localhost:3000';

if (!API_KEY) {
    console.error('Please set API_KEY in your environment.');
    process.exit(1);
}

let fetchFn = globalThis.fetch;
if (!fetchFn) {
    try {
        fetchFn = require('undici').fetch;
    } catch (error) {
        console.error(
            'Fetch is unavailable and undici could not be loaded:',
            error
        );
        process.exit(1);
    }
}

async function startJob() {
    const response = await fetchFn(`${API_URL}/download`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-api-key': API_KEY,
        },
        body: JSON.stringify({ url: TARGET_URL }),
    });

    if (!response.ok) {
        throw new Error(
            `Download request failed: ${response.status} ${response.statusText}`
        );
    }

    const body = await response.json();
    return body.jobId;
}

async function pollStatus(jobId) {
    console.log(`Polling job ${jobId}…`);

    while (true) {
        const res = await fetchFn(`${API_URL}/status/${jobId}`, {
            headers: {
                'x-api-key': API_KEY,
            },
        });

        if (!res.ok) {
            throw new Error(
                `Status request failed: ${res.status} ${res.statusText}`
            );
        }

        const job = await res.json();
        console.log(
            `[${new Date().toISOString()}] status=${job.status} progress=${
                job.progress
            }`
        );

        if (job.status === 'completed') {
            console.log('Finished! S3 URL:', job.s3Url);
            return;
        }

        if (job.status === 'error') {
            console.error('Job failed:', job.error);
            return;
        }

        await new Promise((resolve) => setTimeout(resolve, 5000));
    }
}

(async () => {
    try {
        const jobId = await startJob();
        console.log('Job submitted:', jobId);
        await pollStatus(jobId);
    } catch (error) {
        console.error('Test script error:', error);
        process.exit(1);
    }
})();
