<?php
declare(strict_types=1);

namespace App;

class Audit
{
    public static function log(?int $eventId, ?int $adminId, string $adminName, string $action, string $details = ''): void
    {
        Database::execute(
            'INSERT INTO audit_log (event_id, admin_id, admin_name, action, details, ip_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
            [
                $eventId,
                $adminId,
                $adminName,
                Validator::cleanText($action, 64),
                Validator::cleanText($details, 500),
                Bootstrap::ipHash(),
                utcNow(),
            ]
        );
    }

    public static function timeline(int $eventId, string $kind, string $message): void
    {
        Database::execute(
            'INSERT INTO event_timeline (event_id, kind, message, created_at) VALUES (?, ?, ?, ?)',
            [$eventId, Validator::cleanText($kind, 32), Validator::cleanText($message, 255), utcNow()]
        );
    }
}
