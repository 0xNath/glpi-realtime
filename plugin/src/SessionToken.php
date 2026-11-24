<?php

/**
 * @license GPL-3.0-or-later
 */

namespace GlpiPlugin\Realtime;

use Redis;
use Session;

/**
 * Opaque WebSocket token tied to the GLPI session.
 *
 * - Clear token (64 hex chars) only lives in an HttpOnly, Secure, SameSite=Strict cookie
 *   restricted to the WebSocket path: JavaScript never sees it, other GLPI URLs never get it.
 * - Valkey stores `rt:s:{sha256(token)}` => {uid, name} with the PHP session lifetime;
 *   every GLPI request slides that TTL (one EXPIRE), so no extra request is ever needed.
 * - Logout and identity changes (impersonation) delete the key: the Rust server closes the
 *   corresponding connections.
 */
final class SessionToken
{
    private const SESSION_KEY = 'plugin_realtime';

    public static function onPostInit(mixed $unused = null): void
    {
        if (PHP_SAPI === 'cli' || session_status() !== PHP_SESSION_ACTIVE) {
            return;
        }
        if (self::isLogoutRequest()) {
            self::revoke();
            return;
        }
        $uid = Session::getLoginUserID();
        if (!is_numeric($uid) || (int) $uid <= 0) {
            return;
        }
        self::ensure((int) $uid);
    }

    public static function ensure(int $uid): void
    {
        $state = $_SESSION[self::SESSION_KEY] ?? null;
        $ttl = Settings::sessionTtl();

        if (is_array($state) && ($state['uid'] ?? null) === $uid && isset($state['hash'])) {
            // Slide the TTL; if the key vanished (Valkey restart, revocation), issue a new one.
            $alive = Valkey::run(fn(Redis $r) => (bool) $r->expire(self::sessionKey($state['hash']), $ttl), null);
            if ($alive === true && !isset($state['avatar'])) {
                // Session opened before avatars existed: add it once.
                $avatar = json_encode(self::avatar($uid));
                Valkey::run(fn(Redis $r) => $r->hSet(self::sessionKey($state['hash']), 'avatar', $avatar));
                $_SESSION[self::SESSION_KEY]['avatar'] = true;
            }
            if ($alive !== false) {
                return; // alive, or Valkey down (fail open: keep the current cookie)
            }
        } elseif (is_array($state) && isset($state['hash'])) {
            // Identity changed within the same PHP session (impersonation): revoke the old one.
            self::revoke();
        }

        self::issue($uid, $ttl);
    }

    private static function issue(int $uid, int $ttl): void
    {
        $token = bin2hex(random_bytes(32));
        $hash = hash('sha256', $token);
        $name = (string) ($_SESSION['glpifriendlyname'] ?? $_SESSION['glpiname'] ?? '');
        $avatar = json_encode(self::avatar($uid));

        $ok = Valkey::run(function (Redis $r) use ($hash, $uid, $name, $avatar, $ttl) {
            $key = self::sessionKey($hash);
            $r->multi(Redis::PIPELINE)
                ->hMSet($key, ['uid' => (string) $uid, 'name' => $name, 'avatar' => $avatar])
                ->expire($key, $ttl)
                ->exec();
            return true;
        }, false);
        if (!$ok) {
            return;
        }

        $_SESSION[self::SESSION_KEY] = ['uid' => $uid, 'hash' => $hash, 'avatar' => true];
        $options = [
            'expires'  => 0,
            'path'     => Settings::get('ws_path'),
            'secure'   => true,
            'httponly' => true,
            'samesite' => 'Strict',
        ];
        if (self::$cookieSink !== null) {
            (self::$cookieSink)(Settings::get('cookie_name'), $token, $options);
        } elseif (!headers_sent()) {
            setcookie(Settings::get('cookie_name'), $token, $options);
        }
    }

    /** @internal tests: receives (name, value, options) instead of setcookie(). */
    public static ?\Closure $cookieSink = null;

    /**
     * The user's avatar exactly as GLPI draws it (components/user/picture.html.twig):
     * picture thumbnail, else initials on the user's color (or the default picture when the
     * entity disables initials).
     *
     * @return array{picture: string, initials: string, color: string, fg: string}|array{}
     */
    public static function avatar(int $uid): array
    {
        try {
            $user = new \User();
            if (!$user->getFromDB($uid)) {
                return [];
            }
            $picture = $user->getThumbnailPicturePath();
            $entity = (int) ($_SESSION['glpiactive_entity'] ?? 0);
            if ($picture === null && !\Entity::getUsedConfig('display_users_initials', $entity)) {
                $picture = $user->getPicturePath();
            }
            $color = $user->getUserInitialsBgColor();
            return [
                'picture'  => (string) ($picture ?? ''),
                'initials' => $user->getUserInitials(),
                'color'    => $color,
                'fg'       => \Toolbox::getFgColor($color, 60),
            ];
        } catch (\Throwable) {
            return []; // never break a GLPI request for an avatar
        }
    }

    public static function revoke(): void
    {
        $state = $_SESSION[self::SESSION_KEY] ?? null;
        if (is_array($state) && isset($state['hash'])) {
            Valkey::run(fn(Redis $r) => $r->del(self::sessionKey($state['hash'])));
        }
        unset($_SESSION[self::SESSION_KEY]);
    }

    /** sha256 of the current token, if any. */
    public static function currentHash(): ?string
    {
        $state = $_SESSION[self::SESSION_KEY] ?? null;
        return is_array($state) && isset($state['hash']) ? (string) $state['hash'] : null;
    }

    public static function sessionKey(string $hash): string
    {
        return Valkey::key('s:' . $hash);
    }

    private static function isLogoutRequest(): bool
    {
        $path = parse_url((string) ($_SERVER['REQUEST_URI'] ?? ''), PHP_URL_PATH);
        return is_string($path) && str_ends_with($path, '/front/logout.php');
    }
}
