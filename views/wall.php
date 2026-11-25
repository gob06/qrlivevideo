<?php
use function App\e;
/** @var array $config */
$bgClass = 'wall-bg-' . $config['bg'];
?><!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title><?= e($config['eventTitle']) ?> — Wall</title>
  <link rel="stylesheet" href="/assets/css/wall.css?v=<?= e(\App\Bootstrap::assetVersion()) ?>">
</head>
<body class="wall-body <?= e($bgClass) ?>">
  <script id="app-config" type="application/json"><?= json_encode($config, JSON_UNESCAPED_SLASHES | JSON_HEX_TAG | JSON_HEX_AMP | JSON_INVALID_UTF8_SUBSTITUTE) ?></script>

  <div class="wall-viewport" id="wall-viewport">
    <main class="wall-stage" id="wall-stage">
      <!-- Live 2-column CSS Grid (Video Area + Side QR Panel) -->
      <div class="wall-live-layout" id="wall-live-layout" data-qr-side="right">
        <section class="wall-video-area" id="wall-video-area">
          <section class="wall-grid layout-single" id="wall-grid"></section>
        </section>

        <aside class="wall-qr-panel" id="wall-qr-panel" aria-label="Join QR Panel">
          <div class="wall-qr-panel-inner valign-center" id="wall-qr-panel-inner">
            <div class="wall-qr-panel-title" id="wall-panel-title"><?= e($config['eventTitle']) ?></div>
            <div class="wall-qr-panel-box" id="wall-panel-box">
              <canvas id="wall-qr-side-canvas" width="480" height="480"></canvas>
              <div class="wall-qr-status-msg" id="wall-panel-status" hidden></div>
            </div>
            <div class="wall-qr-panel-cta" id="wall-panel-cta">Scan to join the live</div>
          </div>
        </aside>
      </div>

      <!-- Idle QR view -->
      <section class="wall-qr-idle" id="wall-qr-idle">
        <div class="wall-qr-card" id="wall-qr-card">
          <div class="wall-qr-eyebrow" id="wall-event-title"><?= e($config['eventTitle']) ?></div>
          <div class="wall-qr-canvas-wrap" id="wall-idle-canvas-wrap">
            <canvas id="wall-qr-canvas" width="1360" height="1360"></canvas>
            <div class="wall-qr-status-msg wall-qr-status-idle" id="wall-idle-status" hidden></div>
          </div>
          <div class="wall-qr-cta">Scan to join the live</div>
        </div>
      </section>

      <!-- Optional Corner QR while Live (?qr=corner) -->
      <aside class="wall-qr-corner" id="wall-qr-corner" hidden>
        <canvas id="wall-qr-corner-canvas" width="440" height="440"></canvas>
        <div class="wall-qr-status-msg wall-qr-status-corner" id="wall-corner-status" hidden></div>
        <div class="wall-qr-corner-label">Scan to join the live</div>
      </aside>

      <!-- Blackout Curtain -->
      <div class="wall-blackout" id="wall-blackout" hidden></div>
    </main>
  </div>

  <script type="module" src="/assets/js/wall.js?v=<?= e(\App\Bootstrap::assetVersion()) ?>"></script>
</body>
</html>
