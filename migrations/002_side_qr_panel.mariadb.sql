-- Migration 002: Side QR Panel settings on events (MariaDB / MySQL)
-- Safe to run once on an existing QR Live Wall MariaDB database.

ALTER TABLE events
  ADD COLUMN wall_qr_side_enabled TINYINT(1) NOT NULL DEFAULT 1 AFTER mirror_front_wall,
  ADD COLUMN wall_qr_hidden TINYINT(1) NOT NULL DEFAULT 0 AFTER wall_qr_side_enabled,
  ADD COLUMN wall_qr_side ENUM('right', 'left') NOT NULL DEFAULT 'right' AFTER wall_qr_hidden,
  ADD COLUMN wall_qr_size SMALLINT UNSIGNED NOT NULL DEFAULT 500 AFTER wall_qr_side,
  ADD COLUMN wall_qr_valign ENUM('center', 'top') NOT NULL DEFAULT 'center' AFTER wall_qr_size,
  ADD COLUMN wall_qr_bg_color VARCHAR(20) NOT NULL DEFAULT '#021048' AFTER wall_qr_valign,
  ADD COLUMN wall_qr_bg_opacity TINYINT UNSIGNED NOT NULL DEFAULT 100 AFTER wall_qr_bg_color,
  ADD COLUMN wall_qr_show_title TINYINT(1) NOT NULL DEFAULT 1 AFTER wall_qr_bg_opacity;
