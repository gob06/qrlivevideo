<?php
declare(strict_types=1);

namespace App\Controllers;

use App\Bootstrap;
use App\Cleanup;
use App\Database;
use App\RateLimiter;
use App\Validator;
use function App\jsonInput;
use function App\jsonResponse;
use function App\utcNow;

class WallApiController
{
    public static function poll(): void
    {
        Cleanup::maybeRun();
        $slug = Validator::slug((string)($_GET['slug'] ?? ''));
        $key = (string)($_GET['key'] ?? '');
        $viewerId = preg_replace('/[^a-zA-Z0-9_-]/', '', (string)($_GET['viewer_id'] ?? 'obs')) ?: 'obs';
        $isPrimary = ((string)($_GET['is_primary'] ?? '0')) === '1' ? 1 : 0;
        $resolution = Validator::cleanText((string)($_GET['resolution'] ?? ''), 32);
        $version = Validator::cleanText((string)($_GET['version'] ?? ''), 32);

        $event = self::verifyWall($slug, $key);
        self::touchHeartbeat((int)$event['id'], $viewerId, $isPrimary, $resolution, $version);
        jsonResponse(self::buildWallState($event, $viewerId));
    }

    public static function stream(): void
    {
        $slug = Validator::slug((string)($_GET['slug'] ?? ''));
        $key = (string)($_GET['key'] ?? '');
        $viewerId = preg_replace('/[^a-zA-Z0-9_-]/', '', (string)($_GET['viewer_id'] ?? 'obs')) ?: 'obs';
        $isPrimary = ((string)($_GET['is_primary'] ?? '0')) === '1' ? 1 : 0;
        $resolution = Validator::cleanText((string)($_GET['resolution'] ?? ''), 32);
        $version = Validator::cleanText((string)($_GET['version'] ?? ''), 32);

        self::verifyWall($slug, $key);

        header('Content-Type: text/event-stream; charset=utf-8');
        header('Cache-Control: no-cache, no-store');
        header('X-Accel-Buffering: no');
        @ini_set('output_buffering', 'off');
        @ini_set('zlib.output_compression', '0');

        $start = time();
        $lastHash = '';
        while (!connection_aborted() && (time() - $start) < 15) {
            $fresh = self::verifyWall($slug, $key);
            self::touchHeartbeat((int)$fresh['id'], $viewerId, $isPrimary, $resolution, $version);
            $state = self::buildWallState($fresh, $viewerId);
            $hash = md5((string)json_encode($state));
            if ($hash !== $lastHash || !empty($state['signals'])) {
                echo "event: state\n";
                echo 'data: ' . json_encode($state, JSON_UNESCAPED_SLASHES) . "\n\n";
                $lastHash = $hash;
            } else {
                echo ": ping\n\n";
            }
            @ob_flush();
            @flush();
            usleep(500000);
        }
        exit;
    }

    public static function signal(): void
    {
        $in = jsonInput();
        $slug = Validator::slug((string)($in['slug'] ?? ''));
        $key = (string)($in['key'] ?? '');
        $viewerId = preg_replace('/[^a-zA-Z0-9_-]/', '', (string)($in['viewer_id'] ?? 'obs')) ?: 'obs';
        $participantId = (int)($in['participant_id'] ?? 0);
        $type = Validator::cleanText((string)($in['type'] ?? ''), 32);
        $payload = json_encode($in['payload'] ?? null, JSON_UNESCAPED_SLASHES);

        $event = self::verifyWall($slug, $key);
        if ($participantId <= 0 || $type === '' || $payload === false || strlen($payload) > 65000) {
            jsonResponse(['error' => 'Invalid signal.'], 422);
        }

        RateLimiter::requireLimit('sig_wall:' . $event['id'] . ':' . $viewerId, 240, 60);

        Database::execute(
            "INSERT INTO signals (event_id, participant_id, target_id, direction, type, payload, created_at, consumed)
             VALUES (?, ?, ?, 'to_audience', ?, ?, ?, 0)",
            [(int)$event['id'], $participantId, $viewerId, $type, $payload, utcNow()]
        );

        jsonResponse(['ok' => true]);
    }

    public static function stats(): void
    {
        $in = jsonInput();
        $slug = Validator::slug((string)($in['slug'] ?? ''));
        $key = (string)($in['key'] ?? '');
        $event = self::verifyWall($slug, $key);
        $items = $in['stats'] ?? [];
        if (!is_array($items)) {
            jsonResponse(['error' => 'Invalid stats payload.'], 422);
        }

        $now = utcNow();
        $eid = (int)$event['id'];
        foreach ($items as $item) {
            if (!is_array($item)) {
                continue;
            }
            $pid = (int)($item['participant_id'] ?? 0);
            if ($pid <= 0) {
                continue;
            }
            Database::upsert(
                'stream_stats',
                ['event_id' => $eid, 'participant_id' => $pid, 'reporter' => 'wall'],
                [
                    'state' => Validator::cleanText((string)($item['state'] ?? 'unknown'), 32),
                    'width' => max(0, (int)($item['width'] ?? 0)),
                    'height' => max(0, (int)($item['height'] ?? 0)),
                    'fps' => max(0.0, (float)($item['fps'] ?? 0)),
                    'bitrate' => max(0, (int)($item['bitrate'] ?? 0)),
                    'packet_loss' => max(0.0, (float)($item['packet_loss'] ?? 0)),
                    'rtt' => max(0.0, (float)($item['rtt'] ?? 0)),
                    'relay_type' => Validator::cleanText((string)($item['relay_type'] ?? 'unknown'), 32),
                    'reported_at' => $now,
                ]
            );
        }
        jsonResponse(['ok' => true]);
    }

    private static function verifyWall(string $slug, string $key): array
    {
        $event = Database::fetchOne(
            'SELECT e.*, m.filename AS logo_filename
             FROM events e
             LEFT JOIN media_images m ON m.id = e.logo_image_id
             WHERE e.slug = ?',
            [$slug]
        );
        if ($event === null || !hash_equals($event['wall_key'], $key)) {
            jsonResponse(['error' => 'Forbidden'], 403);
        }
        return $event;
    }

    private static function touchHeartbeat(int $eventId, string $viewerId, int $isPrimary, string $resolution, string $version): void
    {
        Database::upsert(
            'wall_heartbeats',
            ['event_id' => $eventId, 'viewer_id' => $viewerId],
            [
                'is_primary' => $isPrimary,
                'last_seen' => utcNow(),
                'resolution' => $resolution,
                'version' => $version,
            ]
        );
    }

    private static function buildWallState(array $event, string $viewerId): array
    {
        $eid = (int)$event['id'];
        $slots = Database::fetchAll(
            "SELECT ws.slot_no, ws.fit_mode, p.id AS participant_id, p.muted_by_admin, p.facing_mode, p.capture_settings, p.status
             FROM wall_slots ws
             JOIN participants p ON p.id = ws.participant_id
             WHERE ws.event_id = ? AND p.status = 'onair'
             ORDER BY ws.slot_no ASC",
            [$eid]
        );

        $activeRow = Database::fetchOne(
            "SELECT COUNT(*) AS cnt FROM participants WHERE event_id = ? AND status IN ('waiting', 'onair')",
            [$eid]
        );
        $isFull = ((int)($activeRow['cnt'] ?? 0)) >= (int)$event['max_participants'];

        $pdo = Database::pdo();
        $pdo->beginTransaction();
        $signals = Database::fetchAll(
            "SELECT id, participant_id, type, payload FROM signals WHERE event_id = ? AND target_id = ? AND direction = 'to_viewer' AND consumed = 0 ORDER BY id ASC",
            [$eid, $viewerId]
        );
        if ($signals) {
            $ids = array_map(static fn(array $r): int => (int)$r['id'], $signals);
            $ph = implode(',', array_fill(0, count($ids), '?'));
            Database::execute("DELETE FROM signals WHERE id IN ({$ph})", $ids);
        }
        $pdo->commit();

        $sideQrSize = max(320, min(560, (int)($event['wall_qr_size'] ?? 480)));
        $sideQrSide = in_array(($event['wall_qr_side'] ?? 'right'), ['right', 'left'], true) ? (string)$event['wall_qr_side'] : 'right';
        $sideQrValign = in_array(($event['wall_qr_valign'] ?? 'center'), ['center', 'top'], true) ? (string)$event['wall_qr_valign'] : 'center';
        $sideQrOpacity = max(0, min(100, (int)($event['wall_qr_bg_opacity'] ?? 100)));

        return [
            'event_status' => $event['status'],
            'join_locked' => (int)$event['join_locked'] === 1,
            'is_full' => $isFull,
            'title' => $event['title'],
            'blackout' => (int)$event['blackout'] === 1,
            'layout' => $event['layout'],
            'max_wall_feeds' => (int)$event['max_wall_feeds'],
            'show_labels' => false,
            'audio_enabled' => (int)$event['audio_enabled'] === 1,
            'wall_fit_mode' => $event['wall_fit_mode'] ?? 'fit',
            'wall_tile_bg' => $event['wall_tile_bg'] ?? 'blur',
            'wall_tile_bg_color' => $event['wall_tile_bg_color'] ?? '#090d16',
            'mirror_front_wall' => false,
            'side_qr' => [
                'enabled' => (int)($event['wall_qr_side_enabled'] ?? 1) === 1,
                'hidden' => (int)($event['wall_qr_hidden'] ?? 0) === 1,
                'side' => $sideQrSide,
                'size' => $sideQrSize,
                'valign' => $sideQrValign,
                'bg_color' => (string)($event['wall_qr_bg_color'] ?? '#090d16'),
                'bg_opacity' => $sideQrOpacity,
                'show_title' => (int)($event['wall_qr_show_title'] ?? 1) === 1,
            ],
            'qr' => [
                'joinUrl' => Bootstrap::baseUrl() . '/join/' . rawurlencode($event['slug']),
                'logoUrl' => $event['logo_filename'] ? '/uploads/logos/' . rawurlencode($event['logo_filename']) : null,
                'shape' => $event['qr_logo_shape'],
                'fit' => $event['qr_logo_fit'],
                'scale' => (int)$event['qr_logo_scale'],
                'padding' => (int)$event['qr_logo_padding'],
                'logoBg' => $event['qr_logo_bg'],
                'fg' => $event['qr_fg'],
                'bg' => $event['qr_bg'],
            ],
            'slots' => array_map(static fn(array $s): array => [
                'slot_no' => (int)$s['slot_no'],
                'participant_id' => (int)$s['participant_id'],
                'muted' => (int)$s['muted_by_admin'] === 1,
                'fit_mode' => $s['fit_mode'] ?? null,
                'facing_mode' => $s['facing_mode'] ?? 'unknown',
                'capture_settings' => !empty($s['capture_settings']) ? json_decode((string)$s['capture_settings'], true) : null,
            ], $slots),
            'signals' => array_map(static fn(array $sig): array => [
                'id' => (int)$sig['id'],
                'participant_id' => (int)$sig['participant_id'],
                'type' => $sig['type'],
                'payload' => json_decode($sig['payload'], true),
            ], $signals),
        ];
    }
}
