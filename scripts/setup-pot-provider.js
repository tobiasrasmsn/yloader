const fs = require('fs');
const path = require('path');
const https = require('https');
const { execSync } = require('child_process');

const RELEASE_TAG = 'v0.6.3';
const REPO = 'jim60105/bgutil-ytdlp-pot-provider-rs';

const PLUGINS_DIR = path.join(__dirname, '../ytdlp_plugins');
const BIN_DIR = path.join(__dirname, '../bin');

if (!fs.existsSync(PLUGINS_DIR)) fs.mkdirSync(PLUGINS_DIR, { recursive: true });
if (!fs.existsSync(BIN_DIR)) fs.mkdirSync(BIN_DIR, { recursive: true });

function downloadFile(url, dest) {
    return new Promise((resolve, reject) => {
        const file = fs.createWriteStream(dest);
        https.get(url, (response) => {
            if (response.statusCode === 302 || response.statusCode === 301) {
                downloadFile(response.headers.location, dest).then(resolve).catch(reject);
                return;
            }
            response.pipe(file);
            file.on('finish', () => {
                file.close(resolve);
            });
        }).on('error', (err) => {
            fs.unlink(dest, () => reject(err));
        });
    });
}

function getBinaryName() {
    const platform = process.platform;
    const arch = process.arch;

    if (platform === 'darwin') {
        if (arch === 'arm64') return 'bgutil-pot-macos-aarch64';
        if (arch === 'x64') return 'bgutil-pot-macos-x86_64';
    } else if (platform === 'linux') {
        if (arch === 'x64') return 'bgutil-pot-linux-x86_64';
    } else if (platform === 'win32') {
        if (arch === 'x64') return 'bgutil-pot-windows-x86_64.exe';
    }

    throw new Error(`Unsupported platform/arch: ${platform}-${arch}`);
}

async function install() {
    console.log('Setting up PO Token Provider...');

    // 1. Download Plugin Zip
    console.log('Downloading plugin python script...');
    const pluginZipUrl = `https://github.com/${REPO}/releases/download/${RELEASE_TAG}/bgutil-ytdlp-pot-provider-rs.zip`;
    const pluginZipPath = path.join(PLUGINS_DIR, 'plugin.zip');

    await downloadFile(pluginZipUrl, pluginZipPath);
    console.log('Plugin zip downloaded.');

    // Unzip (using unzip command for simplicity, generic for mac/linux)
    try {
        execSync(`unzip -o "${pluginZipPath}" -d "${PLUGINS_DIR}"`);
        console.log('Plugin unzipped.');
    } catch (e) {
        console.error('Failed to unzip plugin:', e.message);
        process.exit(1);
    }
    fs.unlinkSync(pluginZipPath);

    // 2. Download Binary
    console.log('Detecting OS for binary download...');
    const binaryName = getBinaryName();
    const binaryUrl = `https://github.com/${REPO}/releases/download/${RELEASE_TAG}/${binaryName}`;
    const targetBinaryName = process.platform === 'win32' ? 'bgutil-ytdlp-pot-provider.exe' : 'bgutil-ytdlp-pot-provider';
    const binaryDest = path.join(BIN_DIR, targetBinaryName);

    console.log(`Downloading binary: ${binaryName}...`);
    await downloadFile(binaryUrl, binaryDest);

    if (process.platform !== 'win32') {
        fs.chmodSync(binaryDest, '755');
    }

    console.log(`Binary installed to ${binaryDest}`);
    console.log('Setup complete!');
}

install().catch(err => {
    console.error('Installation failed:', err);
    process.exit(1);
});
