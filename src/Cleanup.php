<?php
declare(strict_types=1);

namespace App;

class Cleanup
{
    public static function maybeRun(): void
    {
        $prob = (int)(Bootstrap::$config['cleanup_probability'] ?? 8);
        if (random_int(1, 100) <= $prob) {
            self::run();
        }
    }

    public static function run(): void
    {
        $now = utcNow();
        $sigCutoff = utcNow(-(int)Bootstrap::$config['signal_ttl_sec']);
        $statCutoff = utcNow(-(int)Bootstrap::$config['stats_ttl_sec']);
        $partCutoff = utcNow(-(int)Bootstrap::$config['participant_stale_sec']);
        $rateCutoff = time() - 3600;

        Database::execute('DELETE FROM signals WHERE consumed = 1 OR created_at < ?', [$sigCutoff]);
        Database::execute('DELETE FROM stream_stats WHERE reported_at < ?', [$statCutoff]);
        Database::execute('DELETE FROM wall_heartbeats WHERE last_seen < ?', [utcNow(-300)]);
        Database::execute('DELETE FROM admin_sessions WHERE expires_at < ? OR (revoked = 1 AND last_seen < ?)', [$now, utcNow(-86400)]);
        Database::execute('DELETE FROM rate_limits WHERE window_start < ?', [$rateCutoff]);

        $staleParts = Database::fetchAll(
            "SELECT id, event_id, display_name, status FROM participants WHERE status IN ('waiting', 'onair') AND last_seen < ?",
            [$partCutoff]
        );
        foreach ($staleParts as $p) {
            Database::execute('DELETE FROM wall_slots WHERE participant_id = ?', [(int)$p['id']]);
            Database::execute(
                "UPDATE participants SET status = 'left', thumbnail_data = NULL, preview_admin_id = NULL WHERE id = ?",
                [(int)$p['id']]
            );
            Audit::timeline((int)$p['event_id'], 'leave', $p['display_name'] . ' timed out');
        }
    }
}
