<?php
use function App\e;
/** @var array $appConfig */
?><!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>QR Live Wall — Admin Console</title>
  <link rel="stylesheet" href="/assets/css/common.css">
  <link rel="stylesheet" href="/assets/css/admin.css">
</head>
<body class="adm-body">
  <script id="app-config" type="application/json"><?= json_encode($appConfig, JSON_UNESCAPED_SLASHES | JSON_HEX_TAG | JSON_HEX_AMP) ?></script>

  <div class="adm-shell">
    <header class="adm-topbar">
      <a href="/admin/events" class="adm-brand" data-nav="/admin/events">QR Live Wall</a>

      <nav class="adm-nav" aria-label="Main Navigation">
        <a href="/admin/events" class="adm-nav-link" data-nav="/admin/events">Events</a>
        <a href="/admin/images" class="adm-nav-link" data-nav="/admin/images">Image Bank</a>
        <?php if ($appConfig['user']['role'] === 'super_admin'): ?>
          <a href="/admin/accounts" class="adm-nav-link" data-nav="/admin/accounts">Accounts</a>
          <a href="/admin/audit" class="adm-nav-link" data-nav="/admin/audit">Audit Log</a>
        <?php endif; ?>
      </nav>

      <div class="adm-top-actions">
        <span class="adm-user-meta"><?= e($appConfig['user']['display_name']) ?> · <?= e(str_replace('_', ' ', $appConfig['user']['role'])) ?></span>
        <button type="button" class="btn btn-secondary btn-sm" id="adm-logout-all-btn" title="Revoke all sessions">Log out everywhere</button>
        <form method="post" action="/admin/logout" class="inline-form">
          <input type="hidden" name="csrf_token" value="<?= e($appConfig['csrfToken']) ?>">
          <button type="submit" class="btn btn-ghost btn-sm">Sign Out</button>
        </form>
      </div>
    </header>

    <main class="adm-main" id="adm-main">
      <div class="adm-loading">Loading studio console...</div>
    </main>
  </div>

  <div class="adm-modal-backdrop" id="adm-modal-backdrop" hidden>
    <div class="adm-modal" id="adm-modal" role="dialog" aria-modal="true"></div>
  </div>

  <div class="adm-toast-stack" id="adm-toast-stack" aria-live="polite"></div>

  <script type="module" src="/assets/js/admin.js"></script>
</body>
</html>
