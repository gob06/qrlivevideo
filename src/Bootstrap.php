<?php
declare(strict_types=1);

namespace App;

class Bootstrap
{
    public static array $env = [];
    public static array $config = [];

    public static function init(): void
    {
        $root = dirname(__DIR__);
        self::loadEnv($root . '/.env');
        self::$config = require $root . '/config/app.php';

        $debug = self::env('APP_DEBUG', 'false') === 'true';
        ini_set('display_errors', $debug ? '1' : '0');
        error_reporting($debug ? E_ALL : (E_ALL & ~E_DEPRECATED & ~E_NOTICE));
        date_default_timezone_set('UTC');

        spl_autoload_register(static function (string $class): void {
            if (!str_starts_with($class, 'App\\')) {
                return;
            }
            $rel = str_replace('\\', '/', substr($class, 4));
            $path = dirname(__DIR__) . '/src/' . $rel . '.php';
            if (is_file($path)) {
                require_once $path;
            }
        });
    }

    public static function loadEnv(string $path): void
    {
        if (!is_file($path)) {
            return;
        }
        $lines = file($path, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES);
        if (!$lines) {
            return;
        }
        foreach ($lines as $line) {
            $trimmed = trim($line);
            if ($trimmed === '' || str_starts_with($trimmed, '#')) {
                continue;
            }
            $pos = strpos($trimmed, '=');
            if ($pos === false) {
                continue;
            }
            $key = trim(substr($trimmed, 0, $pos));
            $val = trim(substr($trimmed, $pos + 1));
            if (
                (str_starts_with($val, '"') && str_ends_with($val, '"')) ||
                (str_starts_with($val, "'") && str_ends_with($val, "'"))
            ) {
                $val = substr($val, 1, -1);
            }
            self::$env[$key] = $val;
        }
    }

    public static function env(string $key, string $default = ''): string
    {
        if (array_key_exists($key, self::$env)) {
            return self::$env[$key];
        }
        $v = getenv($key);
        return $v !== false ? (string)$v : $default;
    }

    public static function rootPath(string $sub = ''): string
    {
        $base = dirname(__DIR__);
        return $sub === '' ? $base : $base . '/' . ltrim($sub, '/');
    }

    public static function assetVersion(): string
    {
        static $ver = null;
        if ($ver !== null) {
            return $ver;
        }
        $latest = 0;
        $files = array_merge(
            glob(self::rootPath('public/assets/js/*.js')) ?: [],
            glob(self::rootPath('public/assets/css/*.css')) ?: []
        );
        foreach ($files as $f) {
            $mt = @filemtime($f);
            if ($mt && $mt > $latest) {
                $latest = $mt;
            }
        }
        $ver = self::env('APP_VERSION', '1.0.0') . ($latest ? '.' . $latest : '');
        return $ver;
    }

    public static function sendSecurityHeaders(bool $allowIframeSameOrigin = true): void
    {
        header('X-Content-Type-Options: nosniff');
        header('Referrer-Policy: strict-origin-when-cross-origin');
        header('Permissions-Policy: camera=(self), microphone=(self)');
        if ($allowIframeSameOrigin) {
            header('X-Frame-Options: SAMEORIGIN');
        }
        $csp = implode('; ', [
            "default-src 'self'",
            "script-src 'self'",
            "style-src 'self' 'unsafe-inline'",
            "img-src 'self' data: blob:",
            "media-src 'self' blob:",
            "connect-src 'self'",
            "frame-src 'self'",
            "frame-ancestors 'self'",
            "object-src 'none'",
            "base-uri 'self'",
        ]);
        header('Content-Security-Policy: ' . $csp);
    }

    public static function isHttps(): bool
    {
        if (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off') {
            return true;
        }
        if ((int)($_SERVER['SERVER_PORT'] ?? 80) === 443) {
            return true;
        }
        if (self::env('TRUST_PROXY_HEADERS', 'false') === 'true') {
            $proto = strtolower((string)($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? ''));
            if ($proto === 'https') {
                return true;
            }
        }
        return false;
    }

    public static function clientIp(): string
    {
        if (self::env('TRUST_PROXY_HEADERS', 'false') === 'true' && !empty($_SERVER['HTTP_X_FORWARDED_FOR'])) {
            $parts = explode(',', (string)$_SERVER['HTTP_X_FORWARDED_FOR']);
            return trim($parts[0]);
        }
        return (string)($_SERVER['REMOTE_ADDR'] ?? '0.0.0.0');
    }

    public static function ipHash(): string
    {
        $secret = self::env('APP_SECRET', 'default_dev_secret_change_me');
        return hash_hmac('sha256', self::clientIp(), $secret);
    }

    public static function baseUrl(): string
    {
        $configured = rtrim(self::env('APP_URL', ''), '/');
        if ($configured !== '' && !str_contains($configured, 'example.com')) {
            return $configured;
        }
        $scheme = self::isHttps() ? 'https' : 'http';
        $host = $_SERVER['HTTP_HOST'] ?? 'localhost:8000';
        return $scheme . '://' . $host;
    }

    public static function isValidIceUrl(string $url): bool
    {
        return (bool)preg_match('/^(stuns?|turns?):[a-z0-9.\[\]-]+(:\d+)?(\?[^\s]*)?$/i', trim($url));
    }

    public static function isPlaceholderSecret(string $val): bool
    {
        $s = trim($val);
        return $s === '' || (bool)preg_match('/not yet|placeholder|replace_with|your_|change_me|^x{3,}$|^y{3,}$/i', $s);
    }

    public static function readTurnOverride(): ?array
    {
        static $cached = null;
        static $loaded = false;
        if ($loaded) {
            return $cached;
        }
        $loaded = true;
        try {
            $row = Database::fetchOne("SELECT setting_value FROM system_settings WHERE setting_key = 'turn_config'");
            if ($row && !empty($row['setting_value'])) {
                $parsed = json_decode((string)$row['setting_value'], true);
                if (is_array($parsed) && in_array($parsed['mode'] ?? '', ['cloudflare', 'static'], true)) {
                    $cached = $parsed;
                    return $cached;
                }
            }
        } catch (\Throwable $e) {
            // DB may not exist yet (e.g. installer)
        }
        return null;
    }

    public static function clearTurnCache(): void
    {
        @unlink(self::rootPath('storage/cf_turn_cache.json'));
    }

    public static function effectiveCloudflareConfig(): ?array
    {
        $override = self::readTurnOverride();
        if ($override !== null) {
            if (($override['mode'] ?? '') !== 'cloudflare') {
                return null;
            }
            $keyId = trim((string)($override['cf_key_id'] ?? ''));
            $token = trim((string)($override['cf_api_token'] ?? ''));
            if (self::isPlaceholderSecret($keyId) || self::isPlaceholderSecret($token)) {
                return null;
            }
            $ttl = max(60, min(86400, (int)($override['cf_ttl'] ?? 86400)));
            return ['key_id' => $keyId, 'api_token' => $token, 'ttl' => $ttl, 'source' => 'db'];
        }
        $keyId = trim(self::env('CLOUDFLARE_TURN_KEY_ID', ''));
        $token = trim(self::env('CLOUDFLARE_TURN_API_TOKEN', ''));
        if (self::isPlaceholderSecret($keyId) || self::isPlaceholderSecret($token)) {
            return null;
        }
        $ttl = max(60, min(86400, (int)self::env('CLOUDFLARE_TURN_TTL', '86400')));
        return ['key_id' => $keyId, 'api_token' => $token, 'ttl' => $ttl, 'source' => 'env'];
    }

    public static function effectiveStaticTurnConfig(): array
    {
        $override = self::readTurnOverride();
        if ($override !== null) {
            if (($override['mode'] ?? '') !== 'static') {
                return ['urls' => [], 'user' => '', 'pass' => '', 'source' => 'none'];
            }
            $turnRaw = trim((string)($override['turn_url'] ?? ''));
            $turnUrls = array_values(array_filter(array_map('trim', explode(',', $turnRaw)), fn($u) => self::isValidIceUrl($u)));
            $user = trim((string)($override['turn_user'] ?? ''));
            $pass = trim((string)($override['turn_pass'] ?? ''));
            if ($turnUrls && !self::isPlaceholderSecret($user) && !self::isPlaceholderSecret($pass)) {
                return ['urls' => $turnUrls, 'user' => $user, 'pass' => $pass, 'source' => 'db'];
            }
            return ['urls' => [], 'user' => '', 'pass' => '', 'source' => 'none'];
        }
        $turnRaw = trim(self::env('TURN_URL', ''));
        $turnUrls = array_values(array_filter(array_map('trim', explode(',', $turnRaw)), fn($u) => self::isValidIceUrl($u)));
        $user = trim(self::env('TURN_USER', ''));
        $pass = trim(self::env('TURN_PASS', ''));
        if ($turnUrls && !self::isPlaceholderSecret($user) && !self::isPlaceholderSecret($pass)) {
            return ['urls' => $turnUrls, 'user' => $user, 'pass' => $pass, 'source' => 'env'];
        }
        return ['urls' => [], 'user' => '', 'pass' => '', 'source' => 'none'];
    }

    public static function requestCloudflareIceServers(string $keyId, string $token, int $ttl = 86400): array
    {
        $ttl = max(60, min(86400, $ttl));
        $url = 'https://rtc.live.cloudflare.com/v1/turn/keys/' . rawurlencode($keyId) . '/credentials/generate-ice-servers';
        $body = json_encode(['ttl' => $ttl]);
        $raw = '';
        $httpCode = 0;
        $transportErr = '';

        if (function_exists('curl_init')) {
            $ch = curl_init($url);
            curl_setopt_array($ch, [
                CURLOPT_POST => true,
                CURLOPT_RETURNTRANSFER => true,
                CURLOPT_TIMEOUT => 5,
                CURLOPT_HTTPHEADER => [
                    'Authorization: Bearer ' . $token,
                    'Content-Type: application/json',
                ],
                CURLOPT_POSTFIELDS => $body,
            ]);
            $res = curl_exec($ch);
            $httpCode = (int)curl_getinfo($ch, CURLINFO_HTTP_CODE);
            if ($res === false) {
                $transportErr = curl_error($ch) ?: 'cURL request failed';
            } else {
                $raw = (string)$res;
            }
            curl_close($ch);
        } else {
            $ctx = stream_context_create([
                'http' => [
                    'method' => 'POST',
                    'header' => "Authorization: Bearer {$token}\r\nContent-Type: application/json\r\n",
                    'content' => $body,
                    'timeout' => 5,
                    'ignore_errors' => true,
                ],
            ]);
            $res = @file_get_contents($url, false, $ctx);
            if (isset($http_response_header) && is_array($http_response_header)) {
                foreach ($http_response_header as $hdr) {
                    if (preg_match('#^HTTP/\S+\s+(\d{3})#i', $hdr, $m)) {
                        $httpCode = (int)$m[1];
                    }
                }
            }
            if (is_string($res)) {
                $raw = $res;
            } else {
                $transportErr = 'HTTP request failed';
            }
        }

        $servers = [];
        if ($httpCode >= 200 && $httpCode < 300 && $raw !== '') {
            $json = json_decode($raw, true);
            $ice = $json['iceServers'] ?? null;
            if (is_array($ice)) {
                $items = array_is_list($ice) ? $ice : [$ice];
                foreach ($items as $item) {
                    if (!is_array($item)) continue;
                    $rawUrls = is_array($item['urls'] ?? null) ? $item['urls'] : [$item['urls'] ?? ''];
                    $urls = array_values(array_filter(array_map('trim', $rawUrls), fn($u) => self::isValidIceUrl((string)$u)));
                    if (!$urls) continue;
                    $entry = ['urls' => is_array($item['urls'] ?? null) ? $urls : $urls[0]];
                    if (!empty($item['username'])) $entry['username'] = (string)$item['username'];
                    if (!empty($item['credential'])) $entry['credential'] = (string)$item['credential'];
                    $servers[] = $entry;
                }
            }
        }

        $err = '';
        if (!$servers) {
            if ($httpCode >= 400) {
                $snippet = trim(substr(preg_replace('/\s+/', ' ', $raw), 0, 140));
                $err = $snippet !== '' ? "HTTP {$httpCode}: {$snippet}" : "HTTP {$httpCode}";
            } elseif ($transportErr !== '') {
                $err = $transportErr;
            } else {
                $err = 'Cloudflare returned no valid ICE servers';
            }
        }

        return [
            'ok' => count($servers) > 0,
            'http_code' => $httpCode,
            'servers' => $servers,
            'error' => $err,
        ];
    }

    private static function fetchCloudflareIceServers(): array
    {
        $cf = self::effectiveCloudflareConfig();
        if ($cf === null) {
            return [];
        }
        $keyId = $cf['key_id'];
        $token = $cf['api_token'];
        $ttl = (int)$cf['ttl'];
        $cachePath = self::rootPath('storage/cf_turn_cache.json');
        $cacheKey = hash('sha256', $keyId . ':' . $token . ':' . $ttl);

        if (is_file($cachePath)) {
            $cached = json_decode((string)@file_get_contents($cachePath), true);
            if (is_array($cached) && ($cached['key'] ?? '') === $cacheKey) {
                if (($cached['expires_at'] ?? 0) > time() && !empty($cached['servers'])) {
                    return $cached['servers'];
                }
                if (($cached['fail_until'] ?? 0) > time()) {
                    return $cached['servers'] ?? [];
                }
            }
        }

        $res = self::requestCloudflareIceServers($keyId, $token, $ttl);
        $servers = $res['servers'];
        $httpCode = (int)$res['http_code'];
        $isClientErr = $httpCode >= 400 && $httpCode < 500;
        $payload = [
            'key' => $cacheKey,
            'servers' => $servers ?: ($cached['servers'] ?? []),
            'expires_at' => $servers ? time() + min(43200, max(30, (int)($ttl * 0.5))) : 0,
            'fail_until' => $servers ? 0 : time() + ($isClientErr ? 300 : 30),
            'last_error' => $servers ? '' : (string)$res['error'],
        ];
        @file_put_contents($cachePath, json_encode($payload));
        return $payload['servers'];
    }

    public static function iceServersConfig(): array
    {
        $cfServers = self::fetchCloudflareIceServers();
        if ($cfServers) {
            return $cfServers;
        }
        $servers = [];
        $defaultStun = ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'];
        $stunRaw = self::env('STUN_URLS', implode(',', $defaultStun));
        $stunUrls = array_values(array_filter(array_map('trim', explode(',', $stunRaw)), fn($u) => self::isValidIceUrl($u)));
        $servers[] = ['urls' => $stunUrls ?: $defaultStun];
        $turnCfg = self::effectiveStaticTurnConfig();
        if (!empty($turnCfg['urls'])) {
            $servers[] = [
                'urls' => count($turnCfg['urls']) === 1 ? $turnCfg['urls'][0] : $turnCfg['urls'],
                'username' => $turnCfg['user'],
                'credential' => $turnCfg['pass'],
            ];
        }
        return $servers;
    }

    public static function turnError(): string
    {
        $cf = self::effectiveCloudflareConfig();
        if ($cf === null) {
            return '';
        }
        $cachePath = self::rootPath('storage/cf_turn_cache.json');
        $cacheKey = hash('sha256', $cf['key_id'] . ':' . $cf['api_token'] . ':' . $cf['ttl']);
        if (is_file($cachePath)) {
            $cached = json_decode((string)@file_get_contents($cachePath), true);
            if (is_array($cached) && ($cached['key'] ?? '') === $cacheKey && empty($cached['servers']) && !empty($cached['last_error'])) {
                return (string)$cached['last_error'];
            }
        }
        return '';
    }

    public static function turnConfigured(): bool
    {
        $staticCfg = self::effectiveStaticTurnConfig();
        if (!empty($staticCfg['urls'])) {
            return true;
        }
        if (self::effectiveCloudflareConfig() !== null) {
            return self::turnError() === '';
        }
        return false;
    }
}

function e(?string $str): string
{
    return htmlspecialchars((string)$str, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8');
}

function jsonResponse(array $data, int $status = 200): void
{
    http_response_code($status);
    header('Content-Type: application/json; charset=utf-8');
    header('Cache-Control: no-store, no-cache, must-revalidate');
    echo json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}

function jsonInput(): array
{
    $raw = file_get_contents('php://input');
    if ($raw === false || trim($raw) === '') {
        return [];
    }
    $decoded = json_decode($raw, true);
    return is_array($decoded) ? $decoded : [];
}

function utcNow(int $offsetSeconds = 0): string
{
    return gmdate('Y-m-d H:i:s', time() + $offsetSeconds);
}
