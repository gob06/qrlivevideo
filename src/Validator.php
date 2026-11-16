<?php
declare(strict_types=1);

namespace App;

class Validator
{
    public static function slug(string $input): string
    {
        $s = strtolower(trim($input));
        $s = preg_replace('/[^a-z0-9-]+/', '-', $s) ?? '';
        $s = trim($s, '-');
        return substr($s, 0, 80);
    }

    public static function cleanText(string $input, int $maxLen): string
    {
        $s = trim($input);
        $s = preg_replace('/[\x00-\x1F\x7F]/u', '', $s) ?? '';
        if (function_exists('mb_substr')) {
            return mb_substr($s, 0, $maxLen, 'UTF-8');
        }
        return substr($s, 0, $maxLen);
    }

    public static function hexColor(string $input, string $fallback = '#000000', bool $allowTransparent = false): string
    {
        $v = strtolower(trim($input));
        if ($allowTransparent && $v === 'transparent') {
            return 'transparent';
        }
        if (preg_match('/^#[0-9a-f]{6}$/', $v)) {
            return $v;
        }
        return $fallback;
    }

    public static function relativeLuminance(string $hex): float
    {
        $hex = ltrim($hex, '#');
        $r = hexdec(substr($hex, 0, 2)) / 255.0;
        $g = hexdec(substr($hex, 2, 2)) / 255.0;
        $b = hexdec(substr($hex, 4, 2)) / 255.0;

        $lin = static function (float $c): float {
            return $c <= 0.03928 ? $c / 12.92 : (($c + 0.055) / 1.055) ** 2.4;
        };
        return 0.2126 * $lin($r) + 0.7152 * $lin($g) + 0.0722 * $lin($b);
    }

    public static function contrastRatio(string $fgHex, string $bgHex): float
    {
        $l1 = self::relativeLuminance($fgHex);
        $l2 = self::relativeLuminance($bgHex);
        $lighter = max($l1, $l2);
        $darker = min($l1, $l2);
        return ($lighter + 0.05) / ($darker + 0.05);
    }

    public static function filterProfanity(string $name): string
    {
        $raw = Bootstrap::env('PROFANITY_LIST', '');
        if ($raw === '') {
            return $name;
        }
        $words = array_filter(array_map('trim', explode(',', $raw)));
        foreach ($words as $word) {
            if ($word === '') {
                continue;
            }
            $pattern = '/\b' . preg_quote($word, '/') . '\b/iu';
            $replacement = str_repeat('*', max(3, strlen($word)));
            $name = preg_replace($pattern, $replacement, $name) ?? $name;
        }
        return $name;
    }

    public static function validatePasswordStrength(string $pw): ?string
    {
        if (strlen($pw) < 10) {
            return 'Password must be at least 10 characters long.';
        }
        if (!preg_match('/[A-Z]/', $pw) || !preg_match('/[a-z]/', $pw) || !preg_match('/[0-9]/', $pw)) {
            return 'Password must include uppercase, lowercase, and at least one number.';
        }
        return null;
    }
}
