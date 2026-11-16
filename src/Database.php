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

        return self::$pdo;
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
