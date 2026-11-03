<?php

declare(strict_types=1);

/**
 * The Regnskabspakke (loan pack) card (authenticated session, JSON).
 *
 *   GET ?year=YYYY                                             → { ok, card }
 *   POST { year, action:set_item, kind:asset|liability, label, amount, as_of? }  → { ok, card }   a hand-entered balance item (amount 0 retires it)
 *
 * All rules live in App\Data\LoanPack / BalanceSheet / BalanceItems.
 */

require __DIR__ . '/../bootstrap.php';

use App\Auth\RememberMe;
use App\Auth\Session;
use App\Data\BalanceItems;
use App\Data\BalanceSheet;
use App\Data\Ledger;
use App\Data\LoanPack;
use App\Data\LoanReports;
use App\Data\Mileage;
use App\Data\RememberTokens;
use App\Data\UserSettings;
use App\Data\Users;

header('Content-Type: application/json');

function out(int $status, array $body): never
{
    http_response_code($status);
    echo json_encode($body, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
    exit;
}

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
    out(401, ['error' => 'Not authenticated.']);
}
$userId = (int) $session->userId();
session_write_close();

$settings = new UserSettings();
$items    = new BalanceItems();
$pack     = new LoanPack(new Ledger(), new LoanReports(), new BalanceSheet(), $items, $settings, (new Mileage($settings))->businessDeduction(...));

try {
    $in   = ($_SERVER['REQUEST_METHOD'] ?? 'GET') === 'POST' ? json_decode((string) file_get_contents('php://input'), true) : [];
    $in   = is_array($in) ? $in : [];
    $year = (int) ($in['year'] ?? $_GET['year'] ?? 0);
    $year = $year >= 2000 && $year <= (int) date('Y') ? $year : LoanPack::defaultYear();

    if (($_SERVER['REQUEST_METHOD'] ?? 'GET') === 'POST') {
        if ((string) ($in['action'] ?? '') !== 'set_item') {
            out(400, ['error' => 'action must be set_item.']);
        }
        $label  = trim((string) ($in['label'] ?? ''));
        $amount = $in['amount'] ?? null;
        if (is_string($amount)) {   // "12.345,67" (Danish) or "12345.67"
            $amount = trim($amount);
            $amount = str_contains($amount, ',') ? str_replace(',', '.', str_replace('.', '', $amount)) : $amount;
        }
        if ($label === '' || !is_numeric($amount) || (float) $amount < 0) {
            out(400, ['error' => 'Give a name and an amount of 0 or more.']);
        }
        $asOf = (string) ($in['as_of'] ?? '');
        $asOf = preg_match('/^\d{4}-\d{2}-\d{2}$/', $asOf) === 1 ? $asOf : min($year . '-12-31', date('Y-m-d'));
        $items->set($userId, (string) ($in['kind'] ?? '') === 'liability' ? 'liability' : 'asset', $label, (float) $amount, $asOf);
    }

    out(200, ['ok' => true, 'card' => $pack->card($userId, $year)]);
} catch (\Throwable $e) {
    error_log('loanpack.php: ' . $e->getMessage());
    out(500, ['error' => 'Could not load the regnskabspakke.']);
}
