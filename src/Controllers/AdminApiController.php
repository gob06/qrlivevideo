<?php
declare(strict_types=1);

namespace App\Controllers;

use App\Audit;
use App\Auth;
use App\Bootstrap;
use App\Cleanup;
use App\Database;
use App\ImageBank;
use App\Validator;
use function App\jsonInput;
use function App\jsonResponse;
use function App\utcNow;

class AdminApiController
{
    public static function me(): void
    {
        $user = Auth::requireApiAuth(['super_admin', 'host', 'moderator'], false);
        Auth::touchPresence();
        jsonResponse(['user' => $user]);
    }

    public static function logoutEverywhere(): void
    {
        $user = Auth::requireApiAuth(['super_admin', 'host', 'moderator'], true);
        Audit::log(null, (int)$user['id'], $user['display_name'], 'logout_everywhere', 'Revoked all own sessions');
        Auth::revokeAllForAdmin((int)$user['id']);
        Auth::logoutCurrent();
        jsonResponse(['ok' => true]);
    }

    public static function listEvents(): void
    {
        $user = Auth::requireApiAuth(['super_admin', 'host', 'moderator'], false);
        Auth::touchPresence();

        if ($user['role'] === 'super_admin' || $user['event_scope'] === 'all') {
            $events = Database::fetchAll(
                "SELECT e.*, m.filename AS logo_filename, jm.filename AS join_logo_filename,
                        (SELECT COUNT(*) FROM participants p WHERE p.event_id = e.id AND p.status = 'waiting') AS waiting_count,
                        (SELECT COUNT(*) FROM participants p WHERE p.event_id = e.id AND p.status = 'onair') AS onair_count
                 FROM events e
                 LEFT JOIN media_images m ON m.id = e.logo_image_id
                 LEFT JOIN media_images jm ON jm.id = e.join_logo_image_id
                 ORDER BY e.created_at DESC"
            );
        } else {
            $events = Database::fetchAll(
                "SELECT e.*, m.filename AS logo_filename, jm.filename AS join_logo_filename,
                        (SELECT COUNT(*) FROM participants p WHERE p.event_id = e.id AND p.status = 'waiting') AS waiting_count,
                        (SELECT COUNT(*) FROM participants p WHERE p.event_id = e.id AND p.status = 'onair') AS onair_count
                 FROM events e
                 JOIN admin_event_access aea ON aea.event_id = e.id AND aea.admin_id = ?
                 LEFT JOIN media_images m ON m.id = e.logo_image_id
                 LEFT JOIN media_images jm ON jm.id = e.join_logo_image_id
                 ORDER BY e.created_at DESC",
                [(int)$user['id']]
            );
        }
        jsonResponse(['events' => $events]);
    }

    public static function createEvent(): void
    {
        $user = Auth::requireApiAuth(['super_admin', 'host'], true);
        $in = jsonInput();
        $title = Validator::cleanText((string)($in['title'] ?? ''), 120);
        if ($title === '') {
            jsonResponse(['error' => 'Event title is required.'], 422);
        }
        $slugInput = (string)($in['slug'] ?? '');
        $slug = Validator::slug($slugInput !== '' ? $slugInput : $title);
        if ($slug === '') {
            $slug = 'event-' . bin2hex(random_bytes(3));
        }

        if (Database::fetchOne('SELECT id FROM events WHERE slug = ?', [$slug]) !== null) {
            $slug .= '-' . substr(bin2hex(random_bytes(2)), 0, 4);
        }

        $defaultLogo = Database::fetchOne(
            "SELECT id FROM media_images WHERE is_default = 1 AND (visibility = 'shared' OR uploaded_by = ?) LIMIT 1",
            [(int)$user['id']]
        );
        $logoId = $defaultLogo ? (int)$defaultLogo['id'] : null;
        $wallKey = bin2hex(random_bytes(16));
        $now = utcNow();

        Database::execute(
            'INSERT INTO events (slug, title, wall_key, status, join_locked, max_participants, max_wall_feeds, layout, show_labels, audio_enabled, blackout, logo_image_id, created_by, created_at)
             VALUES (?, ?, ?, ?, 0, ?, ?, ?, 1, 0, 0, ?, ?, ?)',
            [
                $slug,
                $title,
                $wallKey,
                'active',
                max(2, min(500, (int)($in['max_participants'] ?? 100))),
                max(1, min(4, (int)($in['max_wall_feeds'] ?? 4))),
                in_array($in['layout'] ?? 'single', ['single', 'split2', 'grid4', 'pip'], true) ? $in['layout'] : 'single',
                $logoId,
                (int)$user['id'],
                $now,
            ]
        );
        $eventId = Database::lastInsertId();
        ImageBank::syncUseCounts();

        if ($user['event_scope'] === 'assigned') {
            Database::execute('INSERT INTO admin_event_access (admin_id, event_id) VALUES (?, ?)', [(int)$user['id'], $eventId]);
        }

        Audit::log($eventId, (int)$user['id'], $user['display_name'], 'event_created', "Created event {$title} ({$slug})");
        $event = Database::fetchOne('SELECT * FROM events WHERE id = ?', [$eventId]);
        jsonResponse(['event' => $event], 201);
    }

    public static function updateEventSettings(int $eventId): void
    {
        $user = Auth::requireApiAuth(['super_admin', 'host'], true);
        $event = Auth::requireEventAccess($user, $eventId);
        $in = jsonInput();

        $title = isset($in['title']) ? Validator::cleanText((string)$in['title'], 120) : $event['title'];
        if ($title === '') {
            jsonResponse(['error' => 'Title cannot be empty.'], 422);
        }
        $status = isset($in['status']) && in_array($in['status'], ['active', 'closed'], true) ? $in['status'] : $event['status'];
        $joinLocked = isset($in['join_locked']) ? ((int)!empty($in['join_locked'])) : (int)$event['join_locked'];
        $maxPart = isset($in['max_participants']) ? max(2, min(500, (int)$in['max_participants'])) : (int)$event['max_participants'];
        $maxFeeds = isset($in['max_wall_feeds']) ? max(1, min(4, (int)$in['max_wall_feeds'])) : (int)$event['max_wall_feeds'];
        $layout = isset($in['layout']) && in_array($in['layout'], ['single', 'split2', 'grid4', 'pip'], true) ? $in['layout'] : $event['layout'];
        $showLabels = isset($in['show_labels']) ? ((int)!empty($in['show_labels'])) : (int)$event['show_labels'];
        $audioEnabled = isset($in['audio_enabled']) ? ((int)!empty($in['audio_enabled'])) : (int)$event['audio_enabled'];
        $blackout = isset($in['blackout']) ? ((int)!empty($in['blackout'])) : (int)$event['blackout'];

        $logoImageId = array_key_exists('logo_image_id', $in)
            ? ($in['logo_image_id'] === null || $in['logo_image_id'] === '' ? null : (int)$in['logo_image_id'])
            : ($event['logo_image_id'] !== null ? (int)$event['logo_image_id'] : null);

        if ($logoImageId !== null) {
            $img = Database::fetchOne(
                "SELECT id FROM media_images WHERE id = ? AND (visibility = 'shared' OR uploaded_by = ?)",
                [$logoImageId, (int)$user['id']]
            );
            if ($img === null) {
                jsonResponse(['error' => 'Selected logo image is unavailable.'], 404);
            }
        }

        $joinLogoImageId = array_key_exists('join_logo_image_id', $in)
            ? ($in['join_logo_image_id'] === null || $in['join_logo_image_id'] === '' ? null : (int)$in['join_logo_image_id'])
            : (isset($event['join_logo_image_id']) && $event['join_logo_image_id'] !== null ? (int)$event['join_logo_image_id'] : null);

        if ($joinLogoImageId !== null) {
            $jImg = Database::fetchOne(
                "SELECT id FROM media_images WHERE id = ? AND (visibility = 'shared' OR uploaded_by = ?)",
                [$joinLogoImageId, (int)$user['id']]
            );
            if ($jImg === null) {
                jsonResponse(['error' => 'Selected join branding image is unavailable.'], 404);
            }
        }

        $qrShape = isset($in['qr_logo_shape']) && in_array($in['qr_logo_shape'], ['square', 'circle'], true) ? $in['qr_logo_shape'] : $event['qr_logo_shape'];
        $qrFit = isset($in['qr_logo_fit']) && in_array($in['qr_logo_fit'], ['contain', 'cover'], true) ? $in['qr_logo_fit'] : $event['qr_logo_fit'];
        $qrScale = isset($in['qr_logo_scale']) ? max(10, min(22, (int)$in['qr_logo_scale'])) : (int)$event['qr_logo_scale'];
        $qrPadding = isset($in['qr_logo_padding']) ? max(0, min(24, (int)$in['qr_logo_padding'])) : (int)$event['qr_logo_padding'];
        $qrLogoBg = isset($in['qr_logo_bg']) ? Validator::hexColor((string)$in['qr_logo_bg'], '#ffffff', true) : $event['qr_logo_bg'];
        $qrFg = isset($in['qr_fg']) ? Validator::hexColor((string)$in['qr_fg'], '#000000', false) : $event['qr_fg'];
        $qrBg = isset($in['qr_bg']) ? Validator::hexColor((string)$in['qr_bg'], '#ffffff', false) : $event['qr_bg'];

        if (Validator::relativeLuminance($qrFg) >= Validator::relativeLuminance($qrBg)) {
            jsonResponse(['error' => 'QR foreground must be darker than QR background for reliable scanning.'], 422);
        }
        if (Validator::contrastRatio($qrFg, $qrBg) < 4.5) {
            jsonResponse(['error' => 'QR foreground/background contrast ratio is too low (< 4.5:1). Choose darker modules or a lighter background.'], 422);
        }

        $wallKey = !empty($in['regen_wall_key']) ? bin2hex(random_bytes(16)) : $event['wall_key'];

        if ($status === 'closed' && $event['status'] !== 'closed') {
            Database::execute('DELETE FROM wall_slots WHERE event_id = ?', [$eventId]);
            Database::execute('UPDATE participants SET thumbnail_data = NULL, preview_admin_id = NULL WHERE event_id = ?', [$eventId]);
        }

        Database::execute('DELETE FROM wall_slots WHERE event_id = ? AND slot_no > ?', [$eventId, $maxFeeds]);
        Database::execute(
            "UPDATE participants SET status = 'waiting'
             WHERE event_id = ? AND status = 'onair' AND id NOT IN (SELECT participant_id FROM wall_slots WHERE event_id = ?)",
            [$eventId, $eventId]
        );

        $wallFitMode = isset($in['wall_fit_mode']) && in_array($in['wall_fit_mode'], ['fit', 'fill', 'stretch'], true)
            ? $in['wall_fit_mode']
            : ($event['wall_fit_mode'] ?? 'fit');
        $wallTileBg = isset($in['wall_tile_bg']) && in_array($in['wall_tile_bg'], ['blur', 'solid', 'transparent'], true)
            ? $in['wall_tile_bg']
            : ($event['wall_tile_bg'] ?? 'blur');
        $wallTileBgColor = isset($in['wall_tile_bg_color'])
            ? Validator::hexColor((string)$in['wall_tile_bg_color'], '#090d16', false)
            : ($event['wall_tile_bg_color'] ?? '#090d16');
        $mirrorFrontWall = isset($in['mirror_front_wall'])
            ? ((int)!empty($in['mirror_front_wall']))
            : ((int)($event['mirror_front_wall'] ?? 0));

        Database::execute(
            'UPDATE events SET title = ?, wall_key = ?, status = ?, join_locked = ?, max_participants = ?, max_wall_feeds = ?,
             layout = ?, show_labels = ?, audio_enabled = ?, blackout = ?, logo_image_id = ?, join_logo_image_id = ?,
             wall_fit_mode = ?, wall_tile_bg = ?, wall_tile_bg_color = ?, mirror_front_wall = ?,
             qr_logo_shape = ?, qr_logo_fit = ?, qr_logo_scale = ?, qr_logo_padding = ?, qr_logo_bg = ?, qr_fg = ?, qr_bg = ?,
             state_version = state_version + 1, last_action_by = ?, last_action_summary = ?, last_action_at = ?
             WHERE id = ?',
            [
                $title, $wallKey, $status, $joinLocked, $maxPart, $maxFeeds,
                $layout, $showLabels, $audioEnabled, $blackout, $logoImageId, $joinLogoImageId,
                $wallFitMode, $wallTileBg, $wallTileBgColor, $mirrorFrontWall,
                $qrShape, $qrFit, $qrScale, $qrPadding, $qrLogoBg, $qrFg, $qrBg,
                $user['display_name'], 'Updated event settings', utcNow(),
                $eventId,
            ]
        );
        ImageBank::syncUseCounts();
        Audit::log($eventId, (int)$user['id'], $user['display_name'], 'event_settings', "Updated settings for {$title}");

        $updated = Database::fetchOne(
            'SELECT e.*, m.filename AS logo_filename, jm.filename AS join_logo_filename FROM events e LEFT JOIN media_images m ON m.id = e.logo_image_id LEFT JOIN media_images jm ON jm.id = e.join_logo_image_id WHERE e.id = ?',
            [$eventId]
        );
        jsonResponse(['event' => $updated]);
    }

    public static function deleteEvent(int $eventId): void
    {
        $user = Auth::requireApiAuth(['super_admin'], true);
        $event = Auth::requireEventAccess($user, $eventId);
        Database::execute('DELETE FROM events WHERE id = ?', [$eventId]);
        ImageBank::syncUseCounts();
        Audit::log(null, (int)$user['id'], $user['display_name'], 'event_deleted', "Deleted event {$event['title']} ({$event['slug']})");
        jsonResponse(['ok' => true]);
    }

    public static function eventState(int $eventId): void
    {
        Cleanup::maybeRun();
        $user = Auth::requireApiAuth(['super_admin', 'host', 'moderator'], false);
        Auth::touchPresence($eventId);
        Auth::requireEventAccess($user, $eventId);

        $eventRow = Database::fetchOne(
            'SELECT e.*, m.filename AS logo_filename, jm.filename AS join_logo_filename
             FROM events e
             LEFT JOIN media_images m ON m.id = e.logo_image_id
             LEFT JOIN media_images jm ON jm.id = e.join_logo_image_id
             WHERE e.id = ?',
            [$eventId]
        );

        $participants = Database::fetchAll(
            "SELECT p.id, p.display_name, p.message, p.name_hidden, p.muted_by_admin, p.status,
                    p.facing_mode, p.capture_settings, p.preview_admin_id, p.last_seen, p.joined_at, p.thumb_version,
                    (p.thumbnail_data IS NOT NULL) AS has_thumb,
                    ws.slot_no, ws.fit_mode AS slot_fit_mode
             FROM participants p
             LEFT JOIN wall_slots ws ON ws.event_id = p.event_id AND ws.participant_id = p.id
             WHERE p.event_id = ? AND p.status IN ('waiting', 'onair')
             ORDER BY (ws.slot_no IS NULL) ASC, ws.slot_no ASC, p.joined_at ASC",
            [$eventId]
        );

        $statsRows = Database::fetchAll('SELECT * FROM stream_stats WHERE event_id = ?', [$eventId]);
        $statsMap = [];
        foreach ($statsRows as $sr) {
            $statsMap[(int)$sr['participant_id']][$sr['reporter']] = $sr;
        }

        $obsHb = Database::fetchOne(
            'SELECT * FROM wall_heartbeats WHERE event_id = ? AND is_primary = 1 ORDER BY last_seen DESC LIMIT 1',
            [$eventId]
        );
        $wallOnline = false;
        $wallAgeSec = null;
        if ($obsHb !== null) {
            $wallAgeSec = max(0, time() - strtotime($obsHb['last_seen'] . ' UTC'));
            $wallOnline = $wallAgeSec <= Bootstrap::$config['wall_offline_threshold_sec'];
        }

        $onlineAdmins = Database::fetchAll(
            'SELECT DISTINCT a.id, a.display_name, a.role, s.last_seen
             FROM admin_sessions s
             JOIN admins a ON a.id = s.admin_id
             WHERE s.revoked = 0 AND s.current_event_id = ? AND s.last_seen >= ?',
            [$eventId, utcNow(-10)]
        );

        $timeline = Database::fetchAll(
            'SELECT kind, message, created_at FROM event_timeline WHERE event_id = ? ORDER BY id DESC LIMIT 20',
            [$eventId]
        );

        $alerts = [];
        $turnErr = Bootstrap::turnError();
        if ($turnErr !== '' && !Bootstrap::turnConfigured()) {
            $hint = stripos($turnErr, 'cannot find specified key') !== false
                ? 'Confirm Key ID is the TURN Token ID under Cloudflare Dashboard → Realtime → TURN (not Account ID or SFU App ID).'
                : 'Verify CLOUDFLARE_TURN_KEY_ID & CLOUDFLARE_TURN_API_TOKEN under Cloudflare Realtime → TURN.';
            $alerts[] = ['level' => 'amber', 'code' => 'turn_error', 'message' => "Cloudflare TURN key failed ({$turnErr}). {$hint}"];
        } elseif (!Bootstrap::turnConfigured()) {
            $alerts[] = ['level' => 'amber', 'code' => 'no_turn', 'message' => 'TURN server not configured — cellular/strict-NAT phones may fail to connect.'];
        }
        if (!$wallOnline) {
            $alerts[] = [
                'level' => 'red',
                'code' => 'wall_offline',
                'message' => $obsHb === null
                    ? 'OBS Wall Browser Source has not connected yet.'
                    : "OBS Wall Browser Source offline ({$wallAgeSec}s since last heartbeat).",
            ];
        }
        $quota = ImageBank::quotaBytes();
        $used = ImageBank::usedBytes();
        if ($quota > 0 && ($used / $quota) >= 0.85) {
            $pct = round(($used / $quota) * 100);
            $alerts[] = ['level' => 'amber', 'code' => 'storage_high', 'message' => "Image Bank storage is {$pct}% full."];
        }
        foreach ($participants as $p) {
            if ($p['status'] === 'onair') {
                $ws = $statsMap[(int)$p['id']]['wall'] ?? null;
                if ($ws !== null) {
                    if (in_array($ws['state'], ['failed', 'disconnected'], true)) {
                        $alerts[] = ['level' => 'red', 'code' => 'feed_failed', 'message' => "{$p['display_name']} connection {$ws['state']}."];
                    } elseif ((float)$ws['packet_loss'] > 5.0 || (float)$ws['rtt'] > 350.0) {
                        $alerts[] = ['level' => 'amber', 'code' => 'poor_quality', 'message' => "{$p['display_name']} poor network (loss {$ws['packet_loss']}%, RTT {$ws['rtt']}ms)."];
                    }
                }
            }
        }

        $waitingCount = 0;
        $onairCount = 0;
        foreach ($participants as &$p) {
            $p['id'] = (int)$p['id'];
            $p['slot_no'] = $p['slot_no'] !== null ? (int)$p['slot_no'] : null;
            $p['slot_fit_mode'] = $p['slot_fit_mode'] ?? null;
            $p['facing_mode'] = $p['facing_mode'] ?? 'unknown';
            $p['capture_settings'] = !empty($p['capture_settings']) ? json_decode((string)$p['capture_settings'], true) : null;
            $p['name_hidden'] = (int)$p['name_hidden'] === 1;
            $p['muted_by_admin'] = (int)$p['muted_by_admin'] === 1;
            $p['has_thumb'] = (bool)$p['has_thumb'];
            $p['preview_admin_id'] = $p['preview_admin_id'] !== null ? (int)$p['preview_admin_id'] : null;
            $p['stats'] = $statsMap[$p['id']] ?? null;
            if ($p['status'] === 'onair') {
                $onairCount++;
            } else {
                $waitingCount++;
            }
        }
        unset($p);

        $bans = Database::fetchAll(
            'SELECT id, display_name, reason, created_at FROM bans WHERE event_id = ? ORDER BY id DESC LIMIT 30',
            [$eventId]
        );

        jsonResponse([
            'event' => $eventRow,
            'joinUrl' => Bootstrap::baseUrl() . '/join/' . rawurlencode($eventRow['slug']),
            'wallUrl' => Bootstrap::baseUrl() . '/wall/' . rawurlencode($eventRow['slug']) . '?key=' . rawurlencode($eventRow['wall_key']),
            'participants' => $participants,
            'bans' => $bans,
            'wall_heartbeat' => [
                'online' => $wallOnline,
                'age_sec' => $wallAgeSec,
                'last_seen' => $obsHb['last_seen'] ?? null,
                'resolution' => $obsHb['resolution'] ?? '',
                'version' => $obsHb['version'] ?? '',
            ],
            'counters' => [
                'total_joined' => (int)$eventRow['total_joined'],
                'waiting' => $waitingCount,
                'onair' => $onairCount,
                'kicked_banned' => (int)$eventRow['total_kicked_banned'],
                'peak_concurrent' => (int)$eventRow['peak_concurrent'],
                'duration_sec' => max(0, time() - strtotime($eventRow['created_at'] . ' UTC')),
            ],
            'online_admins' => $onlineAdmins,
            'alerts' => $alerts,
            'timeline' => $timeline,
            'server_time' => utcNow(),
        ]);
    }

    public static function participantThumb(int $eventId, int $participantId): void
    {
        $user = Auth::requireApiAuth(['super_admin', 'host', 'moderator'], false);
        Auth::requireEventAccess($user, $eventId);

        $p = Database::fetchOne(
            'SELECT thumbnail_data FROM participants WHERE id = ? AND event_id = ?',
            [$participantId, $eventId]
        );
        if ($p === null || empty($p['thumbnail_data'])) {
            http_response_code(404);
            exit;
        }
        $dataUri = (string)$p['thumbnail_data'];
        if (!str_starts_with($dataUri, 'data:image/jpeg;base64,')) {
            http_response_code(404);
            exit;
        }
        $bytes = base64_decode(substr($dataUri, strlen('data:image/jpeg;base64,')), true);
        if ($bytes === false) {
            http_response_code(404);
            exit;
        }
        header('Content-Type: image/jpeg');
        header('Cache-Control: no-store');
        echo $bytes;
        exit;
    }

    public static function wallAction(int $eventId): void
    {
        $user = Auth::requireApiAuth(['super_admin', 'host', 'moderator'], true);
        $event = Auth::requireEventAccess($user, $eventId);
        $in = jsonInput();
        $action = (string)($in['action'] ?? '');
        $pid = (int)($in['participant_id'] ?? 0);
        $slotNo = isset($in['slot_no']) ? (int)$in['slot_no'] : null;
        $now = utcNow();
        $summary = '';

        $pdo = Database::pdo();
        $pdo->beginTransaction();
        try {
            if ($action === 'put_on_wall' || $action === 'preview_take') {
                $p = Database::fetchOne(
                    "SELECT * FROM participants WHERE id = ? AND event_id = ? AND status IN ('waiting', 'onair')",
                    [$pid, $eventId]
                );
                if ($p === null) {
                    $pdo->rollBack();
                    jsonResponse(['error' => 'Participant is no longer connected.'], 404);
                }
                $maxFeeds = (int)$event['max_wall_feeds'];
                $existingSlot = Database::fetchOne('SELECT slot_no FROM wall_slots WHERE event_id = ? AND participant_id = ?', [$eventId, $pid]);

                if ($slotNo === null) {
                    if ($existingSlot !== null) {
                        $slotNo = (int)$existingSlot['slot_no'];
                    } else {
                        $taken = Database::fetchAll('SELECT slot_no FROM wall_slots WHERE event_id = ?', [$eventId]);
                        $takenNums = array_map(static fn(array $r): int => (int)$r['slot_no'], $taken);
                        for ($i = 1; $i <= $maxFeeds; $i++) {
                            if (!in_array($i, $takenNums, true)) {
                                $slotNo = $i;
                                break;
                            }
                        }
                        if ($slotNo === null) {
                            $slotNo = 1;
                        }
                    }
                }
                if ($slotNo < 1 || $slotNo > $maxFeeds) {
                    $pdo->rollBack();
                    jsonResponse(['error' => "Slot must be between 1 and {$maxFeeds}."], 422);
                }

                $occupant = Database::fetchOne('SELECT participant_id FROM wall_slots WHERE event_id = ? AND slot_no = ?', [$eventId, $slotNo]);
                if ($occupant !== null && (int)$occupant['participant_id'] !== $pid) {
                    Database::execute("UPDATE participants SET status = 'waiting' WHERE id = ?", [(int)$occupant['participant_id']]);
                }

                Database::execute('DELETE FROM wall_slots WHERE event_id = ? AND participant_id = ?', [$eventId, $pid]);
                Database::upsert('wall_slots', ['event_id' => $eventId, 'slot_no' => $slotNo], [
                    'participant_id' => $pid,
                    'updated_at' => $now,
                ]);
                Database::execute("UPDATE participants SET status = 'onair', preview_admin_id = NULL WHERE id = ?", [$pid]);
                $summary = "Put {$p['display_name']} on Slot {$slotNo}";
                Audit::timeline($eventId, 'wall', "{$p['display_name']} went ON AIR (Slot {$slotNo})");
            } elseif ($action === 'remove_from_wall') {
                $p = Database::fetchOne('SELECT display_name FROM participants WHERE id = ? AND event_id = ?', [$pid, $eventId]);
                Database::execute('DELETE FROM wall_slots WHERE event_id = ? AND participant_id = ?', [$eventId, $pid]);
                Database::execute("UPDATE participants SET status = 'waiting' WHERE id = ? AND status = 'onair'", [$pid]);
                $name = $p ? $p['display_name'] : "#{$pid}";
                $summary = "Removed {$name} from wall";
                Audit::timeline($eventId, 'wall', "{$name} moved back to lobby");
            } elseif ($action === 'swap_slots') {
                $fromSlot = (int)($in['from_slot'] ?? 0);
                $toSlot = (int)($in['to_slot'] ?? 0);
                $maxFeeds = (int)$event['max_wall_feeds'];
                if ($fromSlot < 1 || $toSlot < 1 || $fromSlot > $maxFeeds || $toSlot > $maxFeeds || $fromSlot === $toSlot) {
                    $pdo->rollBack();
                    jsonResponse(['error' => 'Invalid slot numbers.'], 422);
                }
                $a = Database::fetchOne('SELECT participant_id FROM wall_slots WHERE event_id = ? AND slot_no = ?', [$eventId, $fromSlot]);
                $b = Database::fetchOne('SELECT participant_id FROM wall_slots WHERE event_id = ? AND slot_no = ?', [$eventId, $toSlot]);
                Database::execute('DELETE FROM wall_slots WHERE event_id = ? AND slot_no IN (?, ?)', [$eventId, $fromSlot, $toSlot]);
                if ($a !== null) {
                    Database::execute('INSERT INTO wall_slots (event_id, slot_no, participant_id, updated_at) VALUES (?, ?, ?, ?)', [$eventId, $toSlot, (int)$a['participant_id'], $now]);
                }
                if ($b !== null) {
                    Database::execute('INSERT INTO wall_slots (event_id, slot_no, participant_id, updated_at) VALUES (?, ?, ?, ?)', [$eventId, $fromSlot, (int)$b['participant_id'], $now]);
                }
                $summary = "Swapped Slot {$fromSlot} and Slot {$toSlot}";
            } elseif ($action === 'clear_wall') {
                Database::execute('DELETE FROM wall_slots WHERE event_id = ?', [$eventId]);
                Database::execute("UPDATE participants SET status = 'waiting' WHERE event_id = ? AND status = 'onair'", [$eventId]);
                $summary = 'Cleared wall back to QR';
                Audit::timeline($eventId, 'wall', 'Wall cleared back to QR');
            } elseif ($action === 'blackout') {
                $val = !empty($in['blackout']) ? 1 : 0;
                Database::execute('UPDATE events SET blackout = ? WHERE id = ?', [$val, $eventId]);
                $summary = $val ? 'Activated BLACKOUT' : 'Ended BLACKOUT';
                Audit::timeline($eventId, 'wall', $summary);
            } elseif ($action === 'toggle_audio') {
                if (!in_array($user['role'], ['super_admin', 'host'], true)) {
                    $pdo->rollBack();
                    jsonResponse(['error' => 'Only Hosts or Super Admins can toggle wall audio.'], 403);
                }
                $val = !empty($in['audio_enabled']) ? 1 : 0;
                Database::execute('UPDATE events SET audio_enabled = ? WHERE id = ?', [$val, $eventId]);
                $summary = $val ? 'Enabled wall audio' : 'Muted wall audio';
            } elseif ($action === 'toggle_labels') {
                if (!in_array($user['role'], ['super_admin', 'host'], true)) {
                    $pdo->rollBack();
                    jsonResponse(['error' => 'Only Hosts or Super Admins can toggle labels.'], 403);
                }
                $val = !empty($in['show_labels']) ? 1 : 0;
                Database::execute('UPDATE events SET show_labels = ? WHERE id = ?', [$val, $eventId]);
                $summary = $val ? 'Enabled name labels' : 'Hid name labels';
            } elseif ($action === 'set_layout') {
                if (!in_array($user['role'], ['super_admin', 'host'], true)) {
                    $pdo->rollBack();
                    jsonResponse(['error' => 'Only Hosts or Super Admins can change layout.'], 403);
                }
                $layout = (string)($in['layout'] ?? 'single');
                if (!in_array($layout, ['single', 'split2', 'grid4', 'pip'], true)) {
                    $pdo->rollBack();
                    jsonResponse(['error' => 'Invalid layout.'], 422);
                }
                Database::execute('UPDATE events SET layout = ? WHERE id = ?', [$layout, $eventId]);
                $summary = "Changed layout to {$layout}";
            } elseif ($action === 'set_slot_fit') {
                if (!in_array($user['role'], ['super_admin', 'host'], true)) {
                    $pdo->rollBack();
                    jsonResponse(['error' => 'Only Hosts or Super Admins can change tile fit mode.'], 403);
                }
                $maxFeeds = (int)$event['max_wall_feeds'];
                if ($slotNo === null || $slotNo < 1 || $slotNo > $maxFeeds) {
                    $pdo->rollBack();
                    jsonResponse(['error' => "Slot must be between 1 and {$maxFeeds}."], 422);
                }
                $rawFit = $in['fit_mode'] ?? null;
                $fitVal = ($rawFit === null || $rawFit === '' || $rawFit === 'inherit') ? null : (string)$rawFit;
                if ($fitVal !== null && !in_array($fitVal, ['fit', 'fill', 'stretch'], true)) {
                    $pdo->rollBack();
                    jsonResponse(['error' => 'Invalid tile fit mode.'], 422);
                }
                Database::execute('UPDATE wall_slots SET fit_mode = ? WHERE event_id = ? AND slot_no = ?', [$fitVal, $eventId, $slotNo]);
                $summary = 'Slot ' . $slotNo . ' fit set to ' . ($fitVal ?? 'event default');
            } elseif ($action === 'preview_start') {
                Database::execute('UPDATE participants SET preview_admin_id = NULL WHERE event_id = ? AND preview_admin_id = ?', [$eventId, (int)$user['id']]);
                Database::execute(
                    "UPDATE participants SET preview_admin_id = ?, preview_requested_at = ? WHERE id = ? AND event_id = ? AND status IN ('waiting', 'onair')",
                    [(int)$user['id'], $now, $pid, $eventId]
                );
                $summary = "Started private preview for #{$pid}";
            } elseif ($action === 'preview_stop') {
                Database::execute('UPDATE participants SET preview_admin_id = NULL WHERE event_id = ? AND preview_admin_id = ?', [$eventId, (int)$user['id']]);
                $summary = 'Stopped private preview';
            } else {
                $pdo->rollBack();
                jsonResponse(['error' => 'Unknown wall action.'], 422);
            }

            Database::execute(
                'UPDATE events SET state_version = state_version + 1, last_action_by = ?, last_action_summary = ?, last_action_at = ? WHERE id = ?',
                [$user['display_name'], $summary, $now, $eventId]
            );
            $pdo->commit();
        } catch (\Throwable $e) {
            if ($pdo->inTransaction()) {
                $pdo->rollBack();
            }
            throw $e;
        }

        Audit::log($eventId, (int)$user['id'], $user['display_name'], 'wall_' . $action, $summary);
        jsonResponse(['ok' => true, 'summary' => $summary]);
    }

    public static function participantAction(int $eventId): void
    {
        $user = Auth::requireApiAuth(['super_admin', 'host', 'moderator'], true);
        Auth::requireEventAccess($user, $eventId);
        $in = jsonInput();
        $action = (string)($in['action'] ?? '');
        $pid = (int)($in['participant_id'] ?? 0);
        $now = utcNow();

        if ($action === 'unban') {
            $banId = (int)($in['ban_id'] ?? 0);
            Database::execute('DELETE FROM bans WHERE id = ? AND event_id = ?', [$banId, $eventId]);
            Audit::log($eventId, (int)$user['id'], $user['display_name'], 'unban', "Removed ban #{$banId}");
            jsonResponse(['ok' => true]);
        }

        $p = Database::fetchOne('SELECT * FROM participants WHERE id = ? AND event_id = ?', [$pid, $eventId]);
        if ($p === null) {
            jsonResponse(['error' => 'Participant not found.'], 404);
        }

        $summary = '';
        if ($action === 'mute_toggle') {
            $newMute = (int)$p['muted_by_admin'] === 1 ? 0 : 1;
            Database::execute('UPDATE participants SET muted_by_admin = ? WHERE id = ?', [$newMute, $pid]);
            $summary = ($newMute ? 'Muted ' : 'Unmuted ') . $p['display_name'];
        } elseif ($action === 'edit_name') {
            $newName = Validator::cleanText((string)($in['display_name'] ?? $p['display_name']), 40);
            $hidden = !empty($in['name_hidden']) ? 1 : 0;
            if ($newName === '') {
                $newName = $p['display_name'];
            }
            Database::execute('UPDATE participants SET display_name = ?, name_hidden = ? WHERE id = ?', [$newName, $hidden, $pid]);
            $summary = "Updated name/visibility for {$newName}";
        } elseif ($action === 'kick') {
            Database::execute('DELETE FROM wall_slots WHERE participant_id = ?', [$pid]);
            Database::execute("UPDATE participants SET status = 'removed', thumbnail_data = NULL, preview_admin_id = NULL WHERE id = ?", [$pid]);
            Database::execute('UPDATE events SET total_kicked_banned = total_kicked_banned + 1 WHERE id = ?', [$eventId]);
            $summary = "Kicked {$p['display_name']}";
            Audit::timeline($eventId, 'kick', $summary);
        } elseif ($action === 'ban') {
            Database::execute('DELETE FROM wall_slots WHERE participant_id = ?', [$pid]);
            Database::execute("UPDATE participants SET status = 'banned', thumbnail_data = NULL, preview_admin_id = NULL WHERE id = ?", [$pid]);
            Database::execute('UPDATE events SET total_kicked_banned = total_kicked_banned + 1 WHERE id = ?', [$eventId]);
            Database::execute(
                'INSERT INTO bans (event_id, ip_hash, session_token, display_name, reason, banned_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
                [$eventId, $p['ip_hash'], $p['session_token'], $p['display_name'], Validator::cleanText((string)($in['reason'] ?? 'Banned by moderator'), 180), (int)$user['id'], $now]
            );
            $summary = "Banned {$p['display_name']}";
            Audit::timeline($eventId, 'ban', $summary);
        } else {
            jsonResponse(['error' => 'Unknown participant action.'], 422);
        }

        Database::execute(
            'UPDATE events SET state_version = state_version + 1, last_action_by = ?, last_action_summary = ?, last_action_at = ? WHERE id = ?',
            [$user['display_name'], $summary, $now, $eventId]
        );
        Audit::log($eventId, (int)$user['id'], $user['display_name'], 'participant_' . $action, $summary);
        jsonResponse(['ok' => true, 'summary' => $summary]);
    }

    public static function previewPoll(int $eventId): void
    {
        $user = Auth::requireApiAuth(['super_admin', 'host', 'moderator'], false);
        Auth::requireEventAccess($user, $eventId);
        $targetId = 'preview_' . (int)$user['id'];

        $pdo = Database::pdo();
        $pdo->beginTransaction();
        $signals = Database::fetchAll(
            "SELECT id, participant_id, type, payload FROM signals WHERE event_id = ? AND target_id = ? AND direction = 'to_viewer' AND consumed = 0 ORDER BY id ASC",
            [$eventId, $targetId]
        );
        if ($signals) {
            $ids = array_map(static fn(array $r): int => (int)$r['id'], $signals);
            $ph = implode(',', array_fill(0, count($ids), '?'));
            Database::execute("DELETE FROM signals WHERE id IN ({$ph})", $ids);
        }
        $pdo->commit();

        jsonResponse([
            'target_id' => $targetId,
            'signals' => array_map(static fn(array $s): array => [
                'id' => (int)$s['id'],
                'participant_id' => (int)$s['participant_id'],
                'type' => $s['type'],
                'payload' => json_decode($s['payload'], true),
            ], $signals),
        ]);
    }

    public static function previewSignal(int $eventId): void
    {
        $user = Auth::requireApiAuth(['super_admin', 'host', 'moderator'], true);
        Auth::requireEventAccess($user, $eventId);
        $in = jsonInput();
        $pid = (int)($in['participant_id'] ?? 0);
        $type = Validator::cleanText((string)($in['type'] ?? ''), 32);
        $payload = json_encode($in['payload'] ?? null, JSON_UNESCAPED_SLASHES);
        if ($pid <= 0 || $type === '' || $payload === false) {
            jsonResponse(['error' => 'Invalid preview signal.'], 422);
        }
        Database::execute(
            "INSERT INTO signals (event_id, participant_id, target_id, direction, type, payload, created_at, consumed)
             VALUES (?, ?, ?, 'to_audience', ?, ?, ?, 0)",
            [$eventId, $pid, 'preview_' . (int)$user['id'], $type, $payload, utcNow()]
        );
        jsonResponse(['ok' => true]);
    }

    public static function listImages(): void
    {
        $user = Auth::requireApiAuth(['super_admin', 'host', 'moderator'], false);
        ImageBank::syncUseCounts();

        $q = trim((string)($_GET['q'] ?? ''));
        $sort = (string)($_GET['sort'] ?? 'newest');
        $orderSql = match ($sort) {
            'name' => 'm.label ASC, m.id DESC',
            'used' => 'm.use_count DESC, m.id DESC',
            default => 'm.created_at DESC, m.id DESC',
        };

        $where = ["(m.visibility = 'shared' OR m.uploaded_by = ?)"];
        $params = [(int)$user['id']];
        if ($q !== '') {
            $where[] = '(LOWER(m.label) LIKE LOWER(?) OR LOWER(m.tags) LIKE LOWER(?) OR LOWER(m.original_name) LIKE LOWER(?))';
            $like = '%' . $q . '%';
            $params[] = $like;
            $params[] = $like;
            $params[] = $like;
        }

        $images = Database::fetchAll(
            "SELECT m.*, COALESCE(a.display_name, 'System') AS uploader_name
             FROM media_images m
             LEFT JOIN admins a ON a.id = m.uploaded_by
             WHERE " . implode(' AND ', $where) . "
             ORDER BY {$orderSql}",
            $params
        );

        jsonResponse([
            'images' => $images,
            'used_bytes' => ImageBank::usedBytes(),
            'quota_bytes' => ImageBank::quotaBytes(),
        ]);
    }

    public static function uploadImages(): void
    {
        $user = Auth::requireApiAuth(['super_admin', 'host'], true);
        if (empty($_FILES['files'])) {
            jsonResponse(['error' => 'No files uploaded.'], 422);
        }
        $visibility = ((string)($_POST['visibility'] ?? 'shared')) === 'private' ? 'private' : 'shared';
        $tags = (string)($_POST['tags'] ?? '');

        $files = $_FILES['files'];
        $results = [];
        $errors = [];

        if (is_array($files['name'])) {
            $count = count($files['name']);
            for ($i = 0; $i < $count; $i++) {
                $single = [
                    'name' => $files['name'][$i],
                    'type' => $files['type'][$i],
                    'tmp_name' => $files['tmp_name'][$i],
                    'error' => $files['error'][$i],
                    'size' => $files['size'][$i],
                ];
                $res = ImageBank::processUpload($single, (int)$user['id'], $visibility, $tags);
                if ($res['ok']) {
                    $results[] = $res;
                    if (empty($res['duplicate'])) {
                        Audit::log(null, (int)$user['id'], $user['display_name'], 'image_uploaded', 'Uploaded ' . $res['image']['label']);
                    }
                } else {
                    $errors[] = $single['name'] . ': ' . $res['error'];
                }
            }
        } else {
            $res = ImageBank::processUpload($files, (int)$user['id'], $visibility, $tags);
            if ($res['ok']) {
                $results[] = $res;
                if (empty($res['duplicate'])) {
                    Audit::log(null, (int)$user['id'], $user['display_name'], 'image_uploaded', 'Uploaded ' . $res['image']['label']);
                }
            } else {
                $errors[] = ($files['name'] ?? 'file') . ': ' . $res['error'];
            }
        }

        if (!$results && $errors) {
            jsonResponse(['error' => implode(' | ', $errors)], 422);
        }
        jsonResponse([
            'uploaded' => $results,
            'errors' => $errors,
            'used_bytes' => ImageBank::usedBytes(),
            'quota_bytes' => ImageBank::quotaBytes(),
        ]);
    }

    public static function updateImage(int $imageId): void
    {
        $user = Auth::requireApiAuth(['super_admin', 'host'], true);
        $img = Database::fetchOne('SELECT * FROM media_images WHERE id = ?', [$imageId]);
        if ($img === null) {
            jsonResponse(['error' => 'Image not found.'], 404);
        }
        if ($img['visibility'] === 'private' && (int)$img['uploaded_by'] !== (int)$user['id'] && $user['role'] !== 'super_admin') {
            jsonResponse(['error' => 'Forbidden.'], 403);
        }

        $in = jsonInput();
        $label = isset($in['label']) ? Validator::cleanText((string)$in['label'], 100) : $img['label'];
        $tags = isset($in['tags']) ? Validator::cleanText((string)$in['tags'], 200) : $img['tags'];
        $visibility = isset($in['visibility']) && in_array($in['visibility'], ['shared', 'private'], true) ? $in['visibility'] : $img['visibility'];
        $setDefault = !empty($in['is_default']);

        if ($label === '') {
            $label = $img['label'];
        }
        if ($setDefault) {
            Database::execute('UPDATE media_images SET is_default = 0');
            $isDefault = 1;
            $visibility = 'shared';
        } else {
            $isDefault = array_key_exists('is_default', $in) ? (!empty($in['is_default']) ? 1 : 0) : (int)$img['is_default'];
        }

        Database::execute(
            'UPDATE media_images SET label = ?, tags = ?, visibility = ?, is_default = ? WHERE id = ?',
            [$label, $tags, $visibility, $isDefault, $imageId]
        );
        Audit::log(null, (int)$user['id'], $user['display_name'], 'image_updated', "Updated image #{$imageId} ({$label})");
        jsonResponse(['ok' => true]);
    }

    public static function replaceImageEverywhere(int $imageId): void
    {
        $user = Auth::requireApiAuth(['super_admin', 'host'], true);
        $in = jsonInput();
        $replacementId = isset($in['replacement_image_id']) && $in['replacement_image_id'] !== '' ? (int)$in['replacement_image_id'] : null;

        if ($replacementId !== null) {
            $rep = Database::fetchOne('SELECT id FROM media_images WHERE id = ?', [$replacementId]);
            if ($rep === null) {
                jsonResponse(['error' => 'Replacement image not found.'], 404);
            }
        }
        Database::execute('UPDATE events SET logo_image_id = ?, state_version = state_version + 1 WHERE logo_image_id = ?', [$replacementId, $imageId]);
        Database::execute('UPDATE events SET join_logo_image_id = ?, state_version = state_version + 1 WHERE join_logo_image_id = ?', [$replacementId, $imageId]);
        ImageBank::syncUseCounts();
        Audit::log(null, (int)$user['id'], $user['display_name'], 'image_replaced', "Replaced logo #{$imageId} everywhere with " . ($replacementId ? "#{$replacementId}" : 'none'));
        jsonResponse(['ok' => true]);
    }

    public static function deleteImage(int $imageId): void
    {
        $user = Auth::requireApiAuth(['super_admin', 'host'], true);
        $img = Database::fetchOne('SELECT * FROM media_images WHERE id = ?', [$imageId]);
        if ($img === null) {
            jsonResponse(['error' => 'Image not found.'], 404);
        }
        if ($img['visibility'] === 'private' && (int)$img['uploaded_by'] !== (int)$user['id'] && $user['role'] !== 'super_admin') {
            jsonResponse(['error' => 'Forbidden.'], 403);
        }

        $usedBy = Database::fetchAll('SELECT id, title FROM events WHERE logo_image_id = ? OR join_logo_image_id = ?', [$imageId, $imageId]);
        $force = ((string)($_GET['force'] ?? '0')) === '1';
        if ($usedBy && !$force) {
            jsonResponse([
                'error' => 'Image is currently used by ' . count($usedBy) . ' event(s).',
                'in_use' => true,
                'events' => $usedBy,
            ], 409);
        }

        if ($usedBy) {
            Database::execute('UPDATE events SET logo_image_id = NULL, state_version = state_version + 1 WHERE logo_image_id = ?', [$imageId]);
            Database::execute('UPDATE events SET join_logo_image_id = NULL, state_version = state_version + 1 WHERE join_logo_image_id = ?', [$imageId]);
        }
        Database::execute('DELETE FROM media_images WHERE id = ?', [$imageId]);
        ImageBank::deleteImageFiles($img);
        ImageBank::syncUseCounts();
        Audit::log(null, (int)$user['id'], $user['display_name'], 'image_deleted', "Deleted image {$img['label']} (#{$imageId})");
        jsonResponse(['ok' => true]);
    }

    public static function listAccounts(): void
    {
        Auth::requireApiAuth(['super_admin'], false);
        $admins = Database::fetchAll(
            'SELECT id, username, display_name, email, role, status, event_scope, must_change_password, last_login, created_at FROM admins ORDER BY id ASC'
        );
        $assignments = Database::fetchAll('SELECT admin_id, event_id FROM admin_event_access');
        $map = [];
        foreach ($assignments as $a) {
            $map[(int)$a['admin_id']][] = (int)$a['event_id'];
        }
        foreach ($admins as &$adm) {
            $adm['id'] = (int)$adm['id'];
            $adm['must_change_password'] = (int)$adm['must_change_password'] === 1;
            $adm['event_ids'] = $map[$adm['id']] ?? [];
        }
        unset($adm);
        jsonResponse(['accounts' => $admins]);
    }

    public static function createAccount(): void
    {
        $actor = Auth::requireApiAuth(['super_admin'], true);
        $in = jsonInput();
        $username = Validator::slug((string)($in['username'] ?? ''));
        $displayName = Validator::cleanText((string)($in['display_name'] ?? ''), 100);
        $email = Validator::cleanText((string)($in['email'] ?? ''), 190);
        $role = (string)($in['role'] ?? 'host');
        $password = (string)($in['password'] ?? '');
        $eventScope = ($in['event_scope'] ?? 'all') === 'assigned' ? 'assigned' : 'all';
        $eventIds = is_array($in['event_ids'] ?? null) ? $in['event_ids'] : [];

        if ($username === '' || $displayName === '') {
            jsonResponse(['error' => 'Username and display name are required.'], 422);
        }
        if (!in_array($role, ['super_admin', 'host', 'moderator'], true)) {
            jsonResponse(['error' => 'Invalid role.'], 422);
        }
        $pwErr = Validator::validatePasswordStrength($password);
        if ($pwErr !== null) {
            jsonResponse(['error' => $pwErr], 422);
        }
        if (Database::fetchOne('SELECT id FROM admins WHERE username = ?', [$username]) !== null) {
            jsonResponse(['error' => 'Username already exists.'], 409);
        }

        Database::execute(
            'INSERT INTO admins (username, display_name, email, password_hash, role, status, event_scope, must_change_password, created_by, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)',
            [$username, $displayName, $email, password_hash($password, PASSWORD_DEFAULT), $role, 'active', $eventScope, (int)$actor['id'], utcNow()]
        );
        $newId = Database::lastInsertId();
        if ($eventScope === 'assigned') {
            foreach ($eventIds as $eid) {
                $eidInt = (int)$eid;
                if ($eidInt > 0) {
                    Database::execute('INSERT INTO admin_event_access (admin_id, event_id) VALUES (?, ?)', [$newId, $eidInt]);
                }
            }
        }
        Audit::log(null, (int)$actor['id'], $actor['display_name'], 'account_created', "Created {$role} account {$username}");
        jsonResponse(['ok' => true, 'id' => $newId], 201);
    }

    public static function updateAccount(int $accountId): void
    {
        $actor = Auth::requireApiAuth(['super_admin'], true);
        $target = Database::fetchOne('SELECT * FROM admins WHERE id = ?', [$accountId]);
        if ($target === null) {
            jsonResponse(['error' => 'Account not found.'], 404);
        }
        $in = jsonInput();
        $displayName = isset($in['display_name']) ? Validator::cleanText((string)$in['display_name'], 100) : $target['display_name'];
        $email = isset($in['email']) ? Validator::cleanText((string)$in['email'], 190) : $target['email'];
        $role = isset($in['role']) && in_array($in['role'], ['super_admin', 'host', 'moderator'], true) ? $in['role'] : $target['role'];
        $status = isset($in['status']) && in_array($in['status'], ['active', 'disabled'], true) ? $in['status'] : $target['status'];
        $eventScope = isset($in['event_scope']) && in_array($in['event_scope'], ['all', 'assigned'], true) ? $in['event_scope'] : $target['event_scope'];

        if ((int)$actor['id'] === $accountId && ($status !== 'active' || $role !== 'super_admin')) {
            jsonResponse(['error' => 'You cannot disable yourself or demote your own Super Admin role.'], 422);
        }

        Database::execute(
            'UPDATE admins SET display_name = ?, email = ?, role = ?, status = ?, event_scope = ? WHERE id = ?',
            [$displayName, $email, $role, $status, $eventScope, $accountId]
        );
        if ($status !== 'active') {
            Auth::revokeAllForAdmin($accountId);
        }
        if (array_key_exists('event_ids', $in) && is_array($in['event_ids'])) {
            Database::execute('DELETE FROM admin_event_access WHERE admin_id = ?', [$accountId]);
            if ($eventScope === 'assigned') {
                foreach ($in['event_ids'] as $eid) {
                    $eidInt = (int)$eid;
                    if ($eidInt > 0) {
                        Database::execute('INSERT INTO admin_event_access (admin_id, event_id) VALUES (?, ?)', [$accountId, $eidInt]);
                    }
                }
            }
        }
        Audit::log(null, (int)$actor['id'], $actor['display_name'], 'account_updated', "Updated account {$target['username']} ({$role}, {$status})");
        jsonResponse(['ok' => true]);
    }

    public static function resetAccountPassword(int $accountId): void
    {
        $actor = Auth::requireApiAuth(['super_admin'], true);
        $target = Database::fetchOne('SELECT username FROM admins WHERE id = ?', [$accountId]);
        if ($target === null) {
            jsonResponse(['error' => 'Account not found.'], 404);
        }
        $in = jsonInput();
        $pw = (string)($in['password'] ?? '');
        $err = Validator::validatePasswordStrength($pw);
        if ($err !== null) {
            jsonResponse(['error' => $err], 422);
        }
        Database::execute(
            'UPDATE admins SET password_hash = ?, must_change_password = 1 WHERE id = ?',
            [password_hash($pw, PASSWORD_DEFAULT), $accountId]
        );
        Auth::revokeAllForAdmin($accountId);
        Audit::log(null, (int)$actor['id'], $actor['display_name'], 'account_password_reset', "Reset password for {$target['username']}");
        jsonResponse(['ok' => true]);
    }

    public static function revokeAccountSessions(int $accountId): void
    {
        $actor = Auth::requireApiAuth(['super_admin'], true);
        $target = Database::fetchOne('SELECT username FROM admins WHERE id = ?', [$accountId]);
        if ($target === null) {
            jsonResponse(['error' => 'Account not found.'], 404);
        }
        Auth::revokeAllForAdmin($accountId);
        Audit::log(null, (int)$actor['id'], $actor['display_name'], 'account_sessions_revoked', "Revoked sessions for {$target['username']}");
        jsonResponse(['ok' => true]);
    }

    public static function deleteAccount(int $accountId): void
    {
        $actor = Auth::requireApiAuth(['super_admin'], true);
        if ((int)$actor['id'] === $accountId) {
            jsonResponse(['error' => 'You cannot delete your own account.'], 422);
        }
        $target = Database::fetchOne('SELECT username FROM admins WHERE id = ?', [$accountId]);
        if ($target === null) {
            jsonResponse(['error' => 'Account not found.'], 404);
        }
        Database::execute('DELETE FROM admins WHERE id = ?', [$accountId]);
        Audit::log(null, (int)$actor['id'], $actor['display_name'], 'account_deleted', "Deleted account {$target['username']}");
        jsonResponse(['ok' => true]);
    }

    public static function auditLog(): void
    {
        Auth::requireApiAuth(['super_admin'], false);
        $eventId = isset($_GET['event_id']) && $_GET['event_id'] !== '' ? (int)$_GET['event_id'] : null;
        $action = trim((string)($_GET['action'] ?? ''));
        $q = trim((string)($_GET['q'] ?? ''));

        $where = ['1=1'];
        $params = [];
        if ($eventId !== null) {
            $where[] = 'al.event_id = ?';
            $params[] = $eventId;
        }
        if ($action !== '') {
            $where[] = 'al.action = ?';
            $params[] = $action;
        }
        if ($q !== '') {
            $where[] = '(LOWER(al.admin_name) LIKE LOWER(?) OR LOWER(al.details) LIKE LOWER(?) OR LOWER(al.action) LIKE LOWER(?))';
            $like = '%' . $q . '%';
            $params[] = $like;
            $params[] = $like;
            $params[] = $like;
        }

        $rows = Database::fetchAll(
            'SELECT al.*, e.title AS event_title
             FROM audit_log al
             LEFT JOIN events e ON e.id = al.event_id
             WHERE ' . implode(' AND ', $where) . '
             ORDER BY al.id DESC LIMIT 200',
            $params
        );
        jsonResponse(['logs' => $rows]);
    }

    public static function getTurnConfig(): void
    {
        Auth::requireApiAuth(['super_admin'], false);
        jsonResponse(self::buildTurnStatusPayload());
    }

    private static function maskKeyId(string $val): string
    {
        $len = strlen($val);
        if ($len <= 8) {
            return str_repeat('*', $len);
        }
        return substr($val, 0, 4) . '...' . substr($val, -4);
    }

    private static function buildTurnStatusPayload(): array
    {
        $override = Bootstrap::readTurnOverride();
        $cf = Bootstrap::effectiveCloudflareConfig();
        $static = Bootstrap::effectiveStaticTurnConfig();

        $mode = 'none';
        $source = 'none';
        if ($cf !== null) {
            $mode = 'cloudflare';
            $source = $cf['source'];
        } elseif (!empty($static['urls'])) {
            $mode = 'static';
            $source = $static['source'];
        } elseif ($override !== null) {
            $source = 'db';
        }

        return [
            'mode' => $mode,
            'source' => $source,
            'configured' => Bootstrap::turnConfigured(),
            'error' => Bootstrap::turnError(),
            'cf_key_preview' => $cf !== null ? self::maskKeyId($cf['key_id']) : '',
            'cf_ttl' => $cf !== null ? (int)$cf['ttl'] : 86400,
            'has_cf_token' => $cf !== null,
            'turn_url' => !empty($static['urls']) ? implode(', ', $static['urls']) : '',
            'turn_user' => $static['user'] ?? '',
            'has_turn_pass' => !empty($static['pass']),
        ];
    }

    public static function updateTurnConfig(): void
    {
        $actor = Auth::requireApiAuth(['super_admin'], true);
        $in = jsonInput();
        $action = trim((string)($in['action'] ?? 'save'));

        if ($action === 'clear') {
            Database::execute("DELETE FROM system_settings WHERE setting_key = 'turn_config'");
            Bootstrap::clearTurnCache();
            Audit::log(null, (int)$actor['id'], $actor['display_name'], 'turn_config_cleared', 'Cleared saved TURN override');
            jsonResponse([
                'ok' => true,
                'message' => 'Saved TURN override cleared. Falling back to .env configuration.',
                'status' => self::buildTurnStatusPayload(),
            ]);
        }

        $mode = trim((string)($in['mode'] ?? 'cloudflare'));
        $existing = Bootstrap::readTurnOverride();

        if ($mode === 'cloudflare') {
            $keyId = trim((string)($in['cf_key_id'] ?? ''));
            $token = trim((string)($in['cf_api_token'] ?? ''));
            $ttl = max(60, min(86400, (int)($in['cf_ttl'] ?? 86400)));

            if ($token === '' && is_array($existing) && ($existing['mode'] ?? '') === 'cloudflare' && ($existing['cf_key_id'] ?? '') === $keyId) {
                $token = trim((string)($existing['cf_api_token'] ?? ''));
            }
            if (Bootstrap::isPlaceholderSecret($keyId) || Bootstrap::isPlaceholderSecret($token)) {
                jsonResponse(['error' => 'Both Cloudflare TURN Token ID and API Token are required.'], 422);
            }

            $test = Bootstrap::requestCloudflareIceServers($keyId, $token, $ttl);
            if (!$test['ok']) {
                $err = (string)$test['error'];
                $extra = stripos($err, 'cannot find specified key') !== false
                    ? ' Make sure you copied the TURN Token ID under Cloudflare Dashboard → Realtime → TURN (do not use your Account ID or Realtime SFU App ID, and ensure the Token belongs to that same TURN key).'
                    : '';
                jsonResponse(['error' => "Cloudflare rejected credentials ({$err}).{$extra}"], 400);
            }

            $payload = [
                'mode' => 'cloudflare',
                'cf_key_id' => $keyId,
                'cf_api_token' => $token,
                'cf_ttl' => $ttl,
            ];
            Database::upsert('system_settings', ['setting_key' => 'turn_config'], [
                'setting_value' => json_encode($payload, JSON_UNESCAPED_SLASHES),
                'updated_at' => utcNow(),
            ]);

            $cacheKey = hash('sha256', $keyId . ':' . $token . ':' . $ttl);
            @file_put_contents(Bootstrap::rootPath('storage/cf_turn_cache.json'), json_encode([
                'key' => $cacheKey,
                'servers' => $test['servers'],
                'expires_at' => time() + min(43200, max(30, (int)($ttl * 0.5))),
                'fail_until' => 0,
                'last_error' => '',
            ]));

            Audit::log(null, (int)$actor['id'], $actor['display_name'], 'turn_config_updated', 'Verified and saved Cloudflare Realtime TURN key (' . self::maskKeyId($keyId) . ')');
            jsonResponse([
                'ok' => true,
                'ice_count' => count($test['servers']),
                'message' => 'Cloudflare TURN verified and saved (' . count($test['servers']) . ' ICE entries generated).',
                'status' => [
                    'mode' => 'cloudflare',
                    'source' => 'db',
                    'configured' => true,
                    'error' => '',
                    'cf_key_preview' => self::maskKeyId($keyId),
                    'cf_ttl' => $ttl,
                    'has_cf_token' => true,
                    'turn_url' => '',
                    'turn_user' => '',
                    'has_turn_pass' => false,
                ],
            ]);
        }

        if ($mode === 'static') {
            $rawUrls = trim((string)($in['turn_url'] ?? ''));
            $urls = array_values(array_filter(array_map('trim', explode(',', $rawUrls)), fn($u) => Bootstrap::isValidIceUrl($u)));
            $user = trim((string)($in['turn_user'] ?? ''));
            $pass = trim((string)($in['turn_pass'] ?? ''));
            if ($pass === '' && is_array($existing) && ($existing['mode'] ?? '') === 'static') {
                $pass = trim((string)($existing['turn_pass'] ?? ''));
            }
            if (!$urls) {
                jsonResponse(['error' => 'Enter at least one valid turn: or turns: URL (e.g. turns:turn.example.com:5349?transport=tcp).'], 422);
            }
            if (Bootstrap::isPlaceholderSecret($user) || Bootstrap::isPlaceholderSecret($pass)) {
                jsonResponse(['error' => 'Static TURN Username and Credential are required.'], 422);
            }

            $payload = [
                'mode' => 'static',
                'turn_url' => implode(',', $urls),
                'turn_user' => $user,
                'turn_pass' => $pass,
            ];
            Database::upsert('system_settings', ['setting_key' => 'turn_config'], [
                'setting_value' => json_encode($payload, JSON_UNESCAPED_SLASHES),
                'updated_at' => utcNow(),
            ]);
            Bootstrap::clearTurnCache();
            Audit::log(null, (int)$actor['id'], $actor['display_name'], 'turn_config_updated', 'Saved static TURN configuration');
            jsonResponse([
                'ok' => true,
                'message' => 'Static TURN configuration saved.',
                'status' => [
                    'mode' => 'static',
                    'source' => 'db',
                    'configured' => true,
                    'error' => '',
                    'cf_key_preview' => '',
                    'cf_ttl' => 86400,
                    'has_cf_token' => false,
                    'turn_url' => implode(', ', $urls),
                    'turn_user' => $user,
                    'has_turn_pass' => true,
                ],
            ]);
        }

        jsonResponse(['error' => 'Unsupported TURN mode.'], 422);
    }
}
