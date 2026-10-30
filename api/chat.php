<?php

declare(strict_types=1);

/**
 * The single chat endpoint the frontend calls.
 *
 * POST JSON: { "message": string, "conversation_id"?: int, "notice"?: string, "view"?: object }
 *   notice: the text of the push notification the chat was opened from or tapped inside — stored as the
 *   assistant turn just before the message, so the model knows what the user is answering.
 *   view: { kind: string, title: string, summary?: string } — the card/view currently open in
 *   the app (if any), so the model can resolve an ambiguous reference to what's on screen.
 * Returns JSON: { "reply": string, "conversation_id": int }
 *   or, when the turn is slow (25 s without an answer) and this server can close a connection early (App\Support\Detach):
 *   { "interim": true, "reply": "still working…", "conversation_id", "assistant_message_id" } — the turn then finishes in the background; its answer is
 *   stored as the next assistant message of the conversation (the page polls api/conversations.php?id=…&after=…, a push covers a closed page).
 *
 * Requires an authenticated app session (or a valid remember-me cookie). Google
 * OAuth for calendar is a separate concern handled elsewhere.
 */

require __DIR__ . '/../bootstrap.php';

// Boot cost (autoload + .env + config) approximated from when PHP received the request
// to now — a proxy for cold-start/warm-up overhead on the host.
$bootMs = isset($_SERVER['REQUEST_TIME_FLOAT'])
    ? (int) round((microtime(true) - (float) $_SERVER['REQUEST_TIME_FLOAT']) * 1000)
    : 0;
error_log('timing boot: ' . $bootMs . 'ms');

use App\Assistant\AiCreditsException;
use App\Assistant\AssistantLoop;
use App\Assistant\GeminiClient;
use App\Auth\GoogleOAuth;
use App\Auth\RememberMe;
use App\Auth\Session;
use App\Data\ApiTokens;
use App\Data\BookkeepingAudit;
use App\Data\Calendar;
use App\Data\Connections;
use App\Data\Conversations;
use App\Data\CycleTracker;
use App\Data\DevIdeas;
use App\Data\Income;
use App\Data\Invites;
use App\Data\Memories;
use App\Data\OwnerDraws;
use App\Data\Receipts;
use App\Data\RememberTokens;
use App\Data\ShoppingLists;
use App\Data\UserInstructions;
use App\Data\Users;
use App\Data\UserSettings;
use App\Data\Vinyls;
use App\Data\Wishlist;
use App\Data\WorkEvents;
use App\Data\WorkLog;
use App\Data\WorkoutPlans;
use App\Data\Workouts;
use App\Email\EmailService;
use App\Mail\NativeMailer;
use App\Notify\NotificationTypes;
use App\Notify\Notifier;
use App\Music\Discogs;
use App\Receipts\ReceiptStorage;
use App\Support\AfterReply;
use App\Support\Detach;
use App\Support\Markdown;
use App\Support\SlowReply;
use App\Support\TurnProgress;
use App\Tools\ToolRegistry;
use App\Weather\Dmi;

header('Content-Type: application/json');

/**
 * @param array<string, mixed> $body
 */
function respond(int $status, array $body): never
{
    http_response_code($status);
    echo json_encode($body, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
    exit;
}

/** The push for a reply that arrived after the browser had been told "still working" — skipped while the page is open and polling for it. */
function pushLateReply(int $userId, int $conversationId, string $reply): void
{
    try {
        if (Detach::watched($userId, $conversationId)) {
            return;
        }
        Notifier::fromEnv()->notify($userId, NotificationTypes::CHAT_REPLY, 'Kachow', SlowReply::pushBody($reply), '/?conv=' . $conversationId);
    } catch (\Throwable $e) {
        error_log('chat.php pushLateReply: ' . $e->getMessage());
    }
}

if (($_SERVER['REQUEST_METHOD'] ?? 'GET') !== 'POST') {
    respond(405, ['error' => 'Method not allowed.']);
}

$users   = new Users();
$session = new Session($users);
$session->boot();

// Fall back to remember-me auto-login if there's no active session.
if (!$session->isLoggedIn()) {
    $rememberedId = (new RememberMe(new RememberTokens()))->loginFromCookie();
    if ($rememberedId !== null) {
        $session->establish($rememberedId);
    }
}

if (!$session->isLoggedIn()) {
    respond(401, ['error' => 'Not authenticated.']);
}
$userId = (int) $session->userId();
// Release the session lock now: a turn can take many seconds, and holding the lock would
// block every other request from this browser meanwhile — including api/progress.php,
// which the page polls to show live tool progress. Nothing below writes to $_SESSION.
session_write_close();

$input = json_decode((string) file_get_contents('php://input'), true);
if (!is_array($input)) {
    respond(400, ['error' => 'Invalid JSON body.']);
}
$message = trim((string) ($input['message'] ?? ''));
if ($message === '') {
    respond(400, ['error' => 'A message is required.']);
}
$conversationId = isset($input['conversation_id']) ? (int) $input['conversation_id'] : 0;

// Optional device location (browser geolocation) for location-based tools.
$location = null;
if (isset($input['location']['lat'], $input['location']['lon'])
    && is_numeric($input['location']['lat']) && is_numeric($input['location']['lon'])) {
    $location = ['lat' => (float) $input['location']['lat'], 'lon' => (float) $input['location']['lon']];
    if (isset($input['location']['acc']) && is_numeric($input['location']['acc'])) {
        $location['acc'] = (float) $input['location']['acc']; // metres; lets "here" use this fix
    }
}

// Optional "what's on screen right now" (the card/view open in the app), so the model
// can resolve an ambiguous reference ("add one for yesterday") without being told the
// list/card by name. Passive context only — sanitised and length-capped client input.
$openView = null;
if (isset($input['view']['kind'], $input['view']['title'])
    && is_string($input['view']['kind']) && is_string($input['view']['title'])
    && trim($input['view']['title']) !== '') {
    $openView = [
        'kind'  => mb_substr(trim((string) $input['view']['kind']), 0, 40),
        'title' => mb_substr(trim((string) $input['view']['title']), 0, 120),
    ];
    if (isset($input['view']['summary']) && is_string($input['view']['summary']) && trim($input['view']['summary']) !== '') {
        $openView['summary'] = mb_substr(trim((string) $input['view']['summary']), 0, 120);
    }
}

try {
    $conversations = new Conversations();

    if ($conversationId > 0) {
        // A supplied conversation must belong to the acting user.
        if ($conversations->ownerId($conversationId) !== $userId) {
            respond(403, ['error' => 'Conversation not found.']);
        }
    } else {
        $conversationId = $conversations->start($userId);
    }
    // Opened from a notification (a fresh chat, or one tapped inside a running chat): its text
    // becomes an assistant turn just before this message, so a reply like "Clock me out now"
    // or "Not yet" is read in context (and history shows it).
    $notice = trim((string) ($input['notice'] ?? ''));
    if ($notice !== '') {
        $conversations->addMessage($conversationId, 'assistant', mb_substr($notice, 0, 600));
    }

    $oauth        = GoogleOAuth::fromEnv($users);
    $instructions = new UserInstructions();
    $memories     = new Memories();
    $workouts     = new Workouts();
    $registry     = ToolRegistry::createStandard(
        $workouts,
        new Wishlist(),
        new Calendar($oauth),
        $instructions,
        $users,
        new Invites(),
        NativeMailer::fromEnv(),
        new Connections(),
        new Vinyls(),
        $memories,
        new ShoppingLists(),
        Dmi::fromEnv(),
        new WorkoutPlans(null, $workouts),
        new WorkEvents(),
        new WorkLog(),
        new ApiTokens(),
        new DevIdeas(),
        new Receipts(),
        new ReceiptStorage(),
        EmailService::fromEnv(),
        new CycleTracker(),
        new UserSettings(),
        new Income(),
        new OwnerDraws(),
        new BookkeepingAudit(),
        Discogs::fromEnv()
    );
    $gemini = GeminiClient::fromEnv();
    $loop   = new AssistantLoop($gemini, $registry, $conversations, $instructions, $memories, new UserSettings(), routines: new \App\Data\Routines());

    // Live progress for the typing bubble (tool names/status only), if the client sent a turn id.
    $turnId = isset($input['turn_id']) && is_string($input['turn_id']) ? $input['turn_id'] : '';
    if (TurnProgress::validId($turnId)) {
        $progress = new TurnProgress($userId, $turnId);
        $loop->onProgress(static fn (array $state) => $progress->write($state));
        register_shutdown_function(static function () use ($progress): void {
            $progress->delete();
            if (random_int(1, 50) === 1) {
                TurnProgress::gc();
            }
        });
    }

    // A slow turn (slow valves, a stalled model) must not leave the browser hanging: after 25 s tell it "still working" and let the turn finish
    // in the background (report #66 idea). The late answer is just the next assistant message; a push covers a page that was closed meanwhile.
    $detached = false;
    // Follow-ups that go on after the answer (a tool queues one with AfterReply::collect — e.g. "tell me when the radiators have confirmed"): only where
    // the connection can be released early, so a tool never promises a follow-up that cannot run.
    if (Detach::available()) {
        AfterReply::enable(['conversation_id' => $conversationId, 'danish' => SlowReply::isDanish($message)]);
    }
    if (Detach::available()) {
        $loop->onSlow(static function () use (&$detached, $loop, $conversations, $conversationId, $message): void {
            $text = SlowReply::interim($message);
            $mid  = $conversations->addMessage($conversationId, 'assistant', $text);
            $detached = true;
            Detach::release(200, [
                'interim'              => true,
                'reply'                => $text,
                'reply_html'           => Markdown::toHtml($text),
                'conversation_id'      => $conversationId,
                'assistant_message_id' => $mid,
                'user_message_id'      => $loop->lastUserMessageId(),
            ]);
        });
    }

    $reply = $loop->handle($userId, $conversationId, $message, $location, null, $openView);

    if ($detached) {
        // The browser was answered long ago. The reply is stored (handle() did that); nobody is waiting on this request any more.
        error_log('chat.php detached turn done: total=' . (int) round((microtime(true) - (float) ($_SERVER['REQUEST_TIME_FLOAT'] ?? microtime(true))) * 1000) . 'ms');
        pushLateReply($userId, $conversationId, $reply);
        AfterReply::run();   // the connection is long closed; the follow-ups (if any) still run
        exit;
    }

    if (isset($_SERVER['REQUEST_TIME_FLOAT'])) {
        error_log('timing request: total='
            . (int) round((microtime(true) - (float) $_SERVER['REQUEST_TIME_FLOAT']) * 1000) . 'ms');
    }

    $answer = [
        'reply'                => $reply,
        'reply_html'           => Markdown::toHtml($reply),
        'conversation_id'      => $conversationId,
        'card'                 => $loop->lastRender(),
        'card_mode'            => $loop->lastCardMode(), // 'open' | 'min' (phones)
        'suggestions'          => $loop->lastSuggestions(),
        'diagnostics'          => $loop->lastDiagnostics(),
        'assistant_message_id' => $loop->lastAssistantMessageId(),
        'user_message_id'      => $loop->lastUserMessageId(),
    ];
    if (AfterReply::hasWork()) {
        // Answer now, then keep going: the user has their reply, the follow-up (e.g. waiting for the valves to confirm) runs in the background.
        Detach::release(200, $answer, AfterReply::maxSeconds());
        AfterReply::run();
        exit;
    }
    respond(200, $answer);
} catch (\Throwable $e) {
    // Friendly message in the chat bubble; full detail in `debug` for the browser
    // console (app.js console.errors it) — so errors are diagnosable without an
    // ugly bubble or digging through server logs.
    error_log('chat.php: ' . $e->getMessage());
    // The Gemini account is out of credits: say exactly that (the page flashes it) instead of "Something went wrong".
    $creditsText = $e instanceof AiCreditsException ? AiCreditsException::userText(SlowReply::isDanish($message)) : null;
    if (!empty($detached)) {
        // Too late to answer the request: say it in the conversation, and nudge when nobody is looking.
        try {
            $failed = $creditsText ?? SlowReply::failed($message);
            (new Conversations())->addMessage($conversationId, 'assistant', $failed);
            pushLateReply($userId, $conversationId, $failed);
        } catch (\Throwable $e2) {
            error_log('chat.php late failure: ' . $e2->getMessage());
        }
        exit;
    }
    respond($creditsText !== null ? 503 : 500, [
        'error' => $creditsText ?? 'Something went wrong handling your message.',
        'code'  => $creditsText !== null ? 'ai_credits' : null,
        'debug' => get_class($e) . ': ' . $e->getMessage() . ' @ ' . $e->getFile() . ':' . $e->getLine(),
    ]);
}
