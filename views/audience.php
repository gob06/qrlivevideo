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

  <main class="aud-shell" id="aud-shell">
    <header class="aud-header" id="aud-header">
      <div class="aud-event-title" id="aud-event-title"><?= e($config['eventTitle']) ?></div>
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
      <p class="aud-tos-note">By Joining to the live screen, you agree to our <button type="button" class="aud-tos-link" id="aud-tos-open">Terms of Service</button>.</p>
    </section>

    <section class="aud-stage" id="aud-step-stage" hidden>
      <div class="aud-stage-topbar status-waiting" id="aud-stage-topbar">
        <div class="aud-stage-status">
          <span class="status-dot" id="aud-status-dot"></span>
          <span id="aud-status-text">Waiting in lobby</span>
        </div>
        <div class="aud-guest-name" id="aud-guest-name"></div>
      </div>

      <div class="aud-video-wrap" id="aud-video-wrap">
        <video id="aud-preview-bg" class="aud-preview-bg" autoplay playsinline muted aria-hidden="true"></video>
        <video id="aud-preview" class="aud-preview-main" autoplay playsinline muted></video>
      </div>

      <div class="aud-controls-bar" id="aud-controls-bar">
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
      </div>
    </section>

    <section class="aud-card aud-ended" id="aud-step-ended" hidden>
      <div class="aud-status-bar status-warn" id="aud-ended-banner">
        <span class="status-dot"></span>
        <span id="aud-ended-banner-text">Disconnected</span>
      </div>
      <h2 id="aud-ended-title">Session Ended</h2>
      <p id="aud-ended-desc">You have left the live wall.</p>
      <button type="button" class="btn btn-primary btn-lg" id="aud-rejoin-btn">Return to Join Screen</button>
    </section>
  </main>

  <div class="aud-rotate-overlay" id="aud-rotate-overlay" hidden>
    <div class="aud-rotate-card">
      <div class="aud-rotate-icon" aria-hidden="true">📱</div>
      <div class="aud-rotate-title">Please hold your phone upright</div>
      <div class="aud-rotate-sub">Portrait mode is required for the live camera stage.</div>
    </div>
  </div>

  <div class="aud-modal-backdrop" id="aud-tos-modal" hidden>
    <div class="aud-modal" role="dialog" aria-modal="true" aria-labelledby="aud-tos-title">
      <div class="aud-modal-head">
        <h2 id="aud-tos-title">Terms of Service</h2>
        <button type="button" class="btn btn-secondary btn-sm" id="aud-tos-close">Close</button>
      </div>
      <div class="aud-modal-body" id="aud-tos-body"></div>
    </div>
  </div>

  <script type="module" src="/assets/js/audience.js?v=<?= e(\App\Bootstrap::assetVersion()) ?>"></script>
</body>
</html>
