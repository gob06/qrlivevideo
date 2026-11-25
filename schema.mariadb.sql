SET NAMES utf8mb4;
SET time_zone = '+00:00';

CREATE TABLE IF NOT EXISTS admins (
    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    username VARCHAR(64) NOT NULL UNIQUE,
    display_name VARCHAR(100) NOT NULL,
    email VARCHAR(190) NOT NULL DEFAULT '',
    password_hash VARCHAR(255) NOT NULL,
    role ENUM('super_admin', 'host', 'moderator') NOT NULL,
    status ENUM('active', 'disabled') NOT NULL DEFAULT 'active',
    event_scope ENUM('all', 'assigned') NOT NULL DEFAULT 'all',
    must_change_password TINYINT(1) NOT NULL DEFAULT 0,
    last_login DATETIME DEFAULT NULL,
    created_by INT UNSIGNED DEFAULT NULL,
    created_at DATETIME NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS admin_sessions (
    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    admin_id INT UNSIGNED NOT NULL,
    session_token_hash CHAR(64) NOT NULL UNIQUE,
    csrf_token CHAR(64) NOT NULL,
    current_event_id INT UNSIGNED DEFAULT NULL,
    last_seen DATETIME NOT NULL,
    ip_hash CHAR(64) NOT NULL DEFAULT '',
    user_agent VARCHAR(255) NOT NULL DEFAULT '',
    revoked TINYINT(1) NOT NULL DEFAULT 0,
    created_at DATETIME NOT NULL,
    expires_at DATETIME NOT NULL,
    INDEX idx_admin_sessions_admin (admin_id, revoked),
    INDEX idx_admin_sessions_event (current_event_id, last_seen),
    CONSTRAINT fk_sessions_admin FOREIGN KEY (admin_id) REFERENCES admins(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS media_images (
    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    filename VARCHAR(120) NOT NULL,
    original_name VARCHAR(255) NOT NULL,
    label VARCHAR(120) NOT NULL,
    tags VARCHAR(255) NOT NULL DEFAULT '',
    file_hash CHAR(64) NOT NULL,
    mime_type VARCHAR(64) NOT NULL,
    width INT UNSIGNED NOT NULL DEFAULT 0,
    height INT UNSIGNED NOT NULL DEFAULT 0,
    size INT UNSIGNED NOT NULL DEFAULT 0,
    thumb_path VARCHAR(160) NOT NULL,
    visibility ENUM('shared', 'private') NOT NULL DEFAULT 'shared',
    is_default TINYINT(1) NOT NULL DEFAULT 0,
    uploaded_by INT UNSIGNED DEFAULT NULL,
    use_count INT UNSIGNED NOT NULL DEFAULT 0,
    created_at DATETIME NOT NULL,
    INDEX idx_media_hash (file_hash),
    CONSTRAINT fk_media_uploader FOREIGN KEY (uploaded_by) REFERENCES admins(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS events (
    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    slug VARCHAR(100) NOT NULL UNIQUE,
    title VARCHAR(150) NOT NULL,
    wall_key VARCHAR(100) NOT NULL,
    status ENUM('active', 'closed') NOT NULL DEFAULT 'active',
    join_locked TINYINT(1) NOT NULL DEFAULT 0,
    max_participants INT UNSIGNED NOT NULL DEFAULT 100,
    max_wall_feeds TINYINT UNSIGNED NOT NULL DEFAULT 4,
    layout ENUM('single', 'split2', 'grid4', 'pip') NOT NULL DEFAULT 'single',
    show_labels TINYINT(1) NOT NULL DEFAULT 1,
    audio_enabled TINYINT(1) NOT NULL DEFAULT 0,
    blackout TINYINT(1) NOT NULL DEFAULT 0,
    wall_fit_mode ENUM('fit', 'fill', 'stretch') NOT NULL DEFAULT 'fit',
    wall_tile_bg ENUM('blur', 'solid', 'transparent') NOT NULL DEFAULT 'blur',
    wall_tile_bg_color VARCHAR(20) NOT NULL DEFAULT '#090d16',
    mirror_front_wall TINYINT(1) NOT NULL DEFAULT 0,
    wall_qr_side_enabled TINYINT(1) NOT NULL DEFAULT 1,
    wall_qr_hidden TINYINT(1) NOT NULL DEFAULT 0,
    wall_qr_side ENUM('right', 'left') NOT NULL DEFAULT 'right',
    wall_qr_size SMALLINT UNSIGNED NOT NULL DEFAULT 480,
    wall_qr_valign ENUM('center', 'top') NOT NULL DEFAULT 'center',
    wall_qr_bg_color VARCHAR(20) NOT NULL DEFAULT '#090d16',
    wall_qr_bg_opacity TINYINT UNSIGNED NOT NULL DEFAULT 100,
    wall_qr_show_title TINYINT(1) NOT NULL DEFAULT 1,
    logo_image_id INT UNSIGNED DEFAULT NULL,
    join_logo_image_id INT UNSIGNED DEFAULT NULL,
    qr_logo_shape ENUM('square', 'circle') NOT NULL DEFAULT 'square',
    qr_logo_fit ENUM('contain', 'cover') NOT NULL DEFAULT 'contain',
    qr_logo_scale TINYINT UNSIGNED NOT NULL DEFAULT 18,
    qr_logo_padding TINYINT UNSIGNED NOT NULL DEFAULT 8,
    qr_logo_bg VARCHAR(20) NOT NULL DEFAULT '#ffffff',
    qr_fg VARCHAR(20) NOT NULL DEFAULT '#000000',
    qr_bg VARCHAR(20) NOT NULL DEFAULT '#ffffff',
    state_version INT UNSIGNED NOT NULL DEFAULT 1,
    last_action_by VARCHAR(100) NOT NULL DEFAULT '',
    last_action_summary VARCHAR(200) NOT NULL DEFAULT '',
    last_action_at DATETIME DEFAULT NULL,
    peak_concurrent INT UNSIGNED NOT NULL DEFAULT 0,
    total_joined INT UNSIGNED NOT NULL DEFAULT 0,
    total_kicked_banned INT UNSIGNED NOT NULL DEFAULT 0,
    created_by INT UNSIGNED DEFAULT NULL,
    created_at DATETIME NOT NULL,
    CONSTRAINT fk_events_logo FOREIGN KEY (logo_image_id) REFERENCES media_images(id) ON DELETE SET NULL,
    CONSTRAINT fk_events_join_logo FOREIGN KEY (join_logo_image_id) REFERENCES media_images(id) ON DELETE SET NULL,
    CONSTRAINT fk_events_creator FOREIGN KEY (created_by) REFERENCES admins(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS admin_event_access (
    admin_id INT UNSIGNED NOT NULL,
    event_id INT UNSIGNED NOT NULL,
    PRIMARY KEY (admin_id, event_id),
    CONSTRAINT fk_aea_admin FOREIGN KEY (admin_id) REFERENCES admins(id) ON DELETE CASCADE,
    CONSTRAINT fk_aea_event FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS participants (
    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    event_id INT UNSIGNED NOT NULL,
    session_token VARCHAR(96) NOT NULL UNIQUE,
    display_name VARCHAR(80) NOT NULL,
    message VARCHAR(160) NOT NULL DEFAULT '',
    name_hidden TINYINT(1) NOT NULL DEFAULT 0,
    muted_by_admin TINYINT(1) NOT NULL DEFAULT 0,
    status ENUM('waiting', 'onair', 'removed', 'banned', 'left') NOT NULL DEFAULT 'waiting',
    preview_admin_id INT UNSIGNED DEFAULT NULL,
    preview_requested_at DATETIME DEFAULT NULL,
    last_seen DATETIME NOT NULL,
    joined_at DATETIME NOT NULL,
    thumbnail_data MEDIUMTEXT DEFAULT NULL,
    thumb_version INT UNSIGNED NOT NULL DEFAULT 0,
    facing_mode VARCHAR(24) NOT NULL DEFAULT '',
    capture_settings TEXT DEFAULT NULL,
    ip_hash CHAR(64) NOT NULL DEFAULT '',
    user_agent VARCHAR(255) NOT NULL DEFAULT '',
    INDEX idx_participants_event_status (event_id, status, last_seen),
    CONSTRAINT fk_part_event FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE,
    CONSTRAINT fk_part_preview_admin FOREIGN KEY (preview_admin_id) REFERENCES admins(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS wall_slots (
    event_id INT UNSIGNED NOT NULL,
    slot_no TINYINT UNSIGNED NOT NULL,
    participant_id INT UNSIGNED NOT NULL,
    fit_mode ENUM('fit', 'fill', 'stretch') DEFAULT NULL,
    updated_at DATETIME NOT NULL,
    PRIMARY KEY (event_id, slot_no),
    CONSTRAINT fk_ws_event FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE,
    CONSTRAINT fk_ws_part FOREIGN KEY (participant_id) REFERENCES participants(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS signals (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    event_id INT UNSIGNED NOT NULL,
    participant_id INT UNSIGNED NOT NULL,
    target_id VARCHAR(64) NOT NULL DEFAULT 'obs',
    direction ENUM('to_viewer', 'to_audience') NOT NULL,
    type VARCHAR(32) NOT NULL,
    payload MEDIUMTEXT NOT NULL,
    created_at DATETIME NOT NULL,
    consumed TINYINT(1) NOT NULL DEFAULT 0,
    INDEX idx_signals_lookup (event_id, target_id, direction, consumed, id),
    INDEX idx_signals_part (event_id, participant_id, direction, consumed, id),
    CONSTRAINT fk_sig_event FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE,
    CONSTRAINT fk_sig_part FOREIGN KEY (participant_id) REFERENCES participants(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS stream_stats (
    event_id INT UNSIGNED NOT NULL,
    participant_id INT UNSIGNED NOT NULL,
    reporter VARCHAR(32) NOT NULL DEFAULT 'wall',
    state VARCHAR(32) NOT NULL DEFAULT 'new',
    width INT UNSIGNED NOT NULL DEFAULT 0,
    height INT UNSIGNED NOT NULL DEFAULT 0,
    fps DECIMAL(5,1) NOT NULL DEFAULT 0,
    bitrate INT UNSIGNED NOT NULL DEFAULT 0,
    packet_loss DECIMAL(5,2) NOT NULL DEFAULT 0,
    rtt DECIMAL(7,1) NOT NULL DEFAULT 0,
    relay_type VARCHAR(32) NOT NULL DEFAULT 'unknown',
    reported_at DATETIME NOT NULL,
    PRIMARY KEY (event_id, participant_id, reporter),
    CONSTRAINT fk_stats_event FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE,
    CONSTRAINT fk_stats_part FOREIGN KEY (participant_id) REFERENCES participants(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS wall_heartbeats (
    event_id INT UNSIGNED NOT NULL,
    viewer_id VARCHAR(64) NOT NULL,
    is_primary TINYINT(1) NOT NULL DEFAULT 0,
    last_seen DATETIME NOT NULL,
    resolution VARCHAR(32) NOT NULL DEFAULT '',
    version VARCHAR(32) NOT NULL DEFAULT '',
    PRIMARY KEY (event_id, viewer_id),
    CONSTRAINT fk_wh_event FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS audit_log (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    event_id INT UNSIGNED DEFAULT NULL,
    admin_id INT UNSIGNED DEFAULT NULL,
    admin_name VARCHAR(100) NOT NULL DEFAULT '',
    action VARCHAR(64) NOT NULL,
    details TEXT NOT NULL,
    ip_hash CHAR(64) NOT NULL DEFAULT '',
    created_at DATETIME NOT NULL,
    INDEX idx_audit_created (created_at),
    INDEX idx_audit_event (event_id, created_at),
    CONSTRAINT fk_audit_event FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE SET NULL,
    CONSTRAINT fk_audit_admin FOREIGN KEY (admin_id) REFERENCES admins(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS bans (
    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    event_id INT UNSIGNED NOT NULL,
    ip_hash CHAR(64) NOT NULL DEFAULT '',
    session_token VARCHAR(96) NOT NULL DEFAULT '',
    display_name VARCHAR(80) NOT NULL DEFAULT '',
    reason VARCHAR(200) NOT NULL DEFAULT '',
    banned_by INT UNSIGNED DEFAULT NULL,
    created_at DATETIME NOT NULL,
    INDEX idx_bans_event (event_id, ip_hash, session_token),
    CONSTRAINT fk_bans_event FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE,
    CONSTRAINT fk_bans_admin FOREIGN KEY (banned_by) REFERENCES admins(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS rate_limits (
    bucket_key VARCHAR(128) PRIMARY KEY,
    hits INT UNSIGNED NOT NULL DEFAULT 1,
    window_start INT UNSIGNED NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS event_timeline (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    event_id INT UNSIGNED NOT NULL,
    kind VARCHAR(32) NOT NULL,
    message VARCHAR(255) NOT NULL,
    created_at DATETIME NOT NULL,
    INDEX idx_timeline_event (event_id, id),
    CONSTRAINT fk_tl_event FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS system_settings (
    setting_key VARCHAR(80) PRIMARY KEY,
    setting_value TEXT NOT NULL,
    updated_at DATETIME NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
