<?php
use function App\e;
/** @var array $user */
/** @var ?string $pwError */
?><!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Change Password — QR Live Wall</title>
  <link rel="stylesheet" href="/assets/css/common.css">
  <link rel="stylesheet" href="/assets/css/admin.css">
</head>
<body class="adm-auth-body">
  <main class="adm-auth-card">
    <div class="adm-auth-brand">QR Live Wall</div>
    <h1 class="adm-auth-title">Set a New Password</h1>
    <p class="adm-auth-sub">Hello <?= e($user['display_name']) ?>. You must update your password before entering the studio console.</p>

    <?php if (!empty($pwError)): ?>
      <div class="adm-alert adm-alert-error"><?= e($pwError) ?></div>
    <?php endif; ?>

    <form method="post" action="/admin/change-password" class="adm-auth-form">
      <input type="hidden" name="csrf_token" value="<?= e($user['csrf_token']) ?>">
      <label class="field">
        <span>Current Password</span>
        <input type="password" name="current_password" required autocomplete="current-password">
      </label>
      <label class="field">
        <span>New Password (10+ chars, upper, lower, number)</span>
        <input type="password" name="new_password" required minlength="10" autocomplete="new-password">
      </label>
      <label class="field">
        <span>Confirm New Password</span>
        <input type="password" name="confirm_password" required minlength="10" autocomplete="new-password">
      </label>
      <button type="submit" class="btn btn-primary btn-lg">Update Password</button>
    </form>
  </main>
</body>
</html>
