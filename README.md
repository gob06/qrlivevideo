# QR Live Wall

**QR Live Wall** is a production-ready live event camera wall designed for **PHP 8.1+ shared web hosting (z.com)** with **MariaDB** (and **SQLite** for zero-setup local testing). Audience members scan a branded QR code on the venue LED wall, open `/join/{event-slug}` on iOS Safari or Android Chrome, and become live WebRTC video sources controlled by hosts and moderators and rendered inside **OBS Studio** at **1920×1080**.

---

## Defaults Used

- **Signaling mode**: `SIGNALING_MODE=poll` (HTTP short polling at `700ms` during WebRTC negotiation and `2000ms` when idle). Setting `SIGNALING_MODE=auto` probes Server-Sent Events (`/api/*/stream`) first and falls back to polling automatically if the host buffers or kills long-lived PHP connections.
- **Database driver**: `DB_DRIVER=sqlite` (`storage/local.sqlite`) for local development; `DB_DRIVER=mysql` for MariaDB on z.com.
- **Image Bank quota**: `IMAGE_BANK_QUOTA_MB=200`.
- **QR defaults**: Error Correction Level `H` whenever a logo is attached, logo scale `18%` (clamped `10%–22%`), padding `8px`, white background, minimum 4-module quiet zone, minimum `4.5:1` dark-on-light module contrast.
- **Wall defaults**: Transparent background (`?bg=transparent`), `1920×1080` viewport-relative grid (`single`, `split2`, `grid4`, `pip`), audio muted until enabled by host or `?audio=on`.
- **Cron-less cleanup**: Probabilistic garbage collection (~8% of API requests) purges consumed/stale WebRTC signals, expired sessions, old stats, and timed-out participants (>30s without heartbeat). An optional `cron_cleanup.php` script is also included.

---

## Folder Structure

```text
qr-live-wall/
├── .env.example
├── .htaccess               # Protects internal folders & routes to public/ if docroot is project root
├── router.php              # Local PHP dev server router
├── install.php             # One-time DB migration + Super Admin seeder (locks via storage/install.lock)
├── cron_cleanup.php        # Optional CLI cleanup script
├── schema.sqlite.sql
├── schema.mariadb.sql
├── config/app.php
├── src/
│   ├── Bootstrap.php
│   ├── Database.php
│   ├── Auth.php
│   ├── RateLimiter.php
│   ├── Validator.php
│   ├── ImageBank.php
│   ├── Cleanup.php
│   ├── Audit.php
│   └── Controllers/
│       ├── PageController.php
│       ├── AudienceApiController.php
│       ├── WallApiController.php
│       └── AdminApiController.php
├── views/
│   ├── audience.php
│   ├── wall.php
│   ├── admin_login.php
│   ├── admin_change_password.php
│   ├── admin_app.php
│   └── print_qr.php
├── storage/
│   ├── .htaccess
│   └── logs/.gitkeep
└── public/
    ├── .htaccess
    ├── index.php
    ├── uploads/logos/.htaccess
    └── assets/
        ├── css/{common,audience,wall,admin}.css
        └── js/{qr-engine,qr-brand,webrtc-common,audience,wall,admin,print-qr}.js
```

---

## 1. Local Development Setup (Node.js Preview & PHP SQLite)

### Option A: Live Preview in Node.js (AI Studio / Express + SQLite)
For immediate live testing on port `3000` using Node.js 22+ (`node:sqlite` + Express, no PHP server needed):
```bash
npm install
npm run dev
```
This boots `server.ts`, initializes the SQLite database (`DB_SQLITE_PATH`, default `storage/local.sqlite`), seeds the Super Admin (`SEED_ADMIN_USER` / `SEED_ADMIN_PASS`) plus a starter `demo` event (`Live Stage Demo`), and serves the launchpad at `http://localhost:3000/`.

### Option B: Local PHP 8.1+ Server (SQLite)
Requirements: **PHP 8.1+** with `pdo_sqlite`, `fileinfo`, `dom`, and optionally `gd` (for raster downscaling/EXIF stripping).

1. Copy `.env.example` to `.env` and adjust `APP_SECRET` and `SEED_ADMIN_PASS`:
   ```bash
   cp .env.example .env
   ```
2. Run the one-time installer to create `storage/local.sqlite` and seed the Super Admin:
   ```bash
   php install.php
   ```
3. Start the built-in PHP server:
   ```bash
   php -S localhost:8000 -t public router.php
   ```
4. Open `http://localhost:8000/admin` and sign in with `SEED_ADMIN_USER` / `SEED_ADMIN_PASS`.

### Testing Phone Cameras Locally (HTTPS Required)
Mobile browsers (`getUserMedia`) require **HTTPS** on non-localhost origins. Use an HTTPS tunnel during local testing:
- **Cloudflare Tunnel**: `cloudflared tunnel --url http://localhost:8000`
- **ngrok**: `ngrok http 8000`
Set `APP_URL=https://your-tunnel-url` and `TRUST_PROXY_HEADERS=true` in `.env` so generated QR codes point to the HTTPS tunnel URL.

---

## 2. Deployment to z.com Shared Hosting

### Recommended Directory Layout
- **Option A (Best — if z.com allows pointing your domain's document root to `public/`)**:
  1. Upload the entire project to `/home/<user>/qr-live-wall/`.
  2. Set the domain Document Root to `/home/<user>/qr-live-wall/public`.
  3. `.env`, `storage/`, `src/`, `views/`, and `schema.*.sql` remain completely outside the web root.
- **Option B (Standard `public_html` root)**:
  1. Upload the project contents into `public_html/`.
  2. The root `.htaccess` automatically blocks direct HTTP access to `.env`, `*.sql`, `*.sqlite`, `src/`, `config/`, `views/`, and `storage/`, and internally rewrites requests to `public/`.
  3. Confirm via browser that `https://yourdomain.com/.env` returns **403 Forbidden** after upload.

### Step-by-Step Setup on z.com
1. **Create MariaDB Database**: In the z.com control panel, create a new database, user, and strong password.
2. **Configure `.env`**:
   ```ini
   APP_URL=https://wall.yourdomain.com
   DB_DRIVER=mysql
   DB_HOST=localhost
   DB_PORT=3306
   DB_NAME=your_db_name
   DB_USER=your_db_user
   DB_PASS=your_db_password
   APP_SECRET=<64-hex-random-string>
   SIGNALING_MODE=poll
   ```
3. **Enable SSL & Force HTTPS**: Enable the free SSL certificate (Let's Encrypt / AutoSSL) in z.com and enforce HTTPS redirection so camera/microphone permissions work on iOS and Android.
4. **PHP Version & Extensions**: Select **PHP 8.1, 8.2, or 8.3** in the PHP Selector. Enable extensions:
   - Required: `pdo`, `pdo_mysql`, `fileinfo`, `dom`, `mbstring`, `openssl`
   - Recommended: `gd` (downscales uploaded logos to 512×512 PNG and strips EXIF metadata)
   - Local testing only: `pdo_sqlite`
5. **Run `install.php` Once & Delete It**:
   - Visit `https://wall.yourdomain.com/install.php` (temporarily place/route it if using Option A, or run `php install.php` via SSH if available) and click **Run Installation & Lock**.
   - Verify `storage/install.lock` was created, then **delete `install.php`** from the server.
6. **File Permissions**: Ensure `storage/` and `public/uploads/logos/` are writable by PHP (`0755` or `0750`).

### Shared-Hosting Troubleshooting
- **404 on `/join/...` or `/admin/...`**: Ensure `mod_rewrite` is active and `AllowOverride All` is permitted for `.htaccess`. Check `public/.htaccess`.
- **SSE buffering / stalls**: Shared hosting reverse proxies (Nginx/Apache `mod_fcgid`) buffer chunked output and limit concurrent PHP-FPM workers. Keep `SIGNALING_MODE=poll` (default) so every request finishes in milliseconds without tying up PHP workers.
- **Request limits / PHP timeouts**: Polling endpoints only execute fast indexed SQL queries and never block. If your host enforces aggressive anti-bot rate limits, keep `admin_poll_ms` at `1500`–`2000` and avoid opening dozens of simultaneous admin tabs.

---

## 3. OBS Studio Setup Guide (LED Wall Output)

1. **Canvas Resolution**: In OBS **Settings → Video**, set both **Base (Canvas) Resolution** and **Output (Scaled) Resolution** to **`1920x1080`**, Common FPS Values **`30`** (or `60`).
2. **Add Browser Source (1920×1080 Exact 1:1)**:
   - Copy the **OBS Wall URL** from the Admin Event Studio (`/wall/{slug}?key=WALLKEY`).
   - Optional URL parameters:
     - `?bg=transparent` (default), `?bg=black`, or `?bg=green`
     - `?audio=on` or `?audio=off` (overrides admin audio toggle)
     - `?qr=auto` (default: full QR when idle, hidden when live), `?qr=corner` (small QR in top-right while live), `?qr=off`
     - `?framecheck=1` (overlays frame corner markers and resolution/crop telemetry on every live tile for setup testing)
   - Width: **`1920`**, Height: **`1080`**.
   - **Transform & Scaling (Important to prevent zooming/cropping)**:
     - Right-click the Browser Source in OBS → **Transform → Reset Transform** (or **Edit Transform...**), verify **Position** is `0, 0`, **Crop** is `0` on all sides, and **Bounding Box Type** is `No bounds` (or run **Transform → Fit to screen**), keeping source scale at **100%**.
     - The wall page performs **zero** `devicePixelRatio`, `zoom`, or `transform: scale(...)` tricks — pixel dimensions match `1920×1080` 1:1.
   - Check **"Control audio via OBS"** if you plan to route audience audio to the PA/stream; keep the OBS Browser Source muted in the Audio Mixer during silent QR/video walls to prevent feedback.
   - **Uncheck** *"Shutdown source when not visible"* so the WebRTC connections and heartbeat stay warm when switching OBS scenes.
   - *"Refresh browser when scene becomes active"*: Leave unchecked during live shows to avoid dropping active WebRTC streams.
3. **Fit Mode & Tile Background**:
   - Wall tiles default to **Fit (no crop)** (`object-fit: contain`) with **Blurred video fill** (`wall_tile_bg=blur`), so portrait or 4:3 phones never get zoomed in or clipped. Hosts can adjust **Fit Mode** (`Fit`, `Fill`, or `Stretch` under Advanced) and **Tile Background** (`Blurred`, `Solid`, `Transparent`) globally in Studio Settings or per slot, plus **"Mirror front cameras on the wall"** (default off).
4. **Custom CSS Tip**: Leave OBS Custom CSS empty for default transparency (`?bg=transparent`), or use OBS scenes behind the Browser Source.
5. **Outputting to the Venue LED Wall**:
   - Connect the venue LED processor (Novastar / Brompton / Colorlight) via HDMI/DP as an extended display (`1920×1080`).
   - Right-click the OBS Program Preview → **Fullscreen Projector (Preview)** → select the LED wall display.
6. **Recommended Machine Specs & Network Advice**:
   - **OBS Machine**: Quad-core CPU or better (e.g., Apple M1+ or Intel i5/i7 11th gen+), 16 GB RAM, hardware video decode enabled, **wired Gigabit Ethernet** (never run the OBS wall PC on venue Wi-Fi).
   - **4 Simultaneous Feeds**: ~8 Mbps total downstream at OBS (~2 Mbps target per phone with resolution preservation).
   - **Network Backup Plan**: Always keep a fallback local media source (looping brand graphic / static high-res QR PNG exported from Admin) in an OBS scene directly underneath or one hotkey away in case venue internet drops.

---

## 4. TURN Server Setup (Strongly Recommended for Venues)

Peer-to-peer WebRTC uses STUN by default, which works on open Wi-Fi/home routers but **frequently fails on cellular 4G/5G (carrier-grade NAT) or corporate/venue Wi-Fi with symmetric NAT or UDP restrictions**.

### Option A: Cloudflare Realtime TURN (Recommended)
1. In the **Cloudflare Dashboard**, open **Realtime → TURN** and create a **TURN Key**.
2. Copy the **TURN Key ID** and **API Token** into your `.env` or AI Studio Secrets:
   ```ini
   CLOUDFLARE_TURN_KEY_ID="your_cloudflare_turn_key_id"
   CLOUDFLARE_TURN_API_TOKEN="your_cloudflare_turn_api_token"
   ```
3. The server automatically calls Cloudflare's `generate-ice-servers` API with an in-memory/file cache so your API token stays private on the server while mobile phones and OBS receive fresh STUN/TURN/TURNS (`443/TCP`) credentials.

### Option B: Static TURN Credentials (`coturn` / Metered / Twilio)
Configure static `TURN_URL` (comma-separated URLs supported) in `.env`:
```ini
TURN_URL="turn:turn.yourdomain.com:3478?transport=tcp,turns:turn.yourdomain.com:443?transport=tcp"
TURN_USER="qrlivewall"
TURN_PASS="strong_turn_secret"
```

The Admin Monitor Dashboard automatically alerts you if neither Cloudflare TURN nor `TURN_URL` is configured, and shows `DIRECT` vs `TURN` per live participant feed.

---

## 5. End-to-End Test Checklist

1. **Accounts & RBAC**:
   - Sign in as Super Admin; create one `host` account (`all` events) and one `moderator` account (`assigned` events only).
   - Verify forced password change on first login and password strength validation.
   - As `moderator`, verify UI hides event settings, Image Bank upload/delete, Accounts, and Audit Log — and verify direct API requests (`POST /api/admin/events`, `POST /api/admin/events/{id}/settings`, `GET /api/admin/accounts`, `GET /api/admin/audit`, unassigned event state) return **403 Forbidden**.
   - Test "Revoke Sessions" and "Log out everywhere".
2. **Multi-Admin Concurrency**:
   - Open the same event in two different admin browsers. Verify both names appear in "Online here".
   - Change layout or slot from Admin A; confirm Admin B updates within 2 seconds and displays the `"Updated by ..."` notice.
3. **Image Bank & QR Safety**:
   - Multi-upload PNG, JPG, and sanitized SVG logos; verify duplicate SHA-256 detection reuses the existing record.
   - Reject a non-image (`.txt`/`.php` renamed to `.png`), an oversized (>2 MB) file, and an SVG containing `<script>` or `onload=` (verify `<script>` is stripped).
   - Set a default logo, create a new event, and confirm it auto-applies.
   - Attempt to delete an in-use logo; verify the warning lists affected events and test **"Replace Everywhere"**.
   - Test storage quota warning (>=85%) and rejection when full.
   - Test QR low-contrast rejection (<4.5:1 or light-on-dark), oversized logo warning, and click **Test Scan** to verify green **Scannable** vs red **Not scannable** detection.
   - Scan the rendered QR on both **iPhone (iOS Camera/Safari)** and **Android (Camera/Chrome)** from venue viewing distance.
4. **Audience Join & Lobby**:
   - Join from 2+ phones over HTTPS; verify in-app browser warning appears if opened inside Instagram/Line/etc.
   - Verify camera preview, mic toggle, front/back camera flip, wake lock, and 3-second lobby thumbnails appearing in Admin.
5. **Monitor Dashboard & Private Preview**:
   - Open `/admin/events/{id}/monitor`; verify embedded scaled 1920×1080 wall view, counters, and OBS heartbeat status.
   - Close OBS wall tab for >10 seconds and confirm **OBS Offline** red alert triggers.
   - Click **Preview** on a waiting candidate; verify private WebRTC video + audio meter work in admin before air, then click **Take to Wall**.
   - Toggle **Listen** on an on-air feed and verify audio meter & monitoring in admin without leaking to OBS when wall audio is off.
6. **Wall Layouts, Moderation & Recovery**:
   - Put 2–4 phones on air; test `single`, `split2`, `grid4`, `pip` layouts, drag-and-drop slot swapping, keyboard shortcuts (`1`-`4`, `C`, `B`), labels toggle, and blackout.
   - Kick one phone (verify "Removed" screen + immediate wall removal); ban another phone (verify re-join blocked until unbanned).
   - Toggle airplane mode briefly on a phone and verify automatic reconnect.
   - Close the event and verify audience sessions end and thumbnails are wiped.
7. **OBS Browser Source Verification**:
   - Load `/wall/{slug}?key=WALLKEY` in OBS at `1920×1080`, verify **Transform → Reset Transform** (`100%` scale, zero crop), transparent background over an OBS backdrop, zero scrollbars, and smooth transitions.
8. **Real-Camera Full-Frame & Zero-Crop Checklist**:
   - Open **Frame Check** (`/admin/frame-check`) in Admin and enable **Frame check** on a joined phone to compare captured dimensions, aspect ratio, zoom (`1x` / min), tile size, and `Visible 100%` telemetry.
   - **Printed Ruler / Framing Chart Test**: Point the phone camera at a printed grid/ruler or wall frame edges, compare side-by-side against the phone's built-in 1x Camera app, and verify all 4 outer markers remain equally visible on: (a) the audience phone preview, (b) Admin Private Preview & Monitor, and (c) the OBS Wall (`/wall/...?framecheck=1`).
   - **iOS Safari**: Test front & rear cameras in portrait and landscape; rotate mid-stream and confirm no stretching or manual cropping.
   - **Android Chrome**: Test front & rear cameras (including switching rear lenses via the Camera `<select>` dropdown); confirm main 1x lens is selected by default and zoom slider starts at minimum wide value when supported.
   - **Mirror Check**: Hold up readable printed text to the front camera — local phone preview mirrors like a selfie mirror, while Admin Monitor & OBS Wall show readable unmirrored text unless **"Mirror front cameras on the wall"** is enabled.
   - **Multi-Tile Layouts**: Put 2 phones on air in `split2` and 4 in `grid4`; mix portrait and landscape phones and verify Fit (blurred fill) shows 100% of every frame, switching cleanly to Fill (crops) or per-slot override on demand.

---

## 6. Known Limitations & Browser Camera Notes

- **Mobile Browser Field-of-View vs Native Camera App**: On some iOS and Android devices, Safari/Chrome WebRTC `getUserMedia` uses a binned or stabilized video sensor mode (typically 16:9 `1280×720` or 4:3) whose maximum angle of view can be slightly narrower than the device's native OEM Camera photo mode, and browsers on iOS may not expose hardware ultra-wide lenses or `MediaTrackCapabilities.zoom` to web pages. Requesting ideal constraints without forcing mismatched `aspectRatio` or `exact` dimensions ensures the widest uncropped WebRTC sensor mode the browser allows.
- **P2P Topology Limit (~4 simultaneous on-air feeds)**: Because each on-air phone sends a direct WebRTC peer connection to the OBS Browser Source (and optionally an admin monitor/preview), CPU and uplink bandwidth scale linearly on the OBS machine and phones. Keep `max_wall_feeds <= 4`.
- **Polling Overhead at High Lobby Counts**: Shared hosting HTTP polling every 2 seconds per idle phone works comfortably up to ~50–150 waiting participants depending on PHP-FPM worker limits.
- **When to Move to an SFU**: If you need **more than 4 simultaneous feeds on screen**, **hundreds of simultaneous waiting/streaming participants**, or **server-side compositing/recording**, migrate the WebRTC transport to an SFU such as **LiveKit** or **Janus** running on dedicated cloud/VPS infrastructure.
