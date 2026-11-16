<?php
declare(strict_types=1);

namespace App;

class RateLimiter
{
    public static function check(string $bucket, int $maxHits, int $windowSec): bool
    {
        $now = time();
        $row = Database::fetchOne('SELECT hits, window_start FROM rate_limits WHERE bucket_key = ?', [$bucket]);
        if ($row === null || ($now - (int)$row['window_start']) >= $windowSec) {
            Database::upsert('rate_limits', ['bucket_key' => $bucket], [
                'hits' => 1,
                'window_start' => $now,
            ]);
            return true;
        }

        $hits = (int)$row['hits'] + 1;
        Database::execute('UPDATE rate_limits SET hits = ? WHERE bucket_key = ?', [$hits, $bucket]);
        return $hits <= $maxHits;
    }

    public static function requireLimit(string $bucket, int $maxHits, int $windowSec): void
    {
        if (!self::check($bucket, $maxHits, $windowSec)) {
            jsonResponse(['error' => 'Too many requests. Please slow down.'], 429);
        }
    }
}
