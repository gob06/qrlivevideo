<?php
declare(strict_types=1);

namespace App;

use DOMDocument;
use DOMElement;
use DOMNode;

class ImageBank
{
    public static function uploadDir(): string
    {
        $dir = Bootstrap::rootPath('public/uploads/logos');
        if (!is_dir($dir)) {
            mkdir($dir, 0755, true);
        }
        return $dir;
    }

    public static function quotaBytes(): int
    {
        $mb = max(10, (int)Bootstrap::env('IMAGE_BANK_QUOTA_MB', '200'));
        return $mb * 1024 * 1024;
    }

    public static function usedBytes(): int
    {
        $row = Database::fetchOne('SELECT COALESCE(SUM(size), 0) AS total FROM media_images');
        return (int)($row['total'] ?? 0);
    }

    public static function syncUseCounts(): void
    {
        Database::execute(
            'UPDATE media_images SET use_count = (SELECT COUNT(*) FROM events WHERE events.logo_image_id = media_images.id)'
        );
    }

    public static function processUpload(array $file, int $adminId, string $visibility = 'shared', string $tags = ''): array
    {
        $err = (int)($file['error'] ?? UPLOAD_ERR_NO_FILE);
        if ($err !== UPLOAD_ERR_OK) {
            return ['ok' => false, 'error' => 'Upload error code: ' . $err];
        }

        $tmp = (string)($file['tmp_name'] ?? '');
        $origName = Validator::cleanText((string)($file['name'] ?? 'logo'), 200);
        $size = (int)($file['size'] ?? 0);
        $maxBytes = Bootstrap::$config['max_upload_bytes'];

        if ($size <= 0 || $size > $maxBytes) {
            return ['ok' => false, 'error' => 'File must be between 1 byte and 2 MB.'];
        }
        if (!is_uploaded_file($tmp)) {
            return ['ok' => false, 'error' => 'Invalid upload source.'];
        }

        $rawBytes = file_get_contents($tmp);
        if ($rawBytes === false) {
            return ['ok' => false, 'error' => 'Could not read uploaded file.'];
        }

        $finfo = new \finfo(FILEINFO_MIME_TYPE);
        $mime = (string)$finfo->file($tmp);

        $allowed = ['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml', 'text/plain', 'application/xml', 'text/xml'];
        if (!in_array($mime, $allowed, true)) {
            return ['ok' => false, 'error' => 'Unsupported file type (' . $mime . '). Allowed: PNG, JPG, WebP, SVG.'];
        }

        $isSvg = false;
        if (in_array($mime, ['image/svg+xml', 'text/plain', 'application/xml', 'text/xml'], true)) {
            if (!str_contains(strtolower($rawBytes), '<svg')) {
                return ['ok' => false, 'error' => 'File is not a valid image or SVG.'];
            }
            $isSvg = true;
            $mime = 'image/svg+xml';
        }

        $hash = hash('sha256', $rawBytes);
        $existing = Database::fetchOne(
            "SELECT * FROM media_images WHERE file_hash = ? AND (visibility = 'shared' OR uploaded_by = ?) LIMIT 1",
            [$hash, $adminId]
        );
        if ($existing !== null) {
            return ['ok' => true, 'duplicate' => true, 'image' => $existing];
        }

        $quota = self::quotaBytes();
        if (self::usedBytes() + $size > $quota) {
            return ['ok' => false, 'error' => 'Image Bank storage quota exceeded.'];
        }

        $rand = bin2hex(random_bytes(16));
        $dir = self::uploadDir();
        $label = pathinfo($origName, PATHINFO_FILENAME) ?: 'Logo';
        $label = Validator::cleanText($label, 100);
        $vis = $visibility === 'private' ? 'private' : 'shared';

        if ($isSvg) {
            $cleanSvg = self::sanitizeSvg($rawBytes);
            if ($cleanSvg === null) {
                return ['ok' => false, 'error' => 'SVG failed security validation or is malformed XML.'];
            }
            $filename = $rand . '.svg';
            $dest = $dir . '/' . $filename;
            file_put_contents($dest, $cleanSvg);
            $finalSize = filesize($dest) ?: strlen($cleanSvg);
            $thumbPath = $filename;
            $width = 512;
            $height = 512;
        } else {
            $info = @getimagesizefromstring($rawBytes);
            if ($info === false) {
                return ['ok' => false, 'error' => 'Corrupted raster image.'];
            }
            $srcW = (int)$info[0];
            $srcH = (int)$info[1];
            $maxDim = Bootstrap::$config['max_image_dim'];
            if ($srcW <= 0 || $srcH <= 0 || $srcW > $maxDim || $srcH > $maxDim) {
                return ['ok' => false, 'error' => "Image dimensions must be between 1x1 and {$maxDim}x{$maxDim}."];
            }

            if (extension_loaded('gd')) {
                $srcImg = @imagecreatefromstring($rawBytes);
                if (!$srcImg) {
                    return ['ok' => false, 'error' => 'Unable to decode raster image.'];
                }
                $normDim = Bootstrap::$config['normalized_logo_dim'];
                [$dstImg, $width, $height] = self::resizeGd($srcImg, $srcW, $srcH, $normDim);
                $filename = $rand . '.png';
                $dest = $dir . '/' . $filename;
                imagepng($dstImg, $dest, 6);
                imagedestroy($dstImg);

                $thumbDim = Bootstrap::$config['thumb_logo_dim'];
                [$tImg] = self::resizeGd($srcImg, $srcW, $srcH, $thumbDim);
                $thumbFilename = $rand . '_thumb.png';
                imagepng($tImg, $dir . '/' . $thumbFilename, 6);
                imagedestroy($tImg);
                imagedestroy($srcImg);

                $thumbPath = $thumbFilename;
                $mime = 'image/png';
                $finalSize = (int)filesize($dest) + (int)filesize($dir . '/' . $thumbFilename);
            } else {
                $ext = match ($mime) {
                    'image/png' => 'png',
                    'image/webp' => 'webp',
                    default => 'jpg',
                };
                $filename = $rand . '.' . $ext;
                $dest = $dir . '/' . $filename;
                file_put_contents($dest, $rawBytes);
                $thumbPath = $filename;
                $width = $srcW;
                $height = $srcH;
                $finalSize = strlen($rawBytes);
            }
        }

        Database::execute(
            'INSERT INTO media_images (filename, original_name, label, tags, file_hash, mime_type, width, height, size, thumb_path, visibility, is_default, uploaded_by, use_count, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, 0, ?)',
            [
                $filename,
                $origName,
                $label,
                Validator::cleanText($tags, 200),
                $hash,
                $mime,
                $width,
                $height,
                $finalSize,
                $thumbPath,
                $vis,
                $adminId,
                utcNow(),
            ]
        );
        $id = Database::lastInsertId();
        $row = Database::fetchOne('SELECT * FROM media_images WHERE id = ?', [$id]);
        return ['ok' => true, 'duplicate' => false, 'image' => $row];
    }

    private static function resizeGd($srcImg, int $srcW, int $srcH, int $maxBox): array
    {
        $scale = min(1.0, $maxBox / max($srcW, $srcH));
        $dstW = max(1, (int)round($srcW * $scale));
        $dstH = max(1, (int)round($srcH * $scale));
        $dst = imagecreatetruecolor($dstW, $dstH);
        imagealphablending($dst, false);
        imagesavealpha($dst, true);
        $transparent = imagecolorallocatealpha($dst, 0, 0, 0, 127);
        imagefilledrectangle($dst, 0, 0, $dstW, $dstH, $transparent);
        imagecopyresampled($dst, $srcImg, 0, 0, 0, 0, $dstW, $dstH, $srcW, $srcH);
        return [$dst, $dstW, $dstH];
    }

    public static function sanitizeSvg(string $raw): ?string
    {
        $raw = preg_replace('/<!DOCTYPE[^>]*>/i', '', $raw) ?? $raw;
        $raw = preg_replace('/<!ENTITY[^>]*>/i', '', $raw) ?? $raw;

        $prev = libxml_use_internal_errors(true);
        $dom = new DOMDocument('1.0', 'UTF-8');
        $loaded = $dom->loadXML($raw, LIBXML_NONET | LIBXML_NOERROR | LIBXML_NOWARNING);
        libxml_clear_errors();
        libxml_use_internal_errors($prev);

        if (!$loaded || !$dom->documentElement || strtolower($dom->documentElement->nodeName) !== 'svg') {
            return null;
        }

        $blockedTags = ['script', 'foreignobject', 'iframe', 'object', 'embed', 'applet', 'meta', 'link', 'base', 'audio', 'video'];
        self::sanitizeSvgNode($dom->documentElement, $blockedTags);

        return $dom->saveXML($dom->documentElement) ?: null;
    }

    private static function sanitizeSvgNode(DOMNode $node, array $blockedTags): void
    {
        $toRemove = [];
        foreach ($node->childNodes as $child) {
            if ($child instanceof DOMElement) {
                $tag = strtolower($child->localName ?? $child->nodeName);
                if (in_array($tag, $blockedTags, true)) {
                    $toRemove[] = $child;
                    continue;
                }
                self::sanitizeSvgNode($child, $blockedTags);
            }
        }
        foreach ($toRemove as $rem) {
            $node->removeChild($rem);
        }

        if ($node instanceof DOMElement && $node->hasAttributes()) {
            $badAttrs = [];
            foreach ($node->attributes as $attr) {
                $name = strtolower($attr->nodeName);
                $val = trim($attr->nodeValue);
                if (str_starts_with($name, 'on')) {
                    $badAttrs[] = $attr->nodeName;
                    continue;
                }
                if (in_array($name, ['href', 'xlink:href', 'src'], true)) {
                    if ($val !== '' && !str_starts_with($val, '#')) {
                        $badAttrs[] = $attr->nodeName;
                        continue;
                    }
                }
                if (preg_match('/(javascript:|data:text\/html|expression\s*\(|url\s*\(\s*["\']?\s*https?:)/i', $val)) {
                    $badAttrs[] = $attr->nodeName;
                }
            }
            foreach ($badAttrs as $attrName) {
                $node->removeAttribute($attrName);
            }
        }
    }

    public static function deleteImageFiles(array $img): void
    {
        $dir = self::uploadDir();
        $main = $dir . '/' . basename($img['filename']);
        $thumb = $dir . '/' . basename($img['thumb_path']);
        if (is_file($main)) {
            @unlink($main);
        }
        if ($thumb !== $main && is_file($thumb)) {
            @unlink($thumb);
        }
    }
}
