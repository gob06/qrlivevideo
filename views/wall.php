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
      <!-- Unified Jumbotron 2-Panel Stage (Idle QR-only & Live Video + Side QR) -->
      <div class="wall-live-layout" id="wall-live-layout" data-qr-side="right">
        <section class="wall-video-area" id="wall-video-area">
          <div class="wall-idle-prompt" id="wall-idle-prompt">
            <span>SCAN TO SEE YOUR LIVE CAMERA ON THE JUMBOTRON.</span>
          </div>
          <section class="wall-grid layout-single" id="wall-grid" hidden></section>
        </section>

        <aside class="wall-qr-panel is-panel-open" id="wall-qr-panel" aria-label="Join QR Panel">
          <div class="wall-qr-panel-inner valign-center" id="wall-qr-panel-inner">
            <div class="wall-panel-logo-wrap" id="wall-panel-logo-wrap" hidden>
              <img class="wall-panel-logo" id="wall-panel-logo" alt="">
            </div>
            <div class="wall-qr-panel-box" id="wall-panel-box">
              <canvas id="wall-qr-side-canvas" width="500" height="500"></canvas>
              <div class="wall-qr-status-msg" id="wall-panel-status" hidden></div>
            </div>
          </div>
        </aside>
      </div>

      <!-- Optional Corner QR while Live (?qr=corner) -->
      <aside class="wall-qr-corner" id="wall-qr-corner" hidden>
        <div class="wall-corner-logo-wrap" id="wall-corner-logo-wrap" hidden>
          <img class="wall-corner-logo" id="wall-corner-logo" alt="">
        </div>
        <div class="wall-qr-corner-box">
          <canvas id="wall-qr-corner-canvas" width="440" height="440"></canvas>
          <div class="wall-qr-status-msg wall-qr-status-corner" id="wall-corner-status" hidden></div>
        </div>
      </aside>

      <!-- Blackout Curtain -->
      <div class="wall-blackout" id="wall-blackout" hidden></div>
    </main>
  </div>

  <script type="module" src="/assets/js/wall.js?v=<?= e(\App\Bootstrap::assetVersion()) ?>"></script>
</body>
</html>
