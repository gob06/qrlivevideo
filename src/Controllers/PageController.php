<?php
declare(strict_types=1);

namespace App\Controllers;

use App\Audit;
use App\Auth;
use App\Bootstrap;
use App\Database;
use App\ImageBank;
use App\RateLimiter;
use App\Validator;

class PageController
{
    public static function renderAudience(string $slug): void
    {
        $event = Database::fetchOne('SELECT id, slug, title, status, join_locked FROM events WHERE slug = ?', [$slug]);
        if ($event === null) {
            http_response_code(404);
            echo '<!doctype html><html><body style="background:#0a0d14;color:#f8fafc;font-family:sans-serif;padding:2rem;"><h1>Event not found</h1><p>Check the QR code or link and try again.</p></body></html>';
            return;
        }
        $config = [
            'eventSlug' => $event['slug'],
            'eventTitle' => $event['title'],
            'eventStatus' => $event['status'],
            'joinLocked' => (int)$event['join_locked'] === 1,
            'signalingMode' => Bootstrap::env('SIGNALING_MODE', 'poll'),
            'iceServers' => Bootstrap::iceServersConfig(),
            'pollIdleMs' => Bootstrap::$config['poll_interval_idle_ms'],
            'pollFastMs' => Bootstrap::$config['poll_interval_fast_ms'],
            'thumbIntervalMs' => Bootstrap::$config['thumbnail_interval_ms'],
        ];
        require Bootstrap::rootPath('views/audience.php');
    }

    public static function renderWall(string $slug): void
    {
        $key = (string)($_GET['key'] ?? '');
        $event = Database::fetchOne(
            'SELECT e.*, m.filename AS logo_filename
             FROM events e
             LEFT JOIN media_images m ON m.id = e.logo_image_id
             WHERE e.slug = ?',
            [$slug]
        );
        if ($event === null || !hash_equals($event['wall_key'], $key)) {
            http_response_code(403);
            echo '<!doctype html><html><body style="background:#111;color:#fff;font-family:sans-serif;padding:2rem;"><h1>Invalid or missing Wall Key</h1></body></html>';
            return;
        }

        $bgParam = strtolower((string)($_GET['bg'] ?? 'transparent'));
        $bg = in_array($bgParam, ['transparent', 'black', 'green'], true) ? $bgParam : 'transparent';

        $audioParam = strtolower((string)($_GET['audio'] ?? ''));
        $audioOverride = in_array($audioParam, ['on', 'off'], true) ? $audioParam : null;

        $qrParam = strtolower((string)($_GET['qr'] ?? 'auto'));
        $qrMode = in_array($qrParam, ['on', 'off', 'corner', 'auto'], true) ? $qrParam : 'auto';

        $isMonitor = ((string)($_GET['monitor'] ?? '0')) === '1';
        $viewerId = $isMonitor
            ? preg_replace('/[^a-zA-Z0-9_-]/', '', (string)($_GET['mid'] ?? 'mon_' . bin2hex(random_bytes(4))))
            : 'obs';

        $joinUrl = Bootstrap::baseUrl() . '/join/' . rawurlencode($event['slug']);

        $config = [
            'eventSlug' => $event['slug'],
            'eventTitle' => $event['title'],
            'wallKey' => $key,
            'joinUrl' => $joinUrl,
            'bg' => $bg,
            'audioOverride' => $audioOverride,
            'qrMode' => $qrMode,
            'isMonitor' => $isMonitor,
            'viewerId' => $viewerId,
            'signalingMode' => Bootstrap::env('SIGNALING_MODE', 'poll'),
            'iceServers' => Bootstrap::iceServersConfig(),
            'version' => Bootstrap::env('APP_VERSION', '1.0.0'),
            'pollIdleMs' => Bootstrap::$config['poll_interval_idle_ms'],
            'pollFastMs' => Bootstrap::$config['poll_interval_fast_ms'],
        ];
        require Bootstrap::rootPath('views/wall.php');
    }

    public static function showLogin(?string $error = null): void
    {
        if (Auth::current() !== null) {
            header('Location: /admin/events');
            exit;
        }
        $loginError = $error;
        require Bootstrap::rootPath('views/admin_login.php');
    }

    public static function handleLogin(): void
    {
        $ipKey = 'login:' . Bootstrap::ipHash();
        if (!RateLimiter::check($ipKey, 10, 300)) {
            self::showLogin('Too many login attempts. Please wait 5 minutes.');
            return;
        }
        $username = trim((string)($_POST['username'] ?? ''));
        $password = (string)($_POST['password'] ?? '');

        $admin = Database::fetchOne('SELECT * FROM admins WHERE username = ?', [$username]);
        if ($admin === null || !password_verify($password, $admin['password_hash'])) {
            self::showLogin('Invalid username or password.');
            return;
        }
        if ($admin['status'] !== 'active') {
            self::showLogin('This account is disabled. Contact the Super Admin.');
            return;
        }

        Auth::createSession((int)$admin['id']);
        Audit::log(null, (int)$admin['id'], $admin['display_name'], 'admin_login', 'Signed in');

        if ((int)$admin['must_change_password'] === 1) {
            header('Location: /admin/change-password');
            exit;
        }
        header('Location: /admin/events');
        exit;
    }

    public static function handleLogout(): void
    {
        $user = Auth::current();
        if ($user !== null && Auth::verifyFormCsrf($user)) {
            Audit::log(null, (int)$user['id'], $user['display_name'], 'admin_logout', 'Signed out');
            Auth::logoutCurrent();
        }
        header('Location: /admin/login');
        exit;
    }

    public static function showChangePassword(?string $error = null): void
    {
        $user = Auth::requirePageAuth(true);
        $pwError = $error;
        require Bootstrap::rootPath('views/admin_change_password.php');
    }

    public static function handleChangePassword(): void
    {
        $user = Auth::requirePageAuth(true);
        if (!Auth::verifyFormCsrf($user)) {
            self::showChangePassword('Invalid CSRF token. Try again.');
            return;
        }
        $currentPw = (string)($_POST['current_password'] ?? '');
        $newPw = (string)($_POST['new_password'] ?? '');
        $confirmPw = (string)($_POST['confirm_password'] ?? '');

        $admin = Database::fetchOne('SELECT password_hash FROM admins WHERE id = ?', [(int)$user['id']]);
        if ($admin === null || !password_verify($currentPw, $admin['password_hash'])) {
            self::showChangePassword('Current password is incorrect.');
            return;
        }
        if ($newPw !== $confirmPw) {
            self::showChangePassword('New passwords do not match.');
            return;
        }
        $strengthErr = Validator::validatePasswordStrength($newPw);
        if ($strengthErr !== null) {
            self::showChangePassword($strengthErr);
            return;
        }

        Database::execute(
            'UPDATE admins SET password_hash = ?, must_change_password = 0 WHERE id = ?',
            [password_hash($newPw, PASSWORD_DEFAULT), (int)$user['id']]
        );
        Audit::log(null, (int)$user['id'], $user['display_name'], 'password_changed', 'User updated password');
        header('Location: /admin/events');
        exit;
    }

    public static function renderAdminApp(string $initialRoute): void
    {
        $user = Auth::requirePageAuth(false);
        Auth::touchPresence();
        $appConfig = [
            'user' => [
                'id' => (int)$user['id'],
                'username' => $user['username'],
                'display_name' => $user['display_name'],
                'email' => $user['email'],
                'role' => $user['role'],
                'event_scope' => $user['event_scope'],
            ],
            'csrfToken' => $user['csrf_token'],
            'baseUrl' => Bootstrap::baseUrl(),
            'initialRoute' => $initialRoute,
            'turnConfigured' => Bootstrap::turnConfigured(),
            'quotaBytes' => ImageBank::quotaBytes(),
            'iceServers' => Bootstrap::iceServersConfig(),
            'adminPollMs' => Bootstrap::$config['admin_poll_ms'],
        ];
        require Bootstrap::rootPath('views/admin_app.php');
    }

    public static function renderPrintQr(int $eventId): void
    {
        $user = Auth::requirePageAuth(false);
        if (!Auth::canAccessEvent($user, $eventId)) {
            http_response_code(403);
            echo 'Forbidden';
            return;
        }
        $event = Database::fetchOne(
            'SELECT e.*, m.filename AS logo_filename FROM events e LEFT JOIN media_images m ON m.id = e.logo_image_id WHERE e.id = ?',
            [$eventId]
        );
        if ($event === null) {
            http_response_code(404);
            echo 'Event not found';
            return;
        }
        $printConfig = [
            'title' => $event['title'],
            'joinUrl' => Bootstrap::baseUrl() . '/join/' . rawurlencode($event['slug']),
            'logoUrl' => $event['logo_filename'] ? '/uploads/logos/' . rawurlencode($event['logo_filename']) : null,
            'qrLogoShape' => $event['qr_logo_shape'],
            'qrLogoFit' => $event['qr_logo_fit'],
            'qrLogoScale' => (int)$event['qr_logo_scale'],
            'qrLogoPadding' => (int)$event['qr_logo_padding'],
            'qrLogoBg' => $event['qr_logo_bg'],
            'qrFg' => $event['qr_fg'],
            'qrBg' => $event['qr_bg'],
        ];
        require Bootstrap::rootPath('views/print_qr.php');
    }
}
