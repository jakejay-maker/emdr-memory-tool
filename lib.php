<?php
// Shared helpers. Stores ONLY session bookkeeping (ids, expiry, counters). Never any user content.

function cfg() {
  static $c = null;
  if ($c === null) { $c = []; foreach ([__DIR__ . '/../config.php', __DIR__ . '/config.php'] as $p) { if (is_file($p)) { $c = require $p; break; } } }
  return $c;
}
function jout($j, $code = 200) { http_response_code($code); header('Content-Type: application/json'); header('Cache-Control: no-store'); echo json_encode($j); exit; }
function jbody() { $j = json_decode(file_get_contents('php://input'), true); return is_array($j) ? $j : []; }

function db() {
  static $db = null;
  if ($db) return $db;
  $dir = __DIR__ . '/data';
  if (!is_dir($dir)) {
    @mkdir($dir, 0755, true);
    @file_put_contents($dir . '/.htaccess', "<IfModule mod_authz_core.c>\nRequire all denied\n</IfModule>\n<IfModule !mod_authz_core.c>\nDeny from all\n</IfModule>\n");
  }
  $db = new PDO('sqlite:' . $dir . '/sessions.sqlite');
  $db->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
  $db->setAttribute(PDO::ATTR_DEFAULT_FETCH_MODE, PDO::FETCH_ASSOC);
  $db->exec('CREATE TABLE IF NOT EXISTS sess(id TEXT PRIMARY KEY, created INTEGER, exp INTEGER, gens INTEGER DEFAULT 0, risks INTEGER DEFAULT 0, red INTEGER DEFAULT 0, test INTEGER DEFAULT 0, pay TEXT UNIQUE, pi TEXT, refunded INTEGER DEFAULT 0)');
  $db->exec('CREATE TABLE IF NOT EXISTS rl(k TEXT, t INTEGER)');
  return $db;
}

function secret() {
  $s = (string)(cfg()['token_secret'] ?? '');
  if (strlen($s) < 32) jout(['error' => 'server not configured'], 500);
  return $s;
}
function make_token($id) { return $id . '.' . hash_hmac('sha256', $id, secret()); }

// Returns the session row, or null. $grace lets safety calls keep working briefly after expiry.
function verify_token($tok, $grace = 0) {
  $p = explode('.', (string)$tok);
  if (count($p) !== 2 || !preg_match('/^[a-f0-9]{16}$/', $p[0])) return null;
  if (!hash_equals(hash_hmac('sha256', $p[0], secret()), $p[1])) return null;
  $q = db()->prepare('SELECT * FROM sess WHERE id = ?'); $q->execute([$p[0]]); $r = $q->fetch();
  return ($r && (int)$r['exp'] + $grace > time()) ? $r : null;
}

function new_session($test, $pay, $pi) {
  $id = bin2hex(random_bytes(8)); $now = time();
  $exp = $now + 60 * (int)(cfg()['session_minutes'] ?? 120);
  db()->prepare('INSERT INTO sess(id,created,exp,test,pay,pi) VALUES(?,?,?,?,?,?)')->execute([$id, $now, $exp, $test ? 1 : 0, $pay, $pi]);
  return ['id' => $id, 'exp' => $exp, 'token' => make_token($id)];
}

// Atomic counter with a cap. $col is one of two fixed names, never user input.
function spend($id, $col, $cost, $cap) {
  if ($col !== 'gens' && $col !== 'risks') return false;
  $q = db()->prepare("UPDATE sess SET $col = $col + ? WHERE id = ? AND $col + ? <= ?");
  $q->execute([$cost, $id, $cost, $cap]);
  return $q->rowCount() === 1;
}

function limited($k, $max, $win) {
  $now = time(); $d = db();
  $d->prepare('DELETE FROM rl WHERE t < ?')->execute([$now - 86400]);
  $q = $d->prepare('SELECT COUNT(*) FROM rl WHERE k = ? AND t > ?'); $q->execute([$k, $now - $win]);
  if ((int)$q->fetchColumn() >= $max) return true;
  $d->prepare('INSERT INTO rl(k,t) VALUES(?,?)')->execute([$k, $now]);
  return false;
}
function ip_hash() { return hash('sha256', ($_SERVER['REMOTE_ADDR'] ?? '') . (cfg()['salt'] ?? 'x')); }
function base_url() {
  $https = isset($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off';
  return ($https ? 'https' : 'http') . '://' . $_SERVER['HTTP_HOST'] . rtrim(dirname($_SERVER['SCRIPT_NAME']), '/');
}
