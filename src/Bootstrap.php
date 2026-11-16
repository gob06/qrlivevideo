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

    private static function isValidIceUrl(string $url): bool
    {
        return (bool)preg_match('/^(stuns?|turns?):[a-z0-9.\[\]-]+(:\d+)?(\?[^\s]*)?$/i', trim($url));
    }

    private static function fetchCloudflareIceServers(): array
    {
        $keyId = trim(self::env('CLOUDFLARE_TURN_KEY_ID', ''));
        $token = trim(self::env('CLOUDFLARE_TURN_API_TOKEN', ''));
        if ($keyId === '' || $token === '' || preg_match('/not yet|placeholder|replace_with/i', $keyId . ' ' . $token)) {
            return [];
        }
        $ttl = max(60, min(86400, (int)self::env('CLOUDFLARE_TURN_TTL', '86400')));
        $cachePath = ROOT_PATH . '/storage/cf_turn_cache.json';
        $cacheKey = hash('sha256', $keyId . ':' . $ttl);

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

        $url = 'https://rtc.live.cloudflare.com/v1/turn/keys/' . rawurlencode($keyId) . '/credentials/generate-ice-servers';
        $body = json_encode(['ttl' => $ttl]);
        $raw = false;
        if (function_exists('curl_init')) {
            $ch = curl_init($url);
            curl_setopt_array($ch, [
                CURLOPT_POST => true,
                CURLOPT_RETURNTRANSFER => true,
                CURLOPT_TIMEOUT => 4,
                CURLOPT_HTTPHEADER => [
                    'Authorization: Bearer ' . $token,
                    'Content-Type: application/json',
                ],
                CURLOPT_POSTFIELDS => $body,
            ]);
            $res = curl_exec($ch);
            $code = (int)curl_getinfo($ch, CURLINFO_HTTP_CODE);
            curl_close($ch);
            if ($code >= 200 && $code < 300 && is_string($res)) {
                $raw = $res;
            }
        } else {
            $ctx = stream_context_create([
                'http' => [
                    'method' => 'POST',
                    'header' => "Authorization: Bearer {$token}\r\nContent-Type: application/json\r\n",
                    'content' => $body,
                    'timeout' => 4,
                    'ignore_errors' => true,
                ],
            ]);
            $res = @file_get_contents($url, false, $ctx);
            if (is_string($res)) {
                $raw = $res;
            }
        }

        $servers = [];
        if (is_string($raw)) {
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

        $payload = [
            'key' => $cacheKey,
            'servers' => $servers ?: ($cached['servers'] ?? []),
            'expires_at' => $servers ? time() + min(43200, max(30, (int)($ttl * 0.5))) : 0,
            'fail_until' => $servers ? 0 : time() + 30,
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
        $turnRaw = trim(self::env('TURN_URL', ''));
        $turnUrls = array_values(array_filter(array_map('trim', explode(',', $turnRaw)), fn($u) => self::isValidIceUrl($u)));
        if ($turnUrls) {
            $entry = ['urls' => count($turnUrls) === 1 ? $turnUrls[0] : $turnUrls];
            $user = self::env('TURN_USER', '');
            $pass = self::env('TURN_PASS', '');
            if ($user !== '') {
                $entry['username'] = $user;
            }
            if ($pass !== '') {
                $entry['credential'] = $pass;
            }
            $servers[] = $entry;
        }
        return $servers;
    }

    public static function turnConfigured(): bool
    {
        $keyId = trim(self::env('CLOUDFLARE_TURN_KEY_ID', ''));
        $token = trim(self::env('CLOUDFLARE_TURN_API_TOKEN', ''));
        if ($keyId !== '' && $token !== '' && !preg_match('/not yet|placeholder|replace_with/i', $keyId . ' ' . $token)) {
            return true;
        }
        $turnUrls = array_filter(array_map('trim', explode(',', self::env('TURN_URL', ''))), fn($u) => self::isValidIceUrl($u));
        return count($turnUrls) > 0;
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
