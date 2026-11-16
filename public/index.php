<?php
declare(strict_types=1);

require_once dirname(__DIR__) . '/src/Bootstrap.php';

use App\Auth;
use App\Bootstrap;
use App\Controllers\AdminApiController;
use App\Controllers\AudienceApiController;
use App\Controllers\PageController;
use App\Controllers\WallApiController;
use function App\jsonResponse;

Bootstrap::init();

$method = strtoupper($_SERVER['REQUEST_METHOD'] ?? 'GET');
$uriPath = parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH) ?: '/';
$path = '/' . trim($uriPath, '/');
if ($path !== '/') {
    $path = rtrim($path, '/');
}

Bootstrap::sendSecurityHeaders(true);

try {
    if ($path === '/' && $method === 'GET') {
        header('Location: /admin');
        exit;
    }

    // Audience Join Page
    if (preg_match('#^/join/([a-z0-9-]+)$#', $path, $m) && $method === 'GET') {
        PageController::renderAudience($m[1]);
        exit;
    }

    // OBS Wall Page
    if (preg_match('#^/wall/([a-z0-9-]+)$#', $path, $m) && $method === 'GET') {
        PageController::renderWall($m[1]);
        exit;
    }

    // Admin Auth Pages
    if ($path === '/admin' && $method === 'GET') {
        header('Location: ' . (Auth::current() !== null ? '/admin/events' : '/admin/login'));
        exit;
    }
    if ($path === '/admin/login' && $method === 'GET') {
        PageController::showLogin();
        exit;
    }
    if ($path === '/admin/login' && $method === 'POST') {
        PageController::handleLogin();
        exit;
    }
    if ($path === '/admin/logout' && $method === 'POST') {
        PageController::handleLogout();
        exit;
    }
    if ($path === '/admin/change-password' && $method === 'GET') {
        PageController::showChangePassword();
        exit;
    }
    if ($path === '/admin/change-password' && $method === 'POST') {
        PageController::handleChangePassword();
        exit;
    }

    // Printable QR page
    if (preg_match('#^/admin/events/(\d+)/print-qr$#', $path, $m) && $method === 'GET') {
        PageController::renderPrintQr((int)$m[1]);
        exit;
    }

    // Admin SPA Shell routes
    if (
        $path === '/admin/events' ||
        $path === '/admin/images' ||
        $path === '/admin/accounts' ||
        $path === '/admin/audit' ||
        preg_match('#^/admin/events/\d+(/monitor)?$#', $path)
    ) {
        if ($method === 'GET') {
            PageController::renderAdminApp($path);
            exit;
        }
    }

    // Audience API
    if ($path === '/api/audience/join' && $method === 'POST') {
        AudienceApiController::join();
    }
    if ($path === '/api/audience/thumbnail' && $method === 'POST') {
        AudienceApiController::thumbnail();
    }
    if ($path === '/api/audience/poll' && $method === 'GET') {
        AudienceApiController::poll();
    }
    if ($path === '/api/audience/stream' && $method === 'GET') {
        AudienceApiController::stream();
    }
    if ($path === '/api/audience/signal' && $method === 'POST') {
        AudienceApiController::signal();
    }
    if ($path === '/api/audience/stats' && $method === 'POST') {
        AudienceApiController::stats();
    }
    if ($path === '/api/audience/leave' && $method === 'POST') {
        AudienceApiController::leave();
    }

    // Wall API
    if ($path === '/api/wall/poll' && $method === 'GET') {
        WallApiController::poll();
    }
    if ($path === '/api/wall/stream' && $method === 'GET') {
        WallApiController::stream();
    }
    if ($path === '/api/wall/signal' && $method === 'POST') {
        WallApiController::signal();
    }
    if ($path === '/api/wall/stats' && $method === 'POST') {
        WallApiController::stats();
    }

    // Admin API
    if ($path === '/api/admin/me' && $method === 'GET') {
        AdminApiController::me();
    }
    if ($path === '/api/admin/logout-everywhere' && $method === 'POST') {
        AdminApiController::logoutEverywhere();
    }
    if ($path === '/api/admin/events' && $method === 'GET') {
        AdminApiController::listEvents();
    }
    if ($path === '/api/admin/events' && $method === 'POST') {
        AdminApiController::createEvent();
    }
    if (preg_match('#^/api/admin/events/(\d+)/settings$#', $path, $m) && $method === 'POST') {
        AdminApiController::updateEventSettings((int)$m[1]);
    }
    if (preg_match('#^/api/admin/events/(\d+)$#', $path, $m) && $method === 'DELETE') {
        AdminApiController::deleteEvent((int)$m[1]);
    }
    if (preg_match('#^/api/admin/events/(\d+)/state$#', $path, $m) && $method === 'GET') {
        AdminApiController::eventState((int)$m[1]);
    }
    if (preg_match('#^/api/admin/events/(\d+)/participants/(\d+)/thumb$#', $path, $m) && $method === 'GET') {
        AdminApiController::participantThumb((int)$m[1], (int)$m[2]);
    }
    if (preg_match('#^/api/admin/events/(\d+)/wall-action$#', $path, $m) && $method === 'POST') {
        AdminApiController::wallAction((int)$m[1]);
    }
    if (preg_match('#^/api/admin/events/(\d+)/participant-action$#', $path, $m) && $method === 'POST') {
        AdminApiController::participantAction((int)$m[1]);
    }
    if (preg_match('#^/api/admin/events/(\d+)/preview-poll$#', $path, $m) && $method === 'GET') {
        AdminApiController::previewPoll((int)$m[1]);
    }
    if (preg_match('#^/api/admin/events/(\d+)/preview-signal$#', $path, $m) && $method === 'POST') {
        AdminApiController::previewSignal((int)$m[1]);
    }

    // Image Bank API
    if ($path === '/api/admin/images' && $method === 'GET') {
        AdminApiController::listImages();
    }
    if ($path === '/api/admin/images/upload' && $method === 'POST') {
        AdminApiController::uploadImages();
    }
    if (preg_match('#^/api/admin/images/(\d+)$#', $path, $m) && $method === 'POST') {
        AdminApiController::updateImage((int)$m[1]);
    }
    if (preg_match('#^/api/admin/images/(\d+)/replace-everywhere$#', $path, $m) && $method === 'POST') {
        AdminApiController::replaceImageEverywhere((int)$m[1]);
    }
    if (preg_match('#^/api/admin/images/(\d+)$#', $path, $m) && $method === 'DELETE') {
        AdminApiController::deleteImage((int)$m[1]);
    }

    // Accounts API (Super Admin)
    if ($path === '/api/admin/accounts' && $method === 'GET') {
        AdminApiController::listAccounts();
    }
    if ($path === '/api/admin/accounts' && $method === 'POST') {
        AdminApiController::createAccount();
    }
    if (preg_match('#^/api/admin/accounts/(\d+)$#', $path, $m) && $method === 'POST') {
        AdminApiController::updateAccount((int)$m[1]);
    }
    if (preg_match('#^/api/admin/accounts/(\d+)/reset-password$#', $path, $m) && $method === 'POST') {
        AdminApiController::resetAccountPassword((int)$m[1]);
    }
    if (preg_match('#^/api/admin/accounts/(\d+)/revoke-sessions$#', $path, $m) && $method === 'POST') {
        AdminApiController::revokeAccountSessions((int)$m[1]);
    }
    if (preg_match('#^/api/admin/accounts/(\d+)$#', $path, $m) && $method === 'DELETE') {
        AdminApiController::deleteAccount((int)$m[1]);
    }

    // Audit Log API (Super Admin)
    if ($path === '/api/admin/audit' && $method === 'GET') {
        AdminApiController::auditLog();
    }

    if (str_starts_with($path, '/api/')) {
        jsonResponse(['error' => 'Endpoint not found.'], 404);
    }

    http_response_code(404);
    echo '<!doctype html><html><body style="background:#0b1120;color:#e2e8f0;font-family:sans-serif;padding:2rem;"><h1>404 Not Found</h1></body></html>';
} catch (Throwable $e) {
    $debug = Bootstrap::env('APP_DEBUG', 'false') === 'true';
    error_log('[QRLW] ' . $e->getMessage() . ' in ' . $e->getFile() . ':' . $e->getLine());
    if (str_starts_with($path, '/api/')) {
        jsonResponse(['error' => $debug ? $e->getMessage() : 'Internal server error.'], 500);
    }
    http_response_code(500);
    echo $debug ? '<pre>' . htmlspecialchars($e->getMessage()) . '</pre>' : '<h1>Server Error</h1>';
}
