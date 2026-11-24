<?php

/**
 * Configuration page of the plugin (Setup > Plugins > Realtime): checks that everything the
 * real-time layer needs is available, and says how to fix what is not. Settings themselves
 * stay in config.toml (server) and GLPI's configuration (plugin, bin/console glpi:config:set).
 *
 * @license GPL-3.0-or-later
 */

use GlpiPlugin\Realtime\Health;
use GlpiPlugin\Realtime\Settings;

global $CFG_GLPI;

Session::checkRight('config', UPDATE);

Html::header(__('Realtime', 'realtime'), '', 'config', 'plugin');

$checks = Health::run();
$groups = [
    'glpi'   => __('GLPI', 'realtime'),
    'valkey' => __('Valkey', 'realtime'),
    'server' => __('glpi-realtime server', 'realtime'),
];
$badges = [
    Health::OK      => ['bg-success', __('OK', 'realtime')],
    Health::WARNING => ['bg-warning', __('Warning', 'realtime')],
    Health::ERROR   => ['bg-danger', __('Error', 'realtime')],
    Health::INFO    => ['bg-info', __('Info', 'realtime')],
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
        . '<td class="text-nowrap"><span class="badge ' . $cls . ' text-white">' . htmlescape($text) . '</span></td>'
        . '<td class="fw-bold">' . htmlescape($label) . '</td>'
        . '<td>' . htmlescape($detail)
        . ($fix !== '' ? '<div class="text-secondary small mt-1"><i class="ti ti-tool me-1" aria-hidden="true"></i>' . htmlescape($fix) . '</div>' : '')
        . '</td></tr>';
};

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

echo '<p class="text-secondary small">' . htmlescape(sprintf(
    __('Plugin settings (context plugin:realtime) are changed with: bin/console glpi:config:set --context=plugin:realtime <name> <value>. Current: valkey_socket=%s, valkey_db=%s, key_prefix=%s, cookie_name=%s, ws_path=%s.', 'realtime'),
    Settings::get('valkey_socket'),
    Settings::get('valkey_db'),
    Settings::get('key_prefix'),
    Settings::get('cookie_name'),
    Settings::get('ws_path')
)) . '</p></div>';

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
    const b = document.createElement("span"); b.className = "badge " + cls + " text-white"; b.textContent = text; td("text-nowrap").append(b);
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
