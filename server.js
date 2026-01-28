const express = require('express');
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const app = express();
app.use(helmet({
    contentSecurityPolicy: false, // Legacy Safari struggles with strict CSP
    hsts: false, // Local network usage (HTTP) - prevents forced HTTPS upgrade
}));
app.disable('x-powered-by');
const PORT = process.env.PORT || 3000;
const DEBUG = process.env.DEBUG === 'true';

// Rate Limiting (DoS Protection)
const apiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    limit: 500, // Limit each IP to 500 requests per 15 minutes (~33/min, plenty for 8 devices)
    standardHeaders: 'draft-7',
    legacyHeaders: false,
});

// Configuration Defaults
const config = {
    immichUrl: process.env.IMMICH_URL || '',
    apiKey: process.env.IMMICH_API_KEY || '',
    settings: {
        interval: parseInt(process.env.INTERVAL) || 15,
        transition: process.env.TRANSITION || 'fade',
        imageFit: process.env.IMAGE_FIT || 'cover',
        albumId: process.env.ALBUM_ID || ''
    }
};

// Check for required config
if (!config.immichUrl || !config.apiKey) {
    console.warn("WARNING: IMMICH_URL and IMMICH_API_KEY environment variables are not set.");
}

// Remove trailing slash from Immich URL
if (config.immichUrl.endsWith('/')) {
    config.immichUrl = config.immichUrl.slice(0, -1);
}

// Proxy Endpoint for Immich API
app.use('/api/proxy', apiLimiter, (req, clientRes) => {
    // 1. Security: Only allow GET and HEAD requests
    if (req.method !== 'GET' && req.method !== 'HEAD') {
        return clientRes.status(405).json({ error: 'Method Not Allowed', details: 'Only GET requests are allowed for security.' });
    }

    // Normalize path to resolve '..' segments
    // Use posix to ensure forward slashes, essential for URL path matching
    const normalizedPath = path.posix.normalize(req.url);

    // Security: Explicitly reject path traversal attempts
    if (normalizedPath.includes('..')) {
        return clientRes.status(400).json({ error: 'Bad Request', details: 'Invalid path' });
    }

    // 2. Security: Whitelist allowed endpoints
    // Allowed: /albums/*, /asset/*, /assets/* (new API)
    const allowedPrefixes = ['/albums', '/asset', '/assets'];
    const isAllowed = allowedPrefixes.some(prefix => normalizedPath.startsWith(prefix));

    if (!isAllowed) {
        return clientRes.status(403).json({ error: 'Forbidden', details: 'Endpoint not allowed by proxy whitelist.' });
    }

    // Construct target URL
    // Immich API usually requires /api prefix.
    // We check if it's already in the config URL or implied.
    // Our proxy mounts at /api/proxy, so req.url is /albums/... or /asset/...

    let baseUrl = config.immichUrl;
    // Smart fix: If URL doesn't end in /api, append it because we are hitting API endpoints
    if (!baseUrl.endsWith('/api')) {
        baseUrl += '/api';
    }

    const targetUrl = baseUrl + normalizedPath;

    // Log the constructed URL for debugging (Only if DEBUG is enabled)
    if (DEBUG) {
        console.log(`[Proxy] Incoming: ${req.method} ${req.url}`);
        console.log(`[Proxy] Target: ${targetUrl}`);
    }

    const parsedUrl = url.parse(targetUrl);
    const options = {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
        path: parsedUrl.path,
        method: req.method,
        headers: {
            'Accept': 'application/json',
            'x-api-key': config.apiKey
        }
    };

    const requestModule = parsedUrl.protocol === 'https:' ? https : http;

    const proxyReq = requestModule.request(options, (proxyRes) => {
        if (DEBUG) {
            console.log(`[Proxy] Upstream Status: ${proxyRes.statusCode}`);
        }
        // Forward status and headers
        clientRes.writeHead(proxyRes.statusCode, proxyRes.headers);
        proxyRes.pipe(clientRes);
    });

    proxyReq.on('error', (e) => {
        console.error(`Proxy Error: ${e.message}`);
        // Sanitize error to prevent leaking internal details
        clientRes.status(502).json({ error: 'Bad Gateway' });
    });

    proxyReq.end();
});

// Serve static files BUT exclude index.html from auto-serving so we can template it
// We serve everything else from public directly
app.use(express.static('public', { index: false }));

// Serve the viewer with injected config
const serveViewer = (req, res) => {
    // Skip if requesting a file extension (likely a static asset fallback)
    if (req.path.includes('.') && req.path !== '/') {
        return res.status(404).send('Not found');
    }

    // Read the template
    const templatePath = path.join(__dirname, 'public', 'index.html');

    fs.readFile(templatePath, 'utf8', (err, data) => {
        if (err) {
            console.error('Error reading index.html:', err);
            return res.status(500).send('Internal Server Error: Could not load viewer template');
        }

        // Inject configuration
        const clientConfig = { ...config.settings, debug: DEBUG };

        // Serialize and escape to prevent XSS (e.g. </script> injection)
        const safeConfig = JSON.stringify(clientConfig).replace(/</g, '\\u003c');
        const configScript = `<script>window.IMMICH_CONFIG = ${safeConfig};</script>`;
        const html = data.replace('<!-- CONFIG_INJECTION -->', configScript);

        res.send(html);
    });
};

// Handle root route
app.get('/', serveViewer);

app.listen(PORT, () => {
    console.log(`Immich Legacy Viewer running on http://localhost:${PORT}`);
    console.log(`Target Immich Server: ${config.immichUrl}`);
    console.log(`ALBUM_ID: ${config.settings.albumId || '(Showing Favorites)'}`);
});
