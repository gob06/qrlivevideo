<?php
declare(strict_types=1);

return [
    'max_upload_bytes' => 2 * 1024 * 1024, // 2 MB
    'max_image_dim' => 4096,
    'normalized_logo_dim' => 512,
    'thumb_logo_dim' => 160,
    'max_wall_slots' => 4,
    'poll_interval_idle_ms' => 2000,
    'poll_interval_fast_ms' => 700,
    'admin_poll_ms' => 1500,
    'thumbnail_interval_ms' => 3000,
    'wall_offline_threshold_sec' => 10,
    'participant_stale_sec' => 120,
    'signal_ttl_sec' => 60,
    'stats_ttl_sec' => 120,
    'cleanup_probability' => 8, // ~8% of poll/api requests run light GC
];
