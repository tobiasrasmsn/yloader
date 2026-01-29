const express = require("express");
const { v4: uuidv4 } = require("uuid");
const YTDlpWrap = require("yt-dlp-wrap").default;
const path = require("path");
const fs = require("fs");
const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");
const { Upload } = require("@aws-sdk/lib-storage");
const ffmpegPath = require("ffmpeg-static");
require("dotenv").config(); // Load environment variables

const app = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY;
const S3_BUCKET = process.env.S3_BUCKET;
const S3_REGION = process.env.S3_REGION || "us-east-1"; // Hetzner specific region if needed, usually 'fsn1' or similar depending on setup, or standard
const S3_ENDPOINT = process.env.S3_ENDPOINT; // e.g., https://fsn1.your-objectstorage.com
const S3_ACCESS_KEY = process.env.S3_ACCESS_KEY;
const S3_SECRET_KEY = process.env.S3_SECRET_KEY;

if (!API_KEY) {
  console.error("API_KEY is not set in .env file. Exiting.");
  process.exit(1);
}

// S3 Client
const s3Client = new S3Client({
  region: S3_REGION,
  endpoint: S3_ENDPOINT,
  credentials: {
    accessKeyId: S3_ACCESS_KEY,
    secretAccessKey: S3_SECRET_KEY,
  },
  forcePathStyle: true, // often needed for 3rd party S3 providers
});

// Proxy Configuration
const PROXY_USER = "spp8q2l5te";
const PROXY_PASS = "B5a9dab+Fsc16jPQkn";
const PROXY_HOST = "isp.decodo.com";
const PROXY_PORTS = [10001, 10002, 10003];

function getProxyUrl(excludePort = null) {
  let port;
  do {
    port = PROXY_PORTS[Math.floor(Math.random() * PROXY_PORTS.length)];
  } while (port === excludePort);
  return {
    url: `http://${PROXY_USER}:${PROXY_PASS}@${PROXY_HOST}:${port}`,
    port,
  };
}

// Ensure downloads directory exists
const DOWNLOADS_DIR = path.join(__dirname, "../downloads");
if (!fs.existsSync(DOWNLOADS_DIR)) {
  fs.mkdirSync(DOWNLOADS_DIR);
}

// Initialize yt-dlp
const ytDlpBinaryPath = path.join(__dirname, "../yt-dlp");
// On Windows it might need .exe extension if we want to be explicit,
// but yt-dlp-wrap handles execution.
// However, for the download check, we should be careful.
const binaryName = process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp";
const fullBinaryPath = path.join(__dirname, "..", binaryName);

const ytDlpWrap = new YTDlpWrap(fullBinaryPath);

// Job store: { [jobId]: { status: 'pending' | 'downloading' | 'uploading' | 'completed' | 'error', url: string, outputPath: string, s3Url: string, error: string, progress: number } }
const jobs = new Map();

app.use(express.json());

// Public docs route (no API key required)
app.get("/docs", (req, res) => {
  res.json({
    name: "Yloader Download Service",
    description:
      "Single-purpose API to download a remote video via yt-dlp, upload it to S3-compatible object storage, and track job status.",
    endpoints: [
      {
        method: "POST",
        path: "/download",
        description:
          "Starts an asynchronous download/upload job for the given `url`. Returns a `jobId` immediately.",
        body: {
          url: "string (e.g. https://www.youtube.com/watch?v=...)",
        },
        headers: {
          "x-api-key": "required",
        },
        notes: [
          "Only single-resource downloads are allowed (`--no-playlist`).",
          "The job runs in background; poll `/status/:jobId` for updates.",
        ],
      },
      {
        method: "GET",
        path: "/status/:jobId",
        description:
          "Returns the current state of the job, including `progress`, `status`, and `s3Url` once available.",
        headers: {
          "x-api-key": "required",
        },
      },
    ],
    authentication: {
      header: "x-api-key",
      note: "Add this header or `?api_key=` query parameter on every protected request.",
    },
    errorHandling: [
      "Invalid API key: 401",
      "Missing `url`: 400 (on /download)",
      "Download, upload, or filesystem errors set job status to `error`.",
    ],
  });
});

// Authentication Middleware
const authenticate = (req, res, next) => {
  const authHeader = req.headers["x-api-key"]; // Custom header for API Key

  // Check header or query parameter (optional convenience)
  const key = authHeader || req.query.api_key;

  if (!key || key !== API_KEY) {
    return res
      .status(401)
      .json({ error: "Unauthorized: Invalid or missing API Key" });
  }
  next();
};

// Apply authentication to all routes
app.use(authenticate);

// Helper to ensure binary exists
async function ensureBinary() {
  if (!fs.existsSync(fullBinaryPath)) {
    console.log("yt-dlp binary not found. Downloading latest release...");
    try {
      await YTDlpWrap.downloadFromGithub(fullBinaryPath);
      console.log("yt-dlp binary downloaded successfully.");
    } catch (err) {
      console.error("Failed to download yt-dlp binary:", err);
      process.exit(1);
    }
  } else {
    console.log("yt-dlp binary found.");
  }
}

// POST /download
app.post("/download", async (req, res) => {
  const { url } = req.body;
  if (!url) {
    return res.status(400).json({ error: "url is required" });
  }

  const jobId = uuidv4();
  jobs.set(jobId, {
    id: jobId,
    url,
    status: "pending",
    progress: 0,
    outputPath: null,
    s3Url: null,
  });

  // Start download in background
  startDownload(jobId, url);

  res.json({ jobId });
});

// GET /status/:jobId
app.get("/status/:jobId", (req, res) => {
  const { jobId } = req.params;
  const job = jobs.get(jobId);

  if (!job) {
    return res.status(404).json({ error: "Job not found" });
  }

  res.json(job);
});

async function uploadToS3(filePath, key) {
  const fileStream = fs.createReadStream(filePath);
  const upload = new Upload({
    client: s3Client,
    params: {
      Bucket: S3_BUCKET,
      Key: key,
      Body: fileStream,
    },
    queueSize: 4,
    partSize: 25 * 1024 * 1024, // 25 MB parts keeps memory small and compatible with multipart requirements
  });

  try {
    await upload.done();
    return `${S3_ENDPOINT}/${S3_BUCKET}/${key}`;
  } catch (error) {
    console.error("S3 multipart upload error:", error);
    throw error;
  }
}

async function startDownload(jobId, url) {
  const job = jobs.get(jobId);
  job.status = "downloading";

  // Template for output filename: downloads/jobId.extension
  // We use %(ext)s to let yt-dlp decide the extension based on format
  const outputTemplate = path.join(DOWNLOADS_DIR, `${jobId}.%(ext)s`);

  const maxRetries = 10;
  let lastPort = null;

  const attemptDownload = async (proxyUrl) => {
    return new Promise((resolve, reject) => {
      const cookiesPath = path.join(__dirname, "../www.youtube.com_cookies.txt");
      const args = [
        url,
        "--proxy",
        proxyUrl,
        "-o",
        outputTemplate,
        "--no-playlist",
        "--ffmpeg-location",
        ffmpegPath,
        "-f",
        "bv*[height<=1080]+ba/b[height<=1080]/bv*+ba/b",
        "--merge-output-format",
        "mp4",
        "--extractor-args",
        "youtube:player_client=mweb",
      ];

      if (fs.existsSync(cookiesPath)) {
        args.push("--cookies", cookiesPath);
      }

      console.log(`Starting download for job ${jobId} with proxy: ${proxyUrl}`);

      const eventEmitter = ytDlpWrap.exec(args);

      eventEmitter.on("progress", (progress) => {
        job.progress = progress.percent;
      });

      eventEmitter.on("ytDlpEvent", (eventType, eventData) => {
        // console.log(eventType, eventData);
      });

      eventEmitter.on("error", (error) => {
        console.error(`Job ${jobId} error:`, error);
        reject(error);
      });

      eventEmitter.on("close", async () => {
        console.log(`Job ${jobId} download completed.`);
        job.progress = 100;

        try {
          const files = fs.readdirSync(DOWNLOADS_DIR);
          const file = files.find((f) => f.startsWith(jobId + "."));

          if (file) {
            const localPath = path.join(DOWNLOADS_DIR, file);
            job.outputPath = localPath;

            job.status = "uploading";
            console.log(`Starting S3 upload for job ${jobId}...`);

            const s3Url = await uploadToS3(localPath, file);
            job.s3Url = s3Url;
            job.status = "completed";
            console.log(`S3 upload completed for job ${jobId}: ${s3Url}`);

            fs.unlinkSync(localPath);
            console.log(`Local file deleted for job ${jobId}`);
            resolve();
          } else {
            throw new Error("Output file not found after download");
          }
        } catch (err) {
          console.error("Error processing output file:", err);
          reject(err);
        }
      });
    });
  };

  let success = false;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) {
      const delay = 2000 + (attempt - 1) * 5000;
      console.log(`Retrying job ${jobId} in ${delay / 1000} seconds...`);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }

    try {
      const proxyData = getProxyUrl(lastPort);
      const proxyUrl = proxyData.url;
      lastPort = proxyData.port;

      await attemptDownload(proxyUrl);
      success = true;
      break;
    } catch (error) {
      console.error(
        `Attempt ${attempt + 1} failed for job ${jobId}:`,
        error.message,
      );
    }
  }

  if (!success) {
    job.status = "error";
    job.error = "Download failed after all retries";
  }
}

// Helper to ensure PO Token Provider exists
async function ensurePotProvider() {
  const serverDir = path.join(__dirname, '../bgutil-server/bgutil-ytdlp-pot-provider/server');

  // Check if server is built
  if (!fs.existsSync(path.join(serverDir, 'build/main.js'))) {
    console.log("BGUtil server not found. Setting up...");
    const { execSync } = require('child_process');

    // Create directory
    execSync(`mkdir -p ${path.join(__dirname, '../bgutil-server')}`, { stdio: 'inherit' });

    // Clone and build
    execSync(`cd ${path.join(__dirname, '../bgutil-server')} && git clone --single-branch --branch 1.2.2 https://github.com/Brainicism/bgutil-ytdlp-pot-provider.git`, { stdio: 'inherit' });
    execSync(`cd ${serverDir} && npm install && npx tsc`, { stdio: 'inherit' });
  }

  // Check if server is already running
  try {
    const response = await fetch('http://127.0.0.1:4416/ping');
    if (response.ok) {
      console.log("BGUtil server already running");
      return;
    }
  } catch (e) {
    // Server not running, start it
  }

  // Start server in background
  const { spawn } = require('child_process');
  const server = spawn('node', [path.join(serverDir, 'build/main.js')], {
    detached: true,
    stdio: 'ignore'
  });
  server.unref();

  console.log("BGUtil server started");

  // Wait for server to be ready
  for (let i = 0; i < 10; i++) {
    await new Promise(r => setTimeout(r, 1000));
    try {
      const response = await fetch('http://127.0.0.1:4416/ping');
      if (response.ok) {
        console.log("BGUtil server ready");
        return;
      }
    } catch (e) { }
  }

  throw new Error("BGUtil server failed to start");
}

// Start server
Promise.all([ensureBinary(), ensurePotProvider()]).then(() => {
  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
});
