<?php
declare(strict_types=1);

namespace App;

use PDO;
use PDOException;

class Database
{
    private static ?PDO $pdo = null;
    private static string $driver = 'sqlite';

    public static function pdo(): PDO
    {
        if (self::$pdo !== null) {
            return self::$pdo;
        }

        self::$driver = strtolower(Bootstrap::env('DB_DRIVER', 'sqlite'));
        $options = [
            PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
            PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
            PDO::ATTR_EMULATE_PREPARES => false,
        ];

        if (self::$driver === 'mysql') {
            $host = Bootstrap::env('DB_HOST', 'localhost');
            $port = Bootstrap::env('DB_PORT', '3306');
            $name = Bootstrap::env('DB_NAME', 'qrlivewall');
            $user = Bootstrap::env('DB_USER', 'root');
            $pass = Bootstrap::env('DB_PASS', '');
            $dsn = "mysql:host={$host};port={$port};dbname={$name};charset=utf8mb4";
            self::$pdo = new PDO($dsn, $user, $pass, $options);
            self::$pdo->exec("SET time_zone = '+00:00'");
        } else {
            $rel = Bootstrap::env('DB_SQLITE_PATH', 'storage/local.sqlite');
            $path = str_starts_with($rel, '/') ? $rel : Bootstrap::rootPath($rel);
            $dir = dirname($path);
            if (!is_dir($dir)) {
                mkdir($dir, 0750, true);
            }
            self::$pdo = new PDO('sqlite:' . $path, null, null, $options);
            self::$pdo->exec('PRAGMA foreign_keys = ON;');
            self::$pdo->exec('PRAGMA journal_mode = WAL;');
            self::$pdo->exec('PRAGMA busy_timeout = 5000;');
        }

        self::ensureSchemaMigrations(self::$pdo, self::$driver);
        return self::$pdo;
    }

    private static function ensureSchemaMigrations(PDO $pdo, string $driver): void
    {
        $flag = Bootstrap::rootPath('storage/schema_v4.migrated');
        if (is_file($flag)) {
            return;
        }
        try {
            if ($driver === 'mysql') {
                $tbl = $pdo->query("SHOW TABLES LIKE 'events'")->fetch();
                if (!$tbl) {
                    return;
                }
                $addMySqlCol = static function (string $table, string $col, string $def) use ($pdo): void {
                    if (!$pdo->query("SHOW COLUMNS FROM {$table} LIKE '{$col}'")->fetch()) {
                        $pdo->exec("ALTER TABLE {$table} ADD COLUMN {$col} {$def}");
                    }
                };
                $addMySqlCol('events', 'join_logo_image_id', 'INT UNSIGNED DEFAULT NULL AFTER logo_image_id');
                $addMySqlCol('events', 'wall_fit_mode', "ENUM('fit', 'fill', 'stretch') NOT NULL DEFAULT 'fit' AFTER blackout");
                $addMySqlCol('events', 'wall_tile_bg', "ENUM('blur', 'solid', 'transparent') NOT NULL DEFAULT 'blur' AFTER wall_fit_mode");
                $addMySqlCol('events', 'wall_tile_bg_color', "VARCHAR(20) NOT NULL DEFAULT '#090d16' AFTER wall_tile_bg");
                $addMySqlCol('events', 'mirror_front_wall', 'TINYINT(1) NOT NULL DEFAULT 0 AFTER wall_tile_bg_color');
                $addMySqlCol('participants', 'facing_mode', "VARCHAR(24) NOT NULL DEFAULT '' AFTER thumb_version");
                $addMySqlCol('participants', 'capture_settings', 'TEXT DEFAULT NULL AFTER facing_mode');
                $addMySqlCol('wall_slots', 'fit_mode', "ENUM('fit', 'fill', 'stretch') DEFAULT NULL AFTER participant_id");
                $pdo->exec('CREATE TABLE IF NOT EXISTS system_settings (
                    setting_key VARCHAR(80) PRIMARY KEY,
                    setting_value TEXT NOT NULL,
                    updated_at DATETIME NOT NULL
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci');
            } else {
                $tbl = $pdo->query("SELECT name FROM sqlite_master WHERE type='table' AND name='events'")->fetch();
                if (!$tbl) {
                    return;
                }
                $addSqliteCol = static function (string $table, string $col, string $def) use ($pdo): void {
                    $cols = $pdo->query("PRAGMA table_info({$table})")->fetchAll();
                    foreach ($cols as $c) {
                        if (($c['name'] ?? '') === $col) {
                            return;
                        }
                    }
                    $pdo->exec("ALTER TABLE {$table} ADD COLUMN {$col} {$def}");
                };
                $addSqliteCol('events', 'join_logo_image_id', 'INTEGER DEFAULT NULL');
                $addSqliteCol('events', 'wall_fit_mode', "TEXT NOT NULL DEFAULT 'fit'");
                $addSqliteCol('events', 'wall_tile_bg', "TEXT NOT NULL DEFAULT 'blur'");
                $addSqliteCol('events', 'wall_tile_bg_color', "TEXT NOT NULL DEFAULT '#090d16'");
                $addSqliteCol('events', 'mirror_front_wall', 'INTEGER NOT NULL DEFAULT 0');
                $addSqliteCol('participants', 'facing_mode', "TEXT NOT NULL DEFAULT ''");
                $addSqliteCol('participants', 'capture_settings', "TEXT NOT NULL DEFAULT ''");
                $addSqliteCol('wall_slots', 'fit_mode', 'TEXT DEFAULT NULL');
                $pdo->exec("CREATE TABLE IF NOT EXISTS system_settings (
                    setting_key TEXT PRIMARY KEY,
                    setting_value TEXT NOT NULL DEFAULT '',
                    updated_at TEXT NOT NULL
                )");
            }
            @file_put_contents($flag, "ok\n");
        } catch (PDOException $e) {
            // Ignore transient permission/race errors
        }
    }

    public static function driver(): string
    {
        self::pdo();
        return self::$driver;
    }

    public static function fetchOne(string $sql, array $params = []): ?array
    {
        $stmt = self::pdo()->prepare($sql);
        $stmt->execute($params);
        $row = $stmt->fetch();
        return $row === false ? null : $row;
    }

    public static function fetchAll(string $sql, array $params = []): array
    {
        $stmt = self::pdo()->prepare($sql);
        $stmt->execute($params);
        return $stmt->fetchAll();
    }

    public static function execute(string $sql, array $params = []): int
    {
        $stmt = self::pdo()->prepare($sql);
        $stmt->execute($params);
        return $stmt->rowCount();
    }

    public static function lastInsertId(): int
    {
        return (int)self::pdo()->lastInsertId();
    }

    /**
     * Driver-agnostic upsert keyed on explicit equality columns.
     */
    public static function upsert(string $table, array $keyCols, array $dataCols): void
    {
        self::pdo();
        $whereParts = [];
        $whereParams = [];
        foreach ($keyCols as $col => $val) {
            $whereParts[] = "{$col} = ?";
            $whereParams[] = $val;
        }
        $whereSql = implode(' AND ', $whereParts);
        $existing = self::fetchOne("SELECT 1 FROM {$table} WHERE {$whereSql}", $whereParams);

        if ($existing !== null) {
            $setParts = [];
            $params = [];
            foreach ($dataCols as $col => $val) {
                $setParts[] = "{$col} = ?";
                $params[] = $val;
            }
            $params = array_merge($params, $whereParams);
            self::execute("UPDATE {$table} SET " . implode(', ', $setParts) . " WHERE {$whereSql}", $params);
        } else {
            $all = array_merge($keyCols, $dataCols);
            $cols = array_keys($all);
            $placeholders = implode(', ', array_fill(0, count($cols), '?'));
            try {
                self::execute(
                    "INSERT INTO {$table} (" . implode(', ', $cols) . ") VALUES ({$placeholders})",
                    array_values($all)
                );
            } catch (PDOException $e) {
                $setParts = [];
                $params = [];
                foreach ($dataCols as $col => $val) {
                    $setParts[] = "{$col} = ?";
                    $params[] = $val;
                }
                $params = array_merge($params, $whereParams);
                self::execute("UPDATE {$table} SET " . implode(', ', $setParts) . " WHERE {$whereSql}", $params);
            }
        }
    }
}
