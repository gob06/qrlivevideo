<?php
declare(strict_types=1);

namespace App\Controllers;

use App\Audit;
use App\Bootstrap;
use App\Cleanup;
use App\Database;
use App\RateLimiter;
use App\Validator;
use function App\jsonInput;
use function App\jsonResponse;
use function App\utcNow;

class AudienceApiController
{
    public static function join(): void
    {
        Cleanup::maybeRun();
        $ipHash = Bootstrap::ipHash();
        RateLimiter::requireLimit('join:' . $ipHash, 25, 60);

        $in = jsonInput();
        $slug = Validator::slug((string)($in['slug'] ?? ''));
        $rawName = Validator::cleanText((string)($in['display_name'] ?? ''), 40);
        $message = Validator::cleanText((string)($in['message'] ?? ''), 120);
        $consent = !empty($in['consent']);
        $existingToken = Validator::cleanText((string)($in['session_token'] ?? ($_COOKIE['qrlw_aud_' . $slug] ?? '')), 96);

        if ($slug === '' || $rawName === '' || !$consent) {
            jsonResponse(['error' => 'Display name and camera/mic consent are required.'], 422);
        }

        $event = Database::fetchOne('SELECT * FROM events WHERE slug = ?', [$slug]);
        if ($event === null) {
            jsonResponse(['error' => 'Event not found.'], 404);
        }
        if ($event['status'] !== 'active') {
            jsonResponse(['error' => 'This event has ended.', 'code' => 'event_closed'], 403);
        }

        $eventId = (int)$event['id'];

        $ban = Database::fetchOne(
            "SELECT id FROM bans WHERE event_id = ? AND (ip_hash = ? OR (session_token != '' AND session_token = ?)) LIMIT 1",
            [$eventId, $ipHash, $existingToken]
        );
        if ($ban !== null) {
            jsonResponse(['error' => 'You have been removed from this event.', 'code' => 'banned'], 403);
        }

        $name = Validator::filterProfanity($rawName);
        $now = utcNow();
        $ua = substr((string)($_SERVER['HTTP_USER_AGENT'] ?? ''), 0, 250);

        if ($existingToken !== '') {
            $existing = Database::fetchOne(
                'SELECT * FROM participants WHERE event_id = ? AND session_token = ?',
                [$eventId, $existingToken]
            );
            if ($existing !== null) {
                if ($existing['status'] === 'banned') {
                    jsonResponse(['error' => 'You have been banned from this event.', 'code' => 'banned'], 403);
                }
                if ((int)$event['join_locked'] === 1 && !in_array($existing['status'], ['waiting', 'onair'], true)) {
                    jsonResponse(['error' => 'Joining is currently locked by the host.', 'code' => 'join_locked'], 403);
                }
                $newStatus = in_array($existing['status'], ['waiting', 'onair'], true) ? $existing['status'] : 'waiting';
                Database::execute(
                    'UPDATE participants SET display_name = ?, message = ?, status = ?, last_seen = ?, ip_hash = ?, user_agent = ? WHERE id = ?',
                    [$name, $message, $newStatus, $now, $ipHash, $ua, (int)$existing['id']]
                );
                self::setAudienceCookie($slug, $existingToken);
                jsonResponse([
                    'participant_id' => (int)$existing['id'],
                    'session_token' => $existingToken,
                    'status' => $newStatus,
                    'display_name' => $name,
                    'ice_servers' => Bootstrap::iceServersConfig(),
                ]);
            }
        }

        if ((int)$event['join_locked'] === 1) {
            jsonResponse(['error' => 'Joining is currently locked by the host.', 'code' => 'join_locked'], 403);
        }

        $activeCountRow = Database::fetchOne(
            "SELECT COUNT(*) AS cnt FROM participants WHERE event_id = ? AND status IN ('waiting', 'onair')",
            [$eventId]
        );
        $activeCount = (int)($activeCountRow['cnt'] ?? 0);
        if ($activeCount >= (int)$event['max_participants']) {
            jsonResponse(['error' => 'Lobby is currently full. Please try again shortly.', 'code' => 'full'], 403);
        }

        $token = bin2hex(random_bytes(24));
        Database::execute(
            'INSERT INTO participants (event_id, session_token, display_name, message, status, last_seen, joined_at, ip_hash, user_agent)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
            [$eventId, $token, $name, $message, 'waiting', $now, $now, $ipHash, $ua]
        );
        $pid = Database::lastInsertId();

        $newConcurrent = $activeCount + 1;
        Database::execute(
            'UPDATE events SET total_joined = total_joined + 1, peak_concurrent = CASE WHEN peak_concurrent < ? THEN ? ELSE peak_concurrent END WHERE id = ?',
            [$newConcurrent, $newConcurrent, $eventId]
        );
        Audit::timeline($eventId, 'join', $name . ' joined the lobby');
        self::setAudienceCookie($slug, $token);

        jsonResponse([
            'participant_id' => $pid,
            'session_token' => $token,
            'status' => 'waiting',
            'display_name' => $name,
            'ice_servers' => Bootstrap::iceServersConfig(),
        ]);
    }

    public static function thumbnail(): void
    {
        $in = jsonInput();
        $slug = Validator::slug((string)($in['slug'] ?? ''));
        $token = Validator::cleanText((string)($in['session_token'] ?? ''), 96);
        $img = (string)($in['image'] ?? '');

        if ($slug === '' || $token === '' || !str_starts_with($img, 'data:image/jpeg;base64,')) {
            jsonResponse(['error' => 'Invalid thumbnail payload.'], 422);
        }
        if (strlen($img) > 70000) {
            jsonResponse(['error' => 'Thumbnail too large.'], 422);
        }
        RateLimiter::requireLimit('thumb:' . substr($token, 0, 16), 30, 60);

        $p = self::loadParticipant($slug, $token);
        if (!in_array($p['status'], ['waiting', 'onair'], true)) {
            jsonResponse(['ok' => false, 'status' => $p['status']]);
        }

        Database::execute(
            'UPDATE participants SET thumbnail_data = ?, thumb_version = thumb_version + 1, last_seen = ? WHERE id = ?',
            [$img, utcNow(), (int)$p['id']]
        );
        jsonResponse(['ok' => true]);
    }

    public static function poll(): void
    {
        Cleanup::maybeRun();
        $slug = Validator::slug((string)($_GET['slug'] ?? ''));
        $token = Validator::cleanText((string)($_GET['token'] ?? ''), 96);
        $p = self::loadParticipant($slug, $token);

        jsonResponse(self::buildAudienceState($p));
    }

    public static function stream(): void
    {
        $slug = Validator::slug((string)($_GET['slug'] ?? ''));
        $token = Validator::cleanText((string)($_GET['token'] ?? ''), 96);
        self::loadParticipant($slug, $token);

        header('Content-Type: text/event-stream; charset=utf-8');
        header('Cache-Control: no-cache, no-store');
        header('X-Accel-Buffering: no');
        @ini_set('output_buffering', 'off');
        @ini_set('zlib.output_compression', '0');

        $start = time();
        $lastHash = '';
        while (!connection_aborted() && (time() - $start) < 15) {
            $fresh = self::loadParticipant($slug, $token);
            $state = self::buildAudienceState($fresh);
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
            usleep(600000);
        }
        exit;
    }

    public static function signal(): void
    {
        $in = jsonInput();
        $slug = Validator::slug((string)($in['slug'] ?? ''));
        $token = Validator::cleanText((string)($in['session_token'] ?? ''), 96);
        $targetId = Validator::cleanText((string)($in['target_id'] ?? 'obs'), 64);
        $type = Validator::cleanText((string)($in['type'] ?? ''), 32);
        $payload = json_encode($in['payload'] ?? null, JSON_UNESCAPED_SLASHES);

        if ($type === '' || $payload === false || strlen($payload) > 65000) {
            jsonResponse(['error' => 'Invalid signal.'], 422);
        }

        $p = self::loadParticipant($slug, $token);
        RateLimiter::requireLimit('sig_aud:' . $p['id'], 120, 60);

        Database::execute(
            "INSERT INTO signals (event_id, participant_id, target_id, direction, type, payload, created_at, consumed)
             VALUES (?, ?, ?, 'to_viewer', ?, ?, ?, 0)",
            [(int)$p['event_id'], (int)$p['id'], $targetId, $type, $payload, utcNow()]
        );

        jsonResponse(['ok' => true]);
    }

    public static function stats(): void
    {
        $in = jsonInput();
        $slug = Validator::slug((string)($in['slug'] ?? ''));
        $token = Validator::cleanText((string)($in['session_token'] ?? ''), 96);
        $p = self::loadParticipant($slug, $token);

        Database::upsert(
            'stream_stats',
            ['event_id' => (int)$p['event_id'], 'participant_id' => (int)$p['id'], 'reporter' => 'audience'],
            [
                'state' => Validator::cleanText((string)($in['state'] ?? 'unknown'), 32),
                'width' => max(0, (int)($in['width'] ?? 0)),
                'height' => max(0, (int)($in['height'] ?? 0)),
                'fps' => max(0.0, (float)($in['fps'] ?? 0)),
                'bitrate' => max(0, (int)($in['bitrate'] ?? 0)),
                'packet_loss' => max(0.0, (float)($in['packet_loss'] ?? 0)),
                'rtt' => max(0.0, (float)($in['rtt'] ?? 0)),
                'relay_type' => Validator::cleanText((string)($in['relay_type'] ?? 'unknown'), 32),
                'reported_at' => utcNow(),
            ]
        );
        jsonResponse(['ok' => true]);
    }

    public static function leave(): void
    {
        $in = jsonInput();
        $slug = Validator::slug((string)($in['slug'] ?? ''));
        $token = Validator::cleanText((string)($in['session_token'] ?? ''), 96);
        if ($slug === '' || $token === '') {
            jsonResponse(['ok' => true]);
        }

        $p = Database::fetchOne(
            'SELECT p.id, p.event_id, p.display_name FROM participants p JOIN events e ON e.id = p.event_id WHERE e.slug = ? AND p.session_token = ?',
            [$slug, $token]
        );
        if ($p !== null) {
            Database::execute('DELETE FROM wall_slots WHERE participant_id = ?', [(int)$p['id']]);
            Database::execute('DELETE FROM signals WHERE participant_id = ?', [(int)$p['id']]);
            Database::execute(
                "UPDATE participants SET status = 'left', thumbnail_data = NULL, preview_admin_id = NULL WHERE id = ?",
                [(int)$p['id']]
            );
            Database::execute(
                'UPDATE events SET state_version = state_version + 1, last_action_by = ?, last_action_summary = ?, last_action_at = ? WHERE id = ?',
                [$p['display_name'], $p['display_name'] . ' left the stream', utcNow(), (int)$p['event_id']]
            );
            Audit::timeline((int)$p['event_id'], 'leave', $p['display_name'] . ' left');
        }
        jsonResponse(['ok' => true]);
    }

    private static function loadParticipant(string $slug, string $token): array
    {
        if ($slug === '' || $token === '') {
            jsonResponse(['error' => 'Missing credentials.'], 400);
        }
        $row = Database::fetchOne(
            'SELECT p.*, e.status AS event_status, e.join_locked, e.audio_enabled, e.blackout
             FROM participants p
             JOIN events e ON e.id = p.event_id
             WHERE e.slug = ? AND p.session_token = ?',
            [$slug, $token]
        );
        if ($row === null) {
            jsonResponse(['error' => 'Participant session not found.', 'code' => 'not_found'], 404);
        }
        return $row;
    }

    private static function buildAudienceState(array $p): array
    {
        $now = utcNow();
        $pid = (int)$p['id'];
        $eid = (int)$p['event_id'];

        if (in_array($p['status'], ['waiting', 'onair'], true)) {
            Database::execute('UPDATE participants SET last_seen = ? WHERE id = ?', [$now, $pid]);
        }

        $slot = Database::fetchOne('SELECT slot_no FROM wall_slots WHERE event_id = ? AND participant_id = ?', [$eid, $pid]);
        $effectiveStatus = $p['status'];
        if ($p['event_status'] !== 'active') {
            $effectiveStatus = 'event_closed';
        }

        $targets = [];
        if ($effectiveStatus === 'onair' && $slot !== null) {
            $cutoff = utcNow(-15);
            $viewers = Database::fetchAll(
                'SELECT viewer_id FROM wall_heartbeats WHERE event_id = ? AND last_seen >= ? ORDER BY is_primary DESC, last_seen DESC LIMIT 3',
                [$eid, $cutoff]
            );
            foreach ($viewers as $v) {
                $targets[] = $v['viewer_id'];
            }
            if (!in_array('obs', $targets, true)) {
                $targets[] = 'obs';
            }
        }
        if (in_array($effectiveStatus, ['waiting', 'onair'], true) && !empty($p['preview_admin_id'])) {
            $targets[] = 'preview_' . (int)$p['preview_admin_id'];
        }

        $pdo = Database::pdo();
        $pdo->beginTransaction();
        $signals = Database::fetchAll(
            "SELECT id, target_id, type, payload FROM signals WHERE event_id = ? AND participant_id = ? AND direction = 'to_audience' AND consumed = 0 ORDER BY id ASC",
            [$eid, $pid]
        );
        if ($signals) {
            $ids = array_map(static fn(array $r): int => (int)$r['id'], $signals);
            $ph = implode(',', array_fill(0, count($ids), '?'));
            Database::execute("DELETE FROM signals WHERE id IN ({$ph})", $ids);
        }
        $pdo->commit();

        $formattedSignals = array_map(static fn(array $s): array => [
            'id' => (int)$s['id'],
            'target_id' => $s['target_id'],
            'type' => $s['type'],
            'payload' => json_decode($s['payload'], true),
        ], $signals);

        return [
            'status' => $effectiveStatus,
            'slot_no' => $slot ? (int)$slot['slot_no'] : null,
            'display_name' => (int)$p['name_hidden'] === 1 ? 'Guest' : $p['display_name'],
            'muted_by_admin' => (int)$p['muted_by_admin'] === 1,
            'wall_audio_enabled' => (int)$p['audio_enabled'] === 1,
            'blackout' => (int)$p['blackout'] === 1,
            'preview_active' => !empty($p['preview_admin_id']),
            'active_targets' => array_values(array_unique($targets)),
            'signals' => $formattedSignals,
        ];
    }

    private static function setAudienceCookie(string $slug, string $token): void
    {
        setcookie('qrlw_aud_' . $slug, $token, [
            'expires' => time() + 86400,
            'path' => '/',
            'secure' => Bootstrap::isHttps(),
            'httponly' => false,
            'samesite' => 'Lax',
        ]);
    }
}
