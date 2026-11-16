<?php
declare(strict_types=1);

/**
 * One-time installer / migration script.
 * Works via CLI (`php install.php`) or web browser (`https://your-domain/install.php`),
 * then locks itself by writing `storage/install.lock`.
 */

require_once __DIR__ . '/src/Bootstrap.php';

use App\Bootstrap;
use App\Database;
use function App\utcNow;

Bootstrap::init();

$lockFile = Bootstrap::rootPath('storage/install.lock');
if (is_file($lockFile)) {
    http_response_code(403);
    $msg = 'Installer is locked (storage/install.lock exists). Delete install.php on production.';
    if (PHP_SAPI === 'cli') {
        fwrite(STDERR, $msg . PHP_EOL);
        exit(1);
    }
    echo '<!doctype html><html><body style="font-family:sans-serif;background:#0f172a;color:#f8fafc;padding:2rem;"><h1>Installer Locked</h1><p>' . htmlspecialchars($msg) . '</p></body></html>';
    exit;
}

if (PHP_SAPI !== 'cli' && strtoupper($_SERVER['REQUEST_METHOD'] ?? 'GET') === 'GET') {
    echo '<!doctype html><html><head><meta charset="utf-8"><title>QR Live Wall Installer</title></head>
    <body style="font-family:system-ui,sans-serif;background:#0b1120;color:#e2e8f0;padding:2rem;max-width:600px;margin:2rem auto;">
    <h1>QR Live Wall — Setup</h1>
    <p>Driver: <strong>' . htmlspecialchars(Bootstrap::env('DB_DRIVER', 'sqlite')) . '</strong></p>
    <p>This will create all database tables, seed the Super Admin from <code>.env</code>, and lock the installer.</p>
    <form method="post"><button type="submit" style="padding:12px 20px;background:#ef4444;color:#fff;border:none;border-radius:8px;font-weight:600;cursor:pointer;">Run Installation &amp; Lock</button></form>
    </body></html>';
    exit;
}

try {
    $driver = Database::driver();
    $schemaPath = $driver === 'mysql'
        ? Bootstrap::rootPath('schema.mariadb.sql')
        : Bootstrap::rootPath('schema.sqlite.sql');

    $sql = file_get_contents($schemaPath);
    if ($sql === false) {
        throw new RuntimeException('Schema file not found: ' . $schemaPath);
    }

    $pdo = Database::pdo();
    // Execute statements individually so both SQLite and MySQL PDO handle multi-statement scripts reliably
    $statements = array_filter(array_map('trim', preg_split('/;\s*(\r?\n|$)/', $sql) ?: []));
    foreach ($statements as $stmt) {
        if ($stmt === '' || str_starts_with($stmt, '--')) {
            continue;
        }
        $pdo->exec($stmt);
    }

    // Seed initial Super Admin if not present
    $adminUser = Bootstrap::env('SEED_ADMIN_USER', 'superadmin');
    $adminName = Bootstrap::env('SEED_ADMIN_NAME', 'Event Director');
    $adminEmail = Bootstrap::env('SEED_ADMIN_EMAIL', 'admin@example.com');
    $adminPass = Bootstrap::env('SEED_ADMIN_PASS', 'ChangeMeNow!2026');

    $existing = Database::fetchOne('SELECT id FROM admins WHERE username = ?', [$adminUser]);
    if ($existing === null) {
        Database::execute(
            'INSERT INTO admins (username, display_name, email, password_hash, role, status, event_scope, must_change_password, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)',
            [
                $adminUser,
                $adminName,
                $adminEmail,
                password_hash($adminPass, PASSWORD_DEFAULT),
                'super_admin',
                'active',
                'all',
                utcNow(),
            ]
        );
    }

    if (!is_dir(dirname($lockFile))) {
        mkdir(dirname($lockFile), 0750, true);
    }
    file_put_contents($lockFile, 'Installed at ' . utcNow() . " UTC\n");

    $doneMsg = "Installation complete ({$driver}). Super Admin '{$adminUser}' is ready. Installer is now locked; please delete install.php on production.";
    if (PHP_SAPI === 'cli') {
        echo $doneMsg . PHP_EOL;
    } else {
        echo '<!doctype html><html><body style="font-family:system-ui,sans-serif;background:#0b1120;color:#e2e8f0;padding:2rem;max-width:600px;margin:2rem auto;">
        <h1>Installation Complete</h1><p>' . htmlspecialchars($doneMsg) . '</p>
        <p><a href="/admin/login" style="color:#60a5fa;">Go to Admin Login &rarr;</a></p></body></html>';
    }
} catch (Throwable $e) {
    http_response_code(500);
    $err = 'Install failed: ' . $e->getMessage();
    if (PHP_SAPI === 'cli') {
        fwrite(STDERR, $err . PHP_EOL);
        exit(1);
    }
    echo '<!doctype html><html><body style="font-family:sans-serif;background:#111;color:#fca5a5;padding:2rem;"><h1>Error</h1><pre>' . htmlspecialchars($err) . '</pre></body></html>';
}
