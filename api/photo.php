<?php

declare(strict_types=1);

/**
 * General photo → assistant endpoint (authenticated session, multipart).
 *
 *   POST (multipart/form-data): file field "photo", optional "caption",
 *   optional "conversation_id"
 *     → stores the normalised image outside the webroot, then runs one assistant
 *       turn with the photo attached multimodally, so the model reads it and acts
 *       (calendar event, list item, reminder, expense, …).
 *
 * Distinct from receipt-upload.php (which is the specialised read-and-book path):
 * this is "read this photo and do the right thing" over the full toolset. Returns
 * the same JSON shape as chat.php so the frontend handles the reply identically.
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
use App\Data\CycleTracker;
use App\Data\DevIdeas;
use App\Data\Invites;
use App\Data\Memories;
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

if (!isset($_FILES['photo'])) {
    respond(400, ['error' => 'No photo uploaded.']);
}
$file = $_FILES['photo'];
if (!is_array($file) || ($file['error'] ?? UPLOAD_ERR_NO_FILE) !== UPLOAD_ERR_OK || !is_uploaded_file($file['tmp_name'])) {
    respond(400, ['error' => 'Upload failed. Please try again.']);
}

$caption        = trim((string) ($_POST['caption'] ?? ''));
$conversationId = isset($_POST['conversation_id']) ? (int) $_POST['conversation_id'] : 0;

try {
    // Normalise + store the image outside the webroot (HEIC→JPEG, EXIF stripped,
    // size-bounded) — the same store receipts use.
    $storage = new ReceiptStorage();
    $stored  = $storage->store($userId, (string) $file['tmp_name'], (int) $file['size']);
    $path    = $storage->pathFor($userId, $stored['file_ref']);
    if ($path === null) {
        respond(500, ['error' => 'Could not read that photo.']);
    }
    $bytes = @file_get_contents($path);
    if ($bytes === false || $bytes === '') {
        respond(500, ['error' => 'Could not read that photo.']);
    }
    $image = ['mime' => $stored['mime'], 'data' => base64_encode($bytes)];

    $conversations = new Conversations();
    if ($conversationId > 0) {
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
        new WorkLog(),
        new ApiTokens(),
        new DevIdeas(),
        new Receipts(),
        new ReceiptStorage(),
        EmailService::fromEnv(),
        new CycleTracker(),
        new UserSettings(),
        Discogs::fromEnv()
    );
    $gemini = GeminiClient::fromEnv();
    $loop   = new AssistantLoop($gemini, $registry, $conversations, $instructions, $memories);

    // The persisted user turn is just the caption (or a neutral placeholder); the
    // photo itself is attached to the turn via $image and read multimodally.
    $userMessage = $caption !== '' ? $caption : '🖼️ Photo';

    $reply = $loop->handle($userId, $conversationId, $userMessage, null, $image);

    respond(200, [
        'reply'                => $reply,
        'reply_html'           => Markdown::toHtml($reply),
        'conversation_id'      => $conversationId,
        'card'                 => $loop->lastRender(),
        'suggestions'          => $loop->lastSuggestions(),
        'diagnostics'          => $loop->lastDiagnostics(),
        'assistant_message_id' => $loop->lastAssistantMessageId(),
        'user_message_id'      => $loop->lastUserMessageId(),
    ]);
} catch (\RuntimeException $e) {
    // Friendly, user-facing (bad type / too large / unreadable image).
    respond(422, ['error' => $e->getMessage()]);
} catch (\Throwable $e) {
    error_log('photo.php: ' . $e->getMessage());
    respond(500, [
        'error' => 'Something went wrong reading that photo.',
        'debug' => get_class($e) . ': ' . $e->getMessage() . ' @ ' . $e->getFile() . ':' . $e->getLine(),
    ]);
}
