# Immich Viewer for Legacy Devices

> [!IMPORTANT]
> **Disclaimer:** This project is an independent community creation and is **not affiliated with, endorsed by, or connected to the official Immich project**.

A lightweight, beautiful photo frame viewer for [Immich](https://immich.app) designed specifically for legacy devices like the iPad Mini or iPad Mini 2 (iOS 9-12).

## Features

- **Legacy Browser Support:** Optimization for old Safari (iOS 9+) using ES5 JavaScript and legacy-compatible CSS.
- **Ambient Background:** Automatically blurred, color-matched backgrounds for photos (replaces black bars).
- **Manual Navigation:** Swipe (mobile) or Arrow Keys (desktop) to browse photos manually.
- **Robust NoSleep:** Advanced screen keep-awake functionality with visual feedback and toggle support.
- **Resilient Watchdog:** Auto-reloads on network failure or slideshow stalls to ensure maintenance-free operation.
- **Lightweight:** No heavy frameworks, minimal network usage.

## Security & Privacy 🔒

This project implements a **secure proxy architecture** to protect your Immich instance, designed specifically for local network usage:

1.  **Strict Method Restriction:** The proxy *only* allows `GET` requests. All write/delete operations are blocked.
2.  **Endpoint Whitelisting:** Proxying is strictly limited to `/albums` and `/asset` paths.
3.  **Server-Side API Key:** Your API key is stored safely on the server and never exposed to the client browser.
4.  **Rate Limiting:** Protects against DoS attacks (500 requests / 15 mins).
5.  **Privacy:** No external calls. Everything runs locally on your network.

> [!NOTE]
> **Legacy Security Trade-off:** To support old devices like the iPad Mini 2 (which struggle with modern security headers), **Strict-Transport-Security (HSTS)** and **Strict Content-Security-Policy (CSP)** are disabled by default.
>
> **Assessment:** This is secure for **Local Network (LAN)** use behind a firewall. Do not expose this directly to the public internet without a reverse proxy (like Nginx/Traefik).

## Setup

### Prerequisites

- Docker and Docker Compose
- An Immich Server
- An Immich API Key

### API Key Permissions

For the viewer to work correctly, your Immich API Key needs the following permissions:

| Permission | Reason |
| :--- | :--- |
| **Album Read** | Required to list the photos inside the album(s) you select. |
| **Asset View** | Required to view photo details and thumbnails. |
| **Asset Download** | Required to fetch the full-quality original images. |

> [!TIP]
> Go to **Immich Admin > Settings > API Keys** to generate a new key. We recommend creating a dedicated "Viewer" key with **only** these read-only permissions.

### Quick Start (Docker)

1.  **Clone the repository:**
    ```bash
    git clone https://github.com/ken1kg/immich-viewer.git
    cd immich-viewer
    ```

2.  **Configure environment:**
    Create a file named `.env` in the project folder and add your details:
    ```bash
    IMMICH_URL=http://192.168.1.100:2283
    IMMICH_API_KEY=your_api_key_here
    ALBUM_ID=your_album_uuid_here
    ```

3.  **Verify `docker-compose.yml` (Optional):**
    Ensure your `docker-compose.yml` looks like this:
    ```yaml
    services:
      immich-viewer:
        build: .
        container_name: immich-viewer
        restart: unless-stopped
        ports:
          - "3000:3000"
        env_file:
          - .env
    ```

4.  **Run:**
    Open a terminal in the project folder and run:
    ```bash
    docker-compose up -d --build
    ```

5.  **Access:** Open `http://your-server-ip:3000` in your browser.

## Configuration Reference (.env)

Everything is configured via the `.env` file:

| Variable | Description | Default |
| :--- | :--- | :--- |
| `IMMICH_URL` | Your Immich server URL (include http/https) | Required |
| `IMMICH_API_KEY` | Your Immich API Key | Required |
| `ALBUM_ID` | Comma-separated Album UUIDs. Leave empty to show Favorites. | Empty (Favorites) |
| `INTERVAL` | Time in seconds between slides | `15` |
| `TRANSITION` | Transition effect: `fade` or `none` | `fade` |
| `IMAGE_FIT` | Image scaling: `cover` (fills screen) or `contain` (entire image) | `contain` |
| `PORT` | Port to run the viewer on | `3000` |
| `DEBUG` | Set to `true` to view proxy logs (warning: may expose API key in logs) | `false` |

## Usage Guide

### Legacy Devices (iPad Mini / iPad 2)

1.  **Connect:** Open Safari and go to your viewer URL (e.g., `http://192.168.1.50:3000`).
2.  **Add to Home (Critical):** Tap the **Share** button (Square with up arrow) -> **Add to Home Screen**.
3.  **Launch:** Open the new "Immich Frame" icon from your home screen.
    *   *This triggers strict full-screen mode, hiding the browser UI.*
4.  **Prevent Sleep:**
    *   Tap the screen to show controls.
    *   Tap **Prevent Sleep**.
    *   Wait for it to turn **Green ("NoSleep: ON")**.
    *   *Note: On very old iOS, this plays a hidden silent video to keep the screen alive.*

### Manual Navigation ⬅️➡️

You can manually browse photos at any time. The auto-advance timer will reset after you interact.

- **Touch:** Swipe Left (Next) or Swipe Right (Previous).
- **Keyboard:** Use Left/Right arrow keys.

### Troubleshooting

- **Redirection to HTTPS / Page Won't Load:**
    - If you previously accessed the server via HTTPS, your browser might remember "HSTS" settings.
    - **Fix:** Clear your browser cache/history for the site, or try an Incognito/Private window.

- **"Connecting..." Stuck Forever:**
    - Check `IMMICH_URL` connectivity from the server.
    - Check `IMMICH_API_KEY` permissions.

- **Button says "Err: AbortError":**
    - This is normal if you toggle "Prevent Sleep" off quickly. It means the video start was cancelled.
