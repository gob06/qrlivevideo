<?php
declare(strict_types=1);

/**
 * Optional CLI cleanup script for cron jobs.
 * Probabilistic cleanup also runs automatically on requests in Cleanup::maybeRun().
 */

require_once __DIR__ . '/src/Bootstrap.php';

use App\Bootstrap;
use App\Cleanup;

Bootstrap::init();
Cleanup::run();

if (PHP_SAPI === 'cli') {
    echo "Cleanup complete at " . gmdate('Y-m-d H:i:s') . " UTC\n";
}
