<?php

/**
 * Client texts for the user's GLPI language, beyond the built-in French and English:
 * plugin/locales/client/<lang>.json (e.g. de_DE.json, or de.json), see template.json.
 *
 * GET → {"namespace": {"key": "text"}} or {} when there is none.
 *
 * @license GPL-3.0-or-later
 */

Session::checkLoginUser();
header('Content-Type: application/json; charset=UTF-8');
header('Cache-Control: private, max-age=3600');

$lang = (string) ($_SESSION['glpilanguage'] ?? '');
$dir = dirname(__DIR__) . '/locales/client/';
$out = '{}';
foreach (array_unique([$lang, substr($lang, 0, 2)]) as $name) {
    if (preg_match('/^[a-z]{2}(_[A-Z]{2})?$/', $name) && is_file($dir . $name . '.json')) {
        $json = (string) file_get_contents($dir . $name . '.json');
        if (is_array(json_decode($json, true))) {
            $out = $json;
            break;
        }
    }
}
echo $out;
