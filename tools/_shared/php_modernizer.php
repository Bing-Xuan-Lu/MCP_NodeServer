<?php
/**
 * MCP php_modernize token-based transformer.
 *
 * Reads a JSON payload from STDIN:
 *   { "files": ["/var/www/html/.../a.php", ...],
 *     "transforms": ["remove_close_tag", ...],   // optional; empty = all
 *     "apply": true|false }
 *
 * Emits JSON to STDOUT:
 *   { "results": [ { file, ok, changed, written, transforms[], warnings[], residual{}, lint{ok,error}, error } ] }
 *
 * Deterministic, syntax-equivalent transforms only. Lexer-based (token_get_all),
 * never regex on PHP structure. Each changed file is `php -l` validated before write.
 */

error_reporting(E_ERROR | E_PARSE);

$ALL = ['remove_close_tag', 'curly_offset', 'php4_ctor', 'var_to_public', 'define_bareword', 'autoload_register'];

if (!defined('T_PAAMAYIM_NEKUDOTAYIM')) define('T_PAAMAYIM_NEKUDOTAYIM', -1);
if (!defined('T_CURLY_OPEN')) define('T_CURLY_OPEN', -2);
if (!defined('T_DOLLAR_OPEN_CURLY_BRACES')) define('T_DOLLAR_OPEN_CURLY_BRACES', -3);
if (!defined('T_NEW')) define('T_NEW', -4);

function is_skippable($id) {
    return $id === T_WHITESPACE || $id === T_COMMENT || $id === T_DOC_COMMENT;
}

function lint_code($code) {
    $tmp = tempnam(sys_get_temp_dir(), 'mcpml_') . '.php';
    file_put_contents($tmp, $code);
    $out = array();
    $rc = 0;
    exec('php -l ' . escapeshellarg($tmp) . ' 2>&1', $out, $rc);
    @unlink($tmp);
    return array('ok' => ($rc === 0), 'error' => ($rc === 0 ? '' : implode("\n", $out)));
}

/** Heads-up scan for constructs that need human/LLM judgement (not auto-transformed). */
function residual_scan($code) {
    $patterns = array(
        'mysql_*'          => '/\bmysql_[a-z_]+\s*\(/i',
        'ereg/split'       => '/\b(ereg|eregi|ereg_replace|eregi_replace|split|spliti)\s*\(/i',
        'each()'           => '/\beach\s*\(/i',
        'create_function'  => '/\bcreate_function\s*\(/i',
        'session_register' => '/\b(session_register|session_unregister|session_is_registered)\s*\(/i',
        'magic_quotes'     => '/\b(get_magic_quotes_gpc|get_magic_quotes_runtime|set_magic_quotes_runtime)\s*\(/i',
        'money_format'     => '/\bmoney_format\s*\(/i',
    );
    $res = array();
    foreach ($patterns as $label => $re) {
        $c = preg_match_all($re, $code, $m);
        if ($c > 0) $res[$label] = $c;
    }
    return $res;
}

function modernize_source($code, $enabled) {
    $raw = token_get_all($code);
    $toks = array();
    foreach ($raw as $t) {
        if (is_array($t)) {
            $toks[] = array('id' => $t[0], 'text' => $t[1], 'line' => $t[2], 'drop' => false, 'append' => '');
        } else {
            $toks[] = array('id' => 0, 'text' => $t, 'line' => 0, 'drop' => false, 'append' => '');
        }
    }
    $N = count($toks);
    $changes = array();
    $warnings = array();

    $prevSig = function ($i) use (&$toks) {
        for ($j = $i - 1; $j >= 0; $j--) {
            if (is_skippable($toks[$j]['id'])) continue;
            return $j;
        }
        return -1;
    };
    $nextSig = function ($i) use (&$toks, $N) {
        for ($j = $i + 1; $j < $N; $j++) {
            if (is_skippable($toks[$j]['id'])) continue;
            return $j;
        }
        return -1;
    };
    // literal '{' / '}' / ']' char tokens carry no line; borrow the nearest token that has one
    $lineNear = function ($i) use (&$toks, $N) {
        for ($d = 0; $d < 8; $d++) {
            if ($i - $d >= 0 && $toks[$i - $d]['line'] > 0) return $toks[$i - $d]['line'];
            if ($i + $d < $N && $toks[$i + $d]['line'] > 0) return $toks[$i + $d]['line'];
        }
        return 0;
    };

    // ── Rule 3: var $prop -> public $prop ──
    if (!empty($enabled['var_to_public'])) {
        for ($i = 0; $i < $N; $i++) {
            if ($toks[$i]['id'] === T_VAR) {
                $toks[$i]['text'] = 'public';
                $changes[] = array('rule' => 'var_to_public', 'line' => $toks[$i]['line'], 'detail' => 'var -> public');
            }
        }
    }

    // ── Rule 13: define(FOO, ...) bareword constant -> define('FOO', ...) ──
    if (!empty($enabled['define_bareword'])) {
        for ($i = 0; $i < $N; $i++) {
            if ($toks[$i]['id'] === T_STRING && strtolower($toks[$i]['text']) === 'define') {
                $p = $prevSig($i);
                if ($p >= 0) {
                    $pid = $toks[$p]['id'];
                    if ($pid === T_OBJECT_OPERATOR || $pid === T_PAAMAYIM_NEKUDOTAYIM || $pid === T_FUNCTION || $pid === T_NEW) continue;
                }
                $op = $nextSig($i);
                if ($op < 0 || $toks[$op]['text'] !== '(') continue;
                $a1 = $nextSig($op);
                if ($a1 < 0 || $toks[$a1]['id'] !== T_STRING) continue;
                $a2 = $nextSig($a1);
                if ($a2 < 0 || $toks[$a2]['text'] !== ',') continue;
                $name = $toks[$a1]['text'];
                $toks[$a1]['text'] = "'" . $name . "'";
                $changes[] = array('rule' => 'define_bareword', 'line' => $toks[$a1]['line'], 'detail' => "define($name -> define('$name'");
            }
        }
    }

    // ── Rule 2: PHP4 same-name constructor -> __construct (skip namespaced files) ──
    if (!empty($enabled['php4_ctor'])) {
        $hasNs = false;
        for ($i = 0; $i < $N; $i++) {
            if ($toks[$i]['id'] === T_NAMESPACE) { $hasNs = true; break; }
        }
        if ($hasNs) {
            $warnings[] = 'php4_ctor skipped: file declares a namespace (same-name method is a normal method, not a constructor)';
        } else {
            for ($i = 0; $i < $N; $i++) {
                if ($toks[$i]['id'] !== T_CLASS) continue;
                $ni = $nextSig($i);
                if ($ni < 0 || $toks[$ni]['id'] !== T_STRING) continue; // anonymous class etc.
                $className = $toks[$ni]['text'];
                $open = -1;
                for ($j = $ni + 1; $j < $N; $j++) {
                    if ($toks[$j]['text'] === '{' && $toks[$j]['id'] === 0) { $open = $j; break; }
                }
                if ($open < 0) continue;
                $depth = 0; $close = -1;
                for ($j = $open; $j < $N; $j++) {
                    $id = $toks[$j]['id']; $tx = $toks[$j]['text'];
                    if (($tx === '{' && $id === 0) || $id === T_CURLY_OPEN || $id === T_DOLLAR_OPEN_CURLY_BRACES) {
                        $depth++;
                    } elseif ($tx === '}' && $id === 0) {
                        $depth--; if ($depth === 0) { $close = $j; break; }
                    }
                }
                if ($close < 0) $close = $N - 1;

                // existing __construct in this class?
                $hasCtor = false;
                for ($j = $open + 1; $j < $close; $j++) {
                    if ($toks[$j]['id'] !== T_FUNCTION) continue;
                    $mi = $nextSig($j);
                    if ($mi >= 0 && $toks[$mi]['text'] === '&') $mi = $nextSig($mi);
                    if ($mi >= 0 && $toks[$mi]['id'] === T_STRING && strtolower($toks[$mi]['text']) === '__construct') { $hasCtor = true; break; }
                }
                if (!$hasCtor) {
                    for ($j = $open + 1; $j < $close; $j++) {
                        if ($toks[$j]['id'] !== T_FUNCTION) continue;
                        $mi = $nextSig($j);
                        if ($mi >= 0 && $toks[$mi]['text'] === '&') $mi = $nextSig($mi);
                        if ($mi >= 0 && $toks[$mi]['id'] === T_STRING && strtolower($toks[$mi]['text']) === strtolower($className)) {
                            $toks[$mi]['text'] = '__construct';
                            $changes[] = array('rule' => 'php4_ctor', 'line' => $toks[$mi]['line'], 'detail' => "$className() -> __construct()");
                            break;
                        }
                    }
                }
                $i = $close;
            }
        }
    }

    // ── Rule 5: $var{expr} / ...]{expr} / $obj->prop{expr} offset -> [expr] ──
    if (!empty($enabled['curly_offset'])) {
        for ($i = 0; $i < $N; $i++) {
            if (!($toks[$i]['text'] === '{' && $toks[$i]['id'] === 0)) continue;
            $p = $prevSig($i);
            if ($p < 0) continue;
            $pid = $toks[$p]['id']; $ptx = $toks[$p]['text'];
            $isBase = false;
            if ($pid === T_VARIABLE) {
                $isBase = true;
            } elseif ($ptx === ']' && $pid === 0) {
                $isBase = true;
            } elseif ($pid === T_STRING) {
                $pp = $prevSig($p);
                if ($pp >= 0 && $toks[$pp]['id'] === T_OBJECT_OPERATOR) $isBase = true;
            }
            if (!$isBase) continue;

            $depth = 0; $close = -1; $hasSemicolon = false; $innerSig = 0;
            for ($j = $i; $j < $N; $j++) {
                $id = $toks[$j]['id']; $tx = $toks[$j]['text'];
                if ($tx === '{' && $id === 0) {
                    $depth++;
                } elseif ($tx === '}' && $id === 0) {
                    $depth--; if ($depth === 0) { $close = $j; break; }
                } elseif ($depth === 1) {
                    if ($tx === ';') $hasSemicolon = true;
                    if (!is_skippable($id)) $innerSig++;
                }
            }
            if ($close < 0 || $hasSemicolon || $innerSig === 0) continue;
            $toks[$i]['text'] = '[';
            $toks[$close]['text'] = ']';
            $changes[] = array('rule' => 'curly_offset', 'line' => $lineNear($i), 'detail' => '{offset} -> [offset]');
        }
    }

    // ── __autoload -> append spl_autoload_register('__autoload') ──
    if (!empty($enabled['autoload_register']) && stripos($code, 'spl_autoload_register') === false) {
        for ($i = 0; $i < $N; $i++) {
            if ($toks[$i]['id'] !== T_FUNCTION) continue;
            $mi = $nextSig($i);
            if ($mi >= 0 && $toks[$mi]['text'] === '&') $mi = $nextSig($mi);
            if ($mi < 0 || $toks[$mi]['id'] !== T_STRING || strtolower($toks[$mi]['text']) !== '__autoload') continue;
            $open = -1;
            for ($j = $mi + 1; $j < $N; $j++) {
                if ($toks[$j]['text'] === '{' && $toks[$j]['id'] === 0) { $open = $j; break; }
            }
            if ($open < 0) continue;
            $depth = 0; $close = -1;
            for ($j = $open; $j < $N; $j++) {
                $id = $toks[$j]['id']; $tx = $toks[$j]['text'];
                if (($tx === '{' && $id === 0) || $id === T_CURLY_OPEN || $id === T_DOLLAR_OPEN_CURLY_BRACES) {
                    $depth++;
                } elseif ($tx === '}' && $id === 0) {
                    $depth--; if ($depth === 0) { $close = $j; break; }
                }
            }
            if ($close < 0) continue;
            // PHP 8 forbids declaring a function literally named __autoload (fatal error),
            // so rename it and register the new name with spl_autoload_register.
            $newName = '_mcp_autoload';
            $toks[$mi]['text'] = $newName;
            $toks[$close]['append'] = "\nspl_autoload_register('" . $newName . "');\n";
            $changes[] = array('rule' => 'autoload_register', 'line' => $toks[$mi]['line'], 'detail' => "__autoload -> $newName + spl_autoload_register");
            $warnings[] = "autoload_register: renamed __autoload to $newName and registered it (PHP 8 forbids declaring __autoload). If any code calls __autoload() explicitly, update those call sites.";
            break;
        }
    }

    // ── Rule 7: remove a trailing PHP close tag when nothing meaningful follows ──
    if (!empty($enabled['remove_close_tag'])) {
        $lastClose = -1;
        for ($i = $N - 1; $i >= 0; $i--) {
            if ($toks[$i]['id'] === T_CLOSE_TAG) { $lastClose = $i; break; }
        }
        if ($lastClose >= 0) {
            $okToRemove = true;
            for ($j = $lastClose + 1; $j < $N; $j++) {
                if ($toks[$j]['id'] === T_INLINE_HTML && trim($toks[$j]['text']) === '') continue;
                $okToRemove = false; break;
            }
            if ($okToRemove) {
                for ($j = $lastClose; $j < $N; $j++) $toks[$j]['drop'] = true;
                for ($j = $lastClose - 1; $j >= 0; $j--) {
                    if (!$toks[$j]['drop']) {
                        if (substr($toks[$j]['text'], -1) !== "\n") $toks[$j]['append'] = "\n";
                        break;
                    }
                }
                $changes[] = array('rule' => 'remove_close_tag', 'line' => $toks[$lastClose]['line'], 'detail' => 'removed trailing ?>');
            }
        }
    }

    $out = '';
    foreach ($toks as $t) {
        if (!$t['drop']) $out .= $t['text'];
        $out .= $t['append'];
    }
    return array($out, $changes, $warnings);
}

// ── main ──
$rawIn = stream_get_contents(STDIN);
$payload = json_decode($rawIn, true);
if (!is_array($payload)) {
    fwrite(STDOUT, json_encode(array('fatal' => 'invalid JSON payload')));
    exit(0);
}
$files = (isset($payload['files']) && is_array($payload['files'])) ? $payload['files'] : array();
$apply = !empty($payload['apply']);
$enabled = (isset($payload['transforms']) && is_array($payload['transforms']) && count($payload['transforms']) > 0)
    ? array_fill_keys($payload['transforms'], true)
    : array_fill_keys($ALL, true);

$results = array();
foreach ($files as $f) {
    $r = array('file' => $f, 'ok' => true, 'changed' => false, 'written' => false,
               'transforms' => array(), 'warnings' => array(), 'residual' => array(),
               'lint' => null, 'error' => null);
    if (!is_file($f)) { $r['ok'] = false; $r['error'] = 'file not found'; $results[] = $r; continue; }
    $code = file_get_contents($f);
    if ($code === false) { $r['ok'] = false; $r['error'] = 'read failed'; $results[] = $r; continue; }

    $r['residual'] = residual_scan($code);
    list($newCode, $changes, $warnings) = modernize_source($code, $enabled);
    $r['transforms'] = $changes;
    $r['warnings'] = $warnings;
    $r['changed'] = ($newCode !== $code);

    if ($r['changed']) {
        $lint = lint_code($newCode);
        $r['lint'] = $lint;
        if ($apply) {
            if ($lint['ok']) {
                $w = @file_put_contents($f, $newCode);
                $r['written'] = ($w !== false);
                if ($w === false) { $r['ok'] = false; $r['error'] = 'write failed'; }
            } else {
                $r['ok'] = false;
                $r['error'] = 'lint failed after transform; file left unchanged';
            }
        }
    }
    $results[] = $r;
}

fwrite(STDOUT, json_encode(array('results' => $results), JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES));
