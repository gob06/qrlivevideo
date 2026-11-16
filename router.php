<?php
declare(strict_types=1);

$uri = parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH) ?: '/';
$publicFile = __DIR__ . '/public' . $uri;

if ($uri !== '/' && is_file($publicFile)) {
    $ext = strtolower(pathinfo($publicFile, PATHINFO_EXTENSION));
    if ($ext !== 'php') {
        return false; // Let PHP built-in server serve static assets
    }
}

require __DIR__ . '/public/index.php';
