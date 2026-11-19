<?php
use function App\e;
/** @var array $printConfig */
?><!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Print QR — <?= e($printConfig['title']) ?></title>
  <link rel="stylesheet" href="/assets/css/common.css?v=<?= e(\App\Bootstrap::assetVersion()) ?>">
  <style>
    body { background: #f8fafc; color: #0f172a; margin: 0; font-family: var(--font-sans); }
    .print-toolbar { display: flex; justify-content: space-between; align-items: center; gap: 12px; padding: 14px 24px; background: #0f172a; color: #f8fafc; }
    .print-toolbar-actions { display: flex; gap: 10px; flex-wrap: wrap; }
    .poster { max-width: 820px; margin: 32px auto; background: #ffffff; border: 1px solid #e2e8f0; border-radius: 20px; padding: 48px; text-align: center; }
    .poster h1 { font-size: 40px; margin: 0 0 12px; line-height: 1.15; }
    .poster p.sub { font-size: 20px; color: #475569; margin: 0 0 32px; }
    .poster canvas { width: 100%; max-width: 520px; height: auto; border-radius: 12px; }
    .poster .url { margin-top: 24px; font-family: var(--font-mono); font-size: 16px; color: #334155; word-break: break-all; }
    @media print {
      .print-toolbar { display: none; }
      body { background: #fff; }
      .poster { border: none; margin: 0 auto; padding: 20px; }
    }
  </style>
</head>
<body>
  <script id="app-config" type="application/json"><?= json_encode($printConfig, JSON_UNESCAPED_SLASHES | JSON_HEX_TAG | JSON_HEX_AMP) ?></script>
  <div class="print-toolbar">
    <strong>Printable QR Poster</strong>
    <div class="print-toolbar-actions">
      <button type="button" class="btn btn-secondary btn-sm" id="dl-png-btn">Download PNG (1024px)</button>
      <button type="button" class="btn btn-secondary btn-sm" id="dl-svg-btn">Download SVG</button>
      <button type="button" class="btn btn-primary btn-sm" id="print-btn">Print Poster</button>
    </div>
  </div>
  <main class="poster">
    <h1><?= e($printConfig['title']) ?></h1>
    <p class="sub">Scan with your phone camera to join the live screen</p>
    <canvas id="print-qr-canvas" width="1024" height="1024"></canvas>
    <div class="url"><?= e($printConfig['joinUrl']) ?></div>
  </main>
  <script type="module" src="/assets/js/print-qr.js?v=<?= e(\App\Bootstrap::assetVersion()) ?>"></script>
</body>
</html>
