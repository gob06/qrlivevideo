<?php
use function App\e;
/** @var ?string $loginError */
?><!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>QR Live Wall — Host Sign In</title>
  <link rel="stylesheet" href="/assets/css/common.css?v=<?= e(\App\Bootstrap::assetVersion()) ?>">
  <link rel="stylesheet" href="/assets/css/admin.css?v=<?= e(\App\Bootstrap::assetVersion()) ?>">
</head>
<body class="adm-auth-body">
  <main class="adm-auth-card">
    <div class="adm-auth-brand">QR Live Wall</div>
    <h1 class="adm-auth-title">Host &amp; Studio Sign In</h1>
    <p class="adm-auth-sub">Manage live event walls, audience feeds, and branded QR codes.</p>

    <?php if (!empty($loginError)): ?>
      <div class="adm-alert adm-alert-error"><?= e($loginError) ?></div>
    <?php endif; ?>

    <form method="post" action="/admin/login" class="adm-auth-form">
      <label class="field">
        <span>Username</span>
        <input type="text" name="username" required autofocus autocomplete="username">
      </label>
      <label class="field">
        <span>Password</span>
        <input type="password" name="password" required autocomplete="current-password">
      </label>
      <button type="submit" class="btn btn-primary btn-lg">Sign In</button>
    </form>
  </main>
</body>
</html>
