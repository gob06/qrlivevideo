<?php
declare(strict_types=1);

namespace App;

class Auth
{
    private static ?array $currentSession = null;

    public static function cookieName(): string
    {
        return Bootstrap::env('SESSION_COOKIE_NAME', 'qrlw_session');
    }

    public static function current(): ?array
    {
        if (self::$currentSession !== null) {
            return self::$currentSession;
        }
        $rawToken = $_COOKIE[self::cookieName()] ?? '';
        if (!is_string($rawToken) || strlen($rawToken) < 32) {
            return null;
        }
        $hash = hash('sha256', $rawToken);
        $now = utcNow();
        $row = Database::fetchOne(
            'SELECT s.id AS session_id, s.csrf_token, s.expires_at, s.current_event_id,
                    a.id, a.username, a.display_name, a.email, a.role, a.status,
                    a.event_scope, a.must_change_password, a.last_login
             FROM admin_sessions s
             JOIN admins a ON a.id = s.admin_id
             WHERE s.session_token_hash = ? AND s.revoked = 0 AND s.expires_at > ?',
            [$hash, $now]
        );
        if ($row === null || $row['status'] !== 'active') {
            return null;
        }
        self::$currentSession = $row;
        return $row;
    }

    public static function createSession(int $adminId): string
    {
        $rawToken = bin2hex(random_bytes(32));
        $hash = hash('sha256', $rawToken);
        $csrf = bin2hex(random_bytes(32));
        $hours = max(1, (int)Bootstrap::env('SESSION_LIFETIME_HOURS', '12'));
        $now = utcNow();
        $expires = utcNow($hours * 3600);
        $ua = substr((string)($_SERVER['HTTP_USER_AGENT'] ?? ''), 0, 250);

        Database::execute(
            'INSERT INTO admin_sessions (admin_id, session_token_hash, csrf_token, last_seen, ip_hash, user_agent, revoked, created_at, expires_at)
             VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)',
            [$adminId, $hash, $csrf, $now, Bootstrap::ipHash(), $ua, $now, $expires]
        );

        Database::execute('UPDATE admins SET last_login = ? WHERE id = ?', [$now, $adminId]);

        setcookie(self::cookieName(), $rawToken, [
            'expires' => time() + ($hours * 3600),
            'path' => '/',
            'secure' => Bootstrap::isHttps(),
            'httponly' => true,
            'samesite' => 'Lax',
        ]);

        self::$currentSession = null;
        return $csrf;
    }

    public static function logoutCurrent(): void
    {
        $cur = self::current();
        if ($cur !== null) {
            Database::execute('UPDATE admin_sessions SET revoked = 1 WHERE id = ?', [(int)$cur['session_id']]);
        }
        setcookie(self::cookieName(), '', [
            'expires' => time() - 3600,
            'path' => '/',
            'secure' => Bootstrap::isHttps(),
            'httponly' => true,
            'samesite' => 'Lax',
        ]);
        self::$currentSession = null;
    }

    public static function revokeAllForAdmin(int $adminId): void
    {
        Database::execute('UPDATE admin_sessions SET revoked = 1 WHERE admin_id = ?', [$adminId]);
    }

    public static function touchPresence(?int $eventId = null): void
    {
        $cur = self::current();
        if ($cur === null) {
            return;
        }
        if ($eventId !== null) {
            Database::execute(
                'UPDATE admin_sessions SET last_seen = ?, current_event_id = ? WHERE id = ?',
                [utcNow(), $eventId, (int)$cur['session_id']]
            );
        } else {
            Database::execute(
                'UPDATE admin_sessions SET last_seen = ? WHERE id = ?',
                [utcNow(), (int)$cur['session_id']]
            );
        }
    }

    public static function requirePageAuth(bool $allowForceChangePage = false): array
    {
        $user = self::current();
        if ($user === null) {
            header('Location: /admin/login');
            exit;
        }
        if ((int)$user['must_change_password'] === 1 && !$allowForceChangePage) {
            header('Location: /admin/change-password');
            exit;
        }
        return $user;
    }

    public static function requireApiAuth(array $allowedRoles = ['super_admin', 'host', 'moderator'], bool $verifyCsrf = false): array
    {
        $user = self::current();
        if ($user === null) {
            jsonResponse(['error' => 'Authentication required.'], 401);
        }
        if ((int)$user['must_change_password'] === 1) {
            jsonResponse(['error' => 'Password change required before continuing.'], 403);
        }
        if (!in_array($user['role'], $allowedRoles, true)) {
            jsonResponse(['error' => 'Insufficient permissions for this action.'], 403);
        }
        if ($verifyCsrf) {
            $headerToken = (string)($_SERVER['HTTP_X_CSRF_TOKEN'] ?? '');
            $postToken = (string)($_POST['csrf_token'] ?? '');
            $provided = $headerToken !== '' ? $headerToken : $postToken;
            if (!hash_equals($user['csrf_token'], $provided)) {
                jsonResponse(['error' => 'Invalid CSRF token. Please refresh the page.'], 403);
            }
        }
        return $user;
    }

    public static function verifyFormCsrf(array $user): bool
    {
        $provided = (string)($_POST['csrf_token'] ?? '');
        return $provided !== '' && hash_equals($user['csrf_token'], $provided);
    }

    public static function canAccessEvent(array $user, int $eventId): bool
    {
        if ($user['role'] === 'super_admin' || $user['event_scope'] === 'all') {
            return true;
        }
        $row = Database::fetchOne(
            'SELECT 1 FROM admin_event_access WHERE admin_id = ? AND event_id = ?',
            [(int)$user['id'], $eventId]
        );
        return $row !== null;
    }

    public static function requireEventAccess(array $user, int $eventId): array
    {
        $event = Database::fetchOne('SELECT * FROM events WHERE id = ?', [$eventId]);
        if ($event === null) {
            jsonResponse(['error' => 'Event not found.'], 404);
        }
        if (!self::canAccessEvent($user, $eventId)) {
            jsonResponse(['error' => 'You do not have access to this event.'], 403);
        }
        return $event;
    }
}
