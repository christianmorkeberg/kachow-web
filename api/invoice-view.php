<?php

declare(strict_types=1);

/**
 * Renders a generated private-client invoice as a clean, printable HTML document
 * (authenticated session, owner-scoped). "Print → Save as PDF" produces the file to
 * send — no server-side PDF library needed. The document is rebuilt on demand from the
 * income row + line items + the saved company profile, so it always reflects the data.
 *
 *   GET /api/invoice-view.php?id=N
 */

require __DIR__ . '/../bootstrap.php';

use App\Auth\RememberMe;
use App\Auth\Session;
use App\Data\Income;
use App\Data\RememberTokens;
use App\Data\Users;
use App\Data\UserSettings;

$users   = new Users();
$session = new Session($users);
$session->boot();
if (!$session->isLoggedIn()) {
    $rememberedId = (new RememberMe(new RememberTokens()))->loginFromCookie();
    if ($rememberedId !== null) {
        $session->establish($rememberedId);
    }
}
if (!$session->isLoggedIn()) {
    http_response_code(401);
    exit('Not authenticated.');
}
$userId = (int) $session->userId();
$id     = (int) ($_GET['id'] ?? 0);

$income = new Income();
$row    = $id > 0 ? $income->get($userId, $id) : null;
if ($row === null) {
    http_response_code(404);
    exit('Invoice not found.');
}
$card    = $income->card($row);
$profile = (new UserSettings())->companyProfile($userId);

function e(?string $s): string
{
    return htmlspecialchars((string) $s, ENT_QUOTES, 'UTF-8');
}
function kr($n): string
{
    return number_format((float) $n, 2, ',', '.') . ' kr';
}
/** Render a value that may contain commas/newlines as separate lines. */
function lines(string $s): string
{
    $parts = preg_split('/[\r\n,]+/', $s) ?: [];
    $parts = array_values(array_filter(array_map('trim', $parts), static fn ($p): bool => $p !== ''));

    return implode('<br>', array_map('e', $parts));
}

$number   = (string) ($card['doc_number'] ?? '');
$isDoc    = (bool) ($card['is_invoice_doc'] ?? false);
$items    = $card['line_items'] ?? [];
$title    = 'Faktura ' . ($number !== '' ? $number : '#' . $id);
header('Content-Type: text/html; charset=utf-8');
?>
<!doctype html>
<html lang="da">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title><?= e($title) ?></title>
<style>
  :root { --ink:#1a1a2e; --muted:#6b7280; --line:#e5e7eb; --accent:#2563eb; }
  * { box-sizing: border-box; }
  body { font-family: -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif; color: var(--ink);
         margin: 0; padding: 32px; background: #f3f4f6; }
  .sheet { max-width: 800px; margin: 0 auto; background: #fff; padding: 44px 48px;
           box-shadow: 0 2px 16px rgba(0,0,0,.08); border-radius: 8px; }
  .top { display: flex; justify-content: space-between; align-items: flex-start; gap: 24px; margin-bottom: 32px; }
  .brand { font-size: 20px; font-weight: 800; }
  .muted { color: var(--muted); font-size: 13px; line-height: 1.5; }
  h1 { font-size: 26px; margin: 0 0 4px; letter-spacing: .5px; }
  .meta { text-align: right; font-size: 13px; }
  .meta .num { font-size: 15px; font-weight: 700; color: var(--accent); }
  .parties { display: flex; gap: 40px; margin: 8px 0 28px; }
  .parties h2 { font-size: 11px; text-transform: uppercase; letter-spacing: .08em; color: var(--muted); margin: 0 0 6px; }
  table { width: 100%; border-collapse: collapse; margin-top: 8px; }
  th, td { text-align: left; padding: 10px 8px; font-size: 13.5px; }
  th { border-bottom: 2px solid var(--line); color: var(--muted); font-weight: 600; font-size: 11.5px;
       text-transform: uppercase; letter-spacing: .04em; }
  td { border-bottom: 1px solid var(--line); }
  td.r, th.r { text-align: right; white-space: nowrap; }
  .totals { margin-left: auto; width: 280px; margin-top: 14px; }
  .totals .row { display: flex; justify-content: space-between; padding: 6px 8px; font-size: 14px; }
  .totals .grand { border-top: 2px solid var(--ink); margin-top: 4px; font-weight: 800; font-size: 16px; }
  .pay { margin-top: 34px; padding: 16px 18px; background: #f8fafc; border: 1px solid var(--line); border-radius: 8px; font-size: 13.5px; }
  .pay strong { display: block; margin-bottom: 4px; }
  .warn { margin-bottom: 20px; padding: 10px 14px; background: #fef3c7; border: 1px solid #fcd34d;
          border-radius: 8px; font-size: 13px; color: #92400e; }
  .foot { margin-top: 28px; color: var(--muted); font-size: 12px; }
  .actions { max-width: 800px; margin: 0 auto 16px; text-align: right; }
  .actions button { font-size: 14px; padding: 8px 18px; border: none; border-radius: 8px;
                    background: var(--accent); color: #fff; cursor: pointer; }
  @media print { body { background: #fff; padding: 0; } .sheet { box-shadow: none; border-radius: 0; }
                 .actions { display: none; } }
</style>
</head>
<body>
<div class="actions"><button onclick="window.print()">🖨️ Print / Save as PDF</button></div>
<div class="sheet">
<?php if (!$isDoc): ?>
  <div class="warn">This income entry has no invoice lines — it may be a recorded (not generated) invoice.</div>
<?php endif; ?>
<?php if ($profile['name'] === '' || $profile['cvr'] === ''): ?>
  <div class="warn">Your company name/CVR isn't set — the invoice is incomplete. Set it in Kachow (set your company details) and reopen.</div>
<?php endif; ?>

  <div class="top">
    <div>
      <div class="brand"><?= $profile['name'] !== '' ? e($profile['name']) : '—' ?></div>
      <div class="muted">
        <?php if ($profile['address'] !== ''): ?><?= lines($profile['address']) ?><br><?php endif; ?>
        <?php if ($profile['cvr'] !== ''): ?>CVR: <?= e($profile['cvr']) ?><br><?php endif; ?>
        <?php if ($profile['email'] !== ''): ?><?= e($profile['email']) ?><?php endif; ?>
      </div>
    </div>
    <div class="meta">
      <h1>FAKTURA</h1>
      <div class="num"><?= e($number !== '' ? $number : ('#' . $id)) ?></div>
      <div class="muted">
        <?= e(daDate($card['date'] ?? '')) ?><br>
        <?php if (!empty($card['due_at'])): ?>Betalingsfrist: <?= e(daDate($card['due_at'])) ?><?php endif; ?>
      </div>
    </div>
  </div>

  <div class="parties">
    <div>
      <h2>Faktureres til</h2>
      <div><?= $card['customer'] !== '' ? lines((string) $card['customer']) : '—' ?></div>
    </div>
  </div>

  <table>
    <thead>
      <tr><th>Beskrivelse</th><th class="r">Antal</th><th class="r">Stk. pris</th><th class="r">Beløb</th></tr>
    </thead>
    <tbody>
    <?php foreach ($items as $it): ?>
      <tr>
        <td><?= e($it['description']) ?></td>
        <td class="r"><?= e(rtrim(rtrim(number_format((float) $it['qty'], 2, ',', '.'), '0'), ',')) ?></td>
        <td class="r"><?= kr($it['unit_price']) ?></td>
        <td class="r"><?= kr($it['amount']) ?></td>
      </tr>
    <?php endforeach; ?>
    </tbody>
  </table>

  <div class="totals">
    <div class="row"><span>Subtotal (ekskl. moms)</span><span><?= kr($card['ex'] ?? 0) ?></span></div>
    <div class="row"><span>Moms (25%)</span><span><?= kr($card['vat'] ?? 0) ?></span></div>
    <div class="row grand"><span>I alt</span><span><?= kr($card['total'] ?? 0) ?></span></div>
  </div>

  <?php if ($profile['payment'] !== '' || !empty($card['note'])): ?>
  <div class="pay">
    <?php if ($profile['payment'] !== ''): ?><strong>Betaling</strong><?= lines($profile['payment']) ?><?php endif; ?>
    <?php if (!empty($card['note'])): ?><div style="margin-top:10px;"><?= e((string) $card['note']) ?></div><?php endif; ?>
  </div>
  <?php endif; ?>

  <div class="foot">Genereret med Kachow · <?= e(daDate(date('Y-m-d'))) ?></div>
</div>
</body>
</html>
<?php

/** Formats a Y-m-d date as d.m.Y (Danish), or returns it unchanged if unparseable. */
function daDate(string $ymd): string
{
    $ts = strtotime($ymd);

    return $ts !== false ? date('d.m.Y', $ts) : $ymd;
}
