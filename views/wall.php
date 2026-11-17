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
  <script id="app-config" type="application/json"><?= json_encode($config, JSON_UNESCAPED_SLASHES | JSON_HEX_TAG | JSON_HEX_AMP) ?></script>

  <main class="wall-stage" id="wall-stage">
    <!-- Idle QR view -->
    <section class="wall-qr-idle" id="wall-qr-idle">
      <div class="wall-qr-card" id="wall-qr-card">
        <div class="wall-qr-eyebrow" id="wall-event-title"><?= e($config['eventTitle']) ?></div>
        <div class="wall-qr-canvas-wrap">
          <canvas id="wall-qr-canvas" width="1360" height="1360"></canvas>
        </div>
        <div class="wall-qr-cta">Scan to join the live wall</div>
      </div>
    </section>

    <!-- Live Participant Grid -->
    <section class="wall-grid layout-single" id="wall-grid" hidden></section>

    <!-- Optional Corner QR while Live -->
    <aside class="wall-qr-corner" id="wall-qr-corner" hidden>
      <canvas id="wall-qr-corner-canvas" width="440" height="440"></canvas>
      <div class="wall-qr-corner-label">Scan to join</div>
    </aside>

    <!-- Blackout Curtain -->
    <div class="wall-blackout" id="wall-blackout" hidden></div>
  </main>

  <script type="module" src="/assets/js/wall.js?v=<?= e(\App\Bootstrap::assetVersion()) ?>"></script>
</body>
</html>
