<?php

declare(strict_types=1);

/**
 * The single chat endpoint the frontend calls.
 *
 * POST JSON: { "message": string, "conversation_id"?: int }
 * Returns JSON: { "reply": string, "conversation_id": int }
 *
 * Requires an authenticated app session (or a valid remember-me cookie). Google
 * OAuth for calendar is a separate concern handled elsewhere.
 */

require __DIR__ . '/../bootstrap.php';

use App\Assistant\AssistantLoop;
use App\Assistant\GeminiClient;
use App\Auth\GoogleOAuth;
use App\Auth\RememberMe;
use App\Auth\Session;
use App\Data\ApiTokens;
use App\Data\Calendar;
use App\Data\Connections;
use App\Data\Conversations;
use App\Data\DevIdeas;
use App\Data\Invites;
use App\Data\Memories;
use App\Data\Receipts;
use App\Data\RememberTokens;
use App\Data\ShoppingLists;
use App\Data\UserInstructions;
use App\Data\Users;
use App\Data\Vinyls;
use App\Data\Wishlist;
use App\Data\WorkEvents;
use App\Data\WorkoutPlans;
use App\Data\Workouts;
use App\Email\EmailService;
use App\Mail\NativeMailer;
use App\Music\Discogs;
use App\Receipts\ReceiptStorage;
use App\Support\Markdown;
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
        new ApiTokens(),
        new DevIdeas(),
        new Receipts(),
        new ReceiptStorage(),
        EmailService::fromEnv(),
        Discogs::fromEnv()
    );
    $gemini = GeminiClient::fromEnv();
    $loop   = new AssistantLoop($gemini, $registry, $conversations, $instructions, $memories);

    $reply = $loop->handle($userId, $conversationId, $message, $location);

    respond(200, [
        'reply'           => $reply,
        'reply_html'      => Markdown::toHtml($reply),
        'conversation_id' => $conversationId,
        'card'            => $loop->lastRender(),
    ]);
} catch (\Throwable $e) {
    // Log detail server-side; never leak internals to the client.
    error_log('chat.php: ' . $e->getMessage());
    respond(500, ['error' => 'Something went wrong handling your message.']);
}
