<?php

/**
 * Configuration page of the plugin (Setup > Plugins > Realtime): checks that everything the
 * real-time layer needs is available, and says how to fix what is not. Settings themselves
 * stay in config.toml (server) and GLPI's configuration (plugin, bin/console config:set).
 *
 * @license GPL-3.0-or-later
 */

use GlpiPlugin\Realtime\Health;
use GlpiPlugin\Realtime\Settings;
use GlpiPlugin\Realtime\SettingsForm;

global $CFG_GLPI;

Session::checkRight('config', UPDATE);

// Settings form (below the checks): saved through GLPI, then the checks run again.
$self = $CFG_GLPI['root_doc'] . '/plugins/realtime/front/config.php';
if (isset($_POST['save_settings'])) {
    $result = SettingsForm::validate($_POST, array_keys(SettingsForm::candidates()));
    if ($result['errors'] === []) {
        Config::setConfigurationValues(Settings::CONTEXT, $result['values']);
        Settings::reset();
        Session::addMessageAfterRedirect(htmlescape(__('Settings saved. The checks below use them.', 'realtime')));
    } else {
        foreach ($result['errors'] as $error) {
            Session::addMessageAfterRedirect(htmlescape($error), false, ERROR);
        }
    }
    Html::redirect($self);
}

Html::header(__('Realtime', 'realtime'), '', 'config', 'plugin');

$checks = Health::run();
$groups = [
    'glpi'   => __('GLPI', 'realtime'),
    'valkey' => __('Valkey', 'realtime'),
    'server' => __('glpi-realtime server', 'realtime'),
];
$badges = [
    Health::OK      => ['glpi-rt-badge-ok', __('OK', 'realtime')],
    Health::WARNING => ['glpi-rt-badge-warning', __('Warning', 'realtime')],
    Health::ERROR   => ['glpi-rt-badge-error', __('Error', 'realtime')],
    Health::INFO    => ['glpi-rt-badge-info', __('Info', 'realtime')],
];
$worst = in_array(Health::ERROR, array_column($checks, 'status'), true) ? Health::ERROR
    : (in_array(Health::WARNING, array_column($checks, 'status'), true) ? Health::WARNING : Health::OK);
$summary = [
    Health::OK      => __('Everything the real-time layer needs is available.', 'realtime'),
    Health::WARNING => __('The real-time layer works, with limitations: see the warnings.', 'realtime'),
    Health::ERROR   => __('The real-time layer cannot work: fix the errors below, from the top.', 'realtime'),
][$worst];

$row = static function (string $status, string $label, string $detail, string $fix, string $id = '') use ($badges): string {
    [$cls, $text] = $badges[$status];
    return '<tr' . ($id !== '' ? ' data-check="' . htmlescape($id) . '"' : '') . '>'
        . '<td class="text-nowrap"><span class="badge ' . $cls . '">' . htmlescape($text) . '</span></td>'
        . '<td class="fw-bold">' . htmlescape($label) . '</td>'
        . '<td>' . htmlescape($detail)
        . ($fix !== '' ? '<div class="text-secondary small mt-1"><i class="ti ti-tool me-1" aria-hidden="true"></i>' . htmlescape($fix) . '</div>' : '')
        . '</td></tr>';
};

// Badges readable on both themes (WCAG AA: 4.5:1), whatever GLPI's palette.
echo '<style>#glpi-rt-health .glpi-rt-badge-ok{background:#1a7f37;color:#fff}'
    . '#glpi-rt-health .glpi-rt-badge-warning{background:#f59f00;color:#1d273b}'
    . '#glpi-rt-health .glpi-rt-badge-error{background:#c92a2a;color:#fff}'
    . '#glpi-rt-health .glpi-rt-badge-info{background:#1c6fb8;color:#fff}'
    // Same columns in every section.
    . '#glpi-rt-health table{table-layout:fixed}#glpi-rt-health td:nth-child(1){width:7rem}#glpi-rt-health td:nth-child(2){width:30%}</style>';
echo '<div class="container-xl my-3" id="glpi-rt-health">';
echo '<div class="d-flex align-items-center gap-2 mb-3"><i class="ti ti-activity-heartbeat fs-1" aria-hidden="true"></i>';
echo '<h1 class="h2 mb-0">' . htmlescape(sprintf(__('Realtime %s: health checks', 'realtime'), PLUGIN_REALTIME_VERSION)) . '</h1>';
echo '<a class="btn btn-outline-secondary ms-auto" href="' . htmlescape($CFG_GLPI['root_doc'] . '/plugins/realtime/front/config.php') . '"><i class="ti ti-refresh me-1" aria-hidden="true"></i>' . htmlescape(__('Check again', 'realtime')) . '</a></div>';
echo '<div class="alert alert-' . ['ok' => 'success', 'warning' => 'warning', 'error' => 'danger'][$worst] . '">' . htmlescape($summary) . '</div>';

foreach ($groups as $g => $title) {
    $rows = array_filter($checks, static fn($c) => $c['group'] === $g);
    if ($rows === []) {
        continue;
    }
    echo '<div class="card mb-3"><div class="card-header"><h2 class="card-title h3 mb-0">' . htmlescape($title) . '</h2></div>';
    echo '<div class="table-responsive"><table class="table table-vcenter card-table mb-0"><tbody>';
    foreach ($rows as $c) {
        echo $row($c['status'], $c['label'], $c['detail'], $c['fix'], $c['id']);
    }
    echo '</tbody></table></div></div>';
}

// Browser side: the web server's /ws location and a real WebSocket, from this very page.
echo '<div class="card mb-3"><div class="card-header"><h2 class="card-title h3 mb-0">' . htmlescape(__('Web server and browser', 'realtime')) . '</h2></div>';
echo '<div class="table-responsive"><table class="table table-vcenter card-table mb-0"><tbody id="glpi-rt-browser-checks">';
echo $row(Health::INFO, __('Checking…', 'realtime'), '', '');
echo '</tbody></table></div></div>';

echo '<p>' . sprintf(
    htmlescape(__('More on each problem: %s.', 'realtime')),
    '<a class="text-decoration-underline" href="' . htmlescape(Health::TROUBLESHOOTING) . '" target="_blank" rel="noopener">' . htmlescape(__('troubleshooting guide', 'realtime')) . '</a>'
) . '</p>';
// --- Settings ---------------------------------------------------------------------------
$field = static fn(string $name, string $label, string $value, string $help = '', string $type = 'text'): string =>
    '<div class="mb-3"><label class="form-label" for="glpi-rt-' . $name . '">' . htmlescape($label) . '</label>'
    . '<input class="form-control" type="' . $type . '" id="glpi-rt-' . $name . '" name="' . $name . '" value="' . htmlescape($value) . '"'
    . ($help !== '' ? ' aria-describedby="glpi-rt-' . $name . '-help"' : '') . ($type === 'password' ? ' autocomplete="new-password"' : '') . '>'
    . ($help !== '' ? '<div class="form-hint" id="glpi-rt-' . $name . '-help">' . htmlescape($help) . '</div>' : '') . '</div>';

$enabled = Settings::enabledItemtypes();
echo '<form method="post" action="' . htmlescape($self) . '" class="card mb-3" id="glpi-rt-settings">';
echo '<div class="card-header"><h2 class="card-title h3 mb-0">' . htmlescape(__('Settings', 'realtime')) . '</h2></div><div class="card-body">';

echo '<fieldset class="mb-4"><legend class="h4">' . htmlescape(__('Item types', 'realtime')) . '</legend>';
echo '<p class="form-hint">' . htmlescape(__('Tickets, changes and problems get every feature; other items get presence (on the item and on the lists) and a single editor of their form. The server follows this list.', 'realtime')) . '</p>';
echo '<div class="row">';
foreach (SettingsForm::candidates() as $class => $label) {
    $id = 'glpi-rt-type-' . md5($class);
    echo '<div class="col-12 col-sm-6 col-lg-4"><label class="form-check" for="' . $id . '">'
        . '<input class="form-check-input" type="checkbox" id="' . $id . '" name="itemtypes[]" value="' . htmlescape($class) . '"' . (in_array($class, $enabled, true) ? ' checked' : '') . '>'
        . '<span class="form-check-label">' . htmlescape($label)
        . (in_array($class, SettingsForm::ITIL, true) ? ' <span class="badge glpi-rt-badge-info">' . htmlescape(__('all features', 'realtime')) . '</span>' : '')
        . '</span></label></div>';
}
echo '</div></fieldset>';

echo '<fieldset><legend class="h4">' . htmlescape(__('Valkey and server', 'realtime')) . '</legend>';
echo '<p class="form-hint">' . htmlescape(__('These must match the server\'s config.toml: Valkey (url, db), key prefix, cookie name; the WebSocket path is the web server\'s location.', 'realtime')) . '</p>';
echo '<div class="row"><div class="col-12 col-lg-6">';
echo $field('valkey_socket', __('Valkey', 'realtime'), Settings::get('valkey_socket'), __('Unix socket path, or host[:port].', 'realtime'));
echo $field('valkey_db', __('Valkey database', 'realtime'), Settings::get('valkey_db'), __('[valkey] db in config.toml.', 'realtime'), 'number');
echo $field('valkey_username', __('Valkey user (ACL)', 'realtime'), Settings::get('valkey_username'), __('Empty without ACL user.', 'realtime'));
echo '<div class="mb-3"><label class="form-label" for="glpi-rt-valkey_password">' . htmlescape(__('Valkey password', 'realtime')) . '</label>'
    . '<input class="form-control" type="password" id="glpi-rt-valkey_password" name="valkey_password" value="" autocomplete="new-password" aria-describedby="glpi-rt-valkey_password-help">'
    . '<div class="form-hint" id="glpi-rt-valkey_password-help">' . htmlescape(Settings::get('valkey_password') !== ''
        ? __('Set (stored encrypted by GLPI). Leave empty to keep it.', 'realtime')
        : __('Not set. Stored encrypted by GLPI.', 'realtime')) . '</div>'
    . (Settings::get('valkey_password') !== '' ? '<label class="form-check mt-1"><input class="form-check-input" type="checkbox" name="valkey_password_remove" value="1"><span class="form-check-label">' . htmlescape(__('Remove the password', 'realtime')) . '</span></label>' : '')
    . '</div>';
echo '</div><div class="col-12 col-lg-6">';
echo $field('key_prefix', __('Key prefix', 'realtime'), Settings::get('key_prefix'), __('[valkey] key_prefix in config.toml.', 'realtime'));
echo $field('cookie_name', __('Session cookie name', 'realtime'), Settings::get('cookie_name'), __('[security] cookie_name in config.toml.', 'realtime'));
echo $field('ws_path', __('WebSocket path', 'realtime'), Settings::get('ws_path'), __('The web server\'s location to the server (/ws).', 'realtime'));
echo '</div></div></fieldset>';

echo '</div><div class="card-footer text-end"><button type="submit" name="save_settings" value="1" class="btn btn-primary">'
    . '<i class="ti ti-device-floppy me-1" aria-hidden="true"></i>' . htmlescape(__('Save', 'realtime')) . '</button></div>';
Html::closeForm();
echo '</div>';

$t = [
    'ok'          => $badges[Health::OK],
    'warning'     => $badges[Health::WARNING],
    'error'       => $badges[Health::ERROR],
    'location'    => __('Web server forwards /ws', 'realtime'),
    'locOk'       => __('The request reached glpi-realtime (HTTP %s).', 'realtime'),
    'loc404'      => __('/ws is answered by GLPI itself (HTTP 404): the web server does not forward it.', 'realtime'),
    'loc404Fix'   => __('Add the /ws location to the GLPI vhost (README, "Web server": nginx location or Apache ProxyPass), then reload the web server.', 'realtime'),
    'loc502'      => __('The web server cannot reach glpi-realtime (HTTP %s).', 'realtime'),
    'loc502Fix'   => __('Start the server (systemctl status glpi-realtime). With a unix socket, the web server\'s user must be in the socket\'s group: [listen] group in config.toml, and the service\'s SupplementaryGroups.', 'realtime'),
    'locOther'    => __('Unexpected answer: HTTP %s.', 'realtime'),
    'ws'          => __('WebSocket from this browser', 'realtime'),
    'wsOk'        => __('Connected and authenticated as %s.', 'realtime'),
    'wsFail'      => __('The WebSocket was refused or closed before the server greeted it (close code %s).', 'realtime'),
    'wsFailFix'   => __('If the line above is OK: the web server does not pass the upgrade (nginx: proxy_http_version 1.1 and the Upgrade/Connection headers; Apache: upgrade=websocket), or the server refused this origin or session (see the "Allowed origin" and "Session cookie name" checks, and journalctl -u glpi-realtime).', 'realtime'),
    'wsTimeout'   => __('No answer within 5 s.', 'realtime'),
];
$wsPath = Settings::get('ws_path');
echo Html::scriptBlock('(function () {
  const t = ' . json_encode($t) . ';
  const body = document.getElementById("glpi-rt-browser-checks");
  const rows = [];
  const row = (status, label, detail, fix) => {
    const tr = document.createElement("tr");
    const [cls, text] = t[status];
    const td = (cls2) => { const el = document.createElement("td"); if (cls2) el.className = cls2; tr.append(el); return el; };
    const b = document.createElement("span"); b.className = "badge " + cls; b.textContent = text; td("text-nowrap").append(b);
    td("fw-bold").textContent = label;
    const d = td(); d.textContent = detail;
    if (fix) { const f = document.createElement("div"); f.className = "text-secondary small mt-1"; f.textContent = fix; d.append(f); }
    rows.push(tr); body.replaceChildren(...rows);
  };
  const fmt = (s, v) => s.replace("%s", v);
  const path = ' . json_encode($wsPath) . ';
  (async () => {
    try {
      const resp = await fetch(path, { credentials: "same-origin", cache: "no-store" });
      const text = await resp.text();
      const glpiPage = /<html/i.test(text);
      if ((resp.status === 400 || resp.status === 426) && !glpiPage) row("ok", t.location, fmt(t.locOk, resp.status));
      else if (resp.status === 404) row("error", t.location, t.loc404, t.loc404Fix);
      else if (resp.status >= 502 && resp.status <= 504) row("error", t.location, fmt(t.loc502, resp.status), t.loc502Fix);
      else row("warning", t.location, fmt(t.locOther, resp.status));
    } catch (e) {
      row("error", t.location, String(e));
    }
    const scheme = location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(scheme + "//" + location.host + path);
    let done = false;
    const finish = (status, detail, fix) => { if (done) return; done = true; row(status, t.ws, detail, fix); try { ws.close(1000); } catch (e) {} };
    ws.onmessage = (ev) => {
      try { const m = JSON.parse(ev.data); if (m.t === "hello") finish("ok", fmt(t.wsOk, m.user && m.user.name)); } catch (e) {}
    };
    ws.onclose = (ev) => finish("error", fmt(t.wsFail, ev.code), t.wsFailFix);
    setTimeout(() => finish("error", t.wsTimeout, t.wsFailFix), 5000);
  })();
})();');

Html::footer();
