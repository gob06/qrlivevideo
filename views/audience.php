<?php
use function App\e;
/** @var array $config */
?><!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover">
  <title><?= e($config['eventTitle']) ?> — Join Live Wall</title>
  <link rel="stylesheet" href="/assets/css/common.css?v=<?= e(\App\Bootstrap::assetVersion()) ?>">
  <link rel="stylesheet" href="/assets/css/audience.css?v=<?= e(\App\Bootstrap::assetVersion()) ?>">
</head>
<body class="aud-body">
  <script id="app-config" type="application/json"><?= json_encode($config, JSON_UNESCAPED_SLASHES | JSON_HEX_TAG | JSON_HEX_AMP | JSON_INVALID_UTF8_SUBSTITUTE) ?></script>

  <main class="aud-shell">
    <header class="aud-header">
      <div class="aud-event-title" id="aud-event-title"><?= e($config['eventTitle']) ?></div>
      <div class="aud-status-bar status-waiting" id="aud-status-banner" hidden>
        <span class="status-dot" id="aud-status-dot"></span>
        <span id="aud-status-text">Waiting in lobby</span>
      </div>
    </header>

    <section class="aud-inapp-warning" id="aud-inapp-warning" hidden>
      <p><strong>In-app browser detected.</strong> Camera access often fails inside social apps. Open this page in <strong>Safari</strong> or <strong>Chrome</strong>.</p>
      <button type="button" class="btn btn-secondary" id="aud-copy-link">Copy Page Link</button>
    </section>

    <section class="aud-card" id="aud-step-join">
      <div class="aud-brand-wrap" id="aud-brand-wrap"<?= !empty($config['brandLogoUrl']) ? '' : ' hidden' ?>>
        <img id="aud-brand-img" src="<?= !empty($config['brandLogoUrl']) ? e($config['brandLogoUrl']) : '' ?>" alt="<?= e($config['eventTitle']) ?> branding">
      </div>
      <h1 class="aud-heading">Join the Live Screen</h1>
      <p class="aud-sub">Share your camera reaction with the venue screen. Your video only streams live if the host puts you on air.</p>

      <div class="aud-alert" id="aud-join-error" hidden></div>

      <form id="aud-join-form" class="aud-form">
        <label class="consent-row">
          <input type="checkbox" id="aud-consent" required>
          <span>My camera and microphone may be shown on the venue screen.</span>
        </label>

        <button type="submit" class="btn btn-primary btn-lg" id="aud-start-btn">Start Camera &amp; Join</button>
      </form>
    </section>

    <section class="aud-stage" id="aud-step-stage" hidden>
      <div class="aud-orient-hint" id="aud-orient-hint" hidden>
        Landscape gives the best result on the big screen
      </div>

      <div class="aud-video-wrap" id="aud-video-wrap">
        <video id="aud-preview" autoplay playsinline muted></video>
        <div class="aud-onair-frame" id="aud-onair-frame" hidden>
          <span class="onair-tag">ON AIR</span>
        </div>
        <div class="aud-preview-note" id="aud-preview-note">Previewing locally · Full uncropped frame</div>
      </div>

      <div class="aud-alert" id="aud-stage-error" hidden></div>

      <div class="aud-controls">
        <button type="button" class="btn btn-control" id="aud-mic-btn" aria-pressed="false">
          <span class="ctrl-label" id="aud-mic-label">Mic On</span>
        </button>
        <button type="button" class="btn btn-control" id="aud-flip-btn">
          <span class="ctrl-label">Flip Camera</span>
        </button>
        <button type="button" class="btn btn-danger" id="aud-leave-btn">
          <span class="ctrl-label">Leave</span>
        </button>
      </div>
    </section>

    <section class="aud-card aud-ended" id="aud-step-ended" hidden>
      <h2 id="aud-ended-title">Session Ended</h2>
      <p id="aud-ended-desc">You have left the live wall.</p>
      <button type="button" class="btn btn-primary btn-lg" id="aud-rejoin-btn">Return to Join Screen</button>
    </section>
  </main>

  <script type="module" src="/assets/js/audience.js?v=<?= e(\App\Bootstrap::assetVersion()) ?>"></script>
</body>
</html>
