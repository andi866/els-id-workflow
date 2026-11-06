/**
 * ELS.ID WORKFLOW SYSTEM — Phase 11 (optimasi)
 * File : 11_AuditService.gs
 * Isi  : Pencatatan jejak. Hanya bisa ditambah, tidak pernah diubah
 *        atau dihapus oleh fungsi mana pun di aplikasi ini.
 *
 * Perubahan dari versi sebelumnya:
 * Catatan tidak lagi ditulis satu per satu. Selama satu permintaan
 * berjalan, semuanya dikumpulkan dulu, lalu ditulis sekali di akhir.
 *
 * Satu transaksi bisa menghasilkan 20-an baris catatan. Dulu itu
 * berarti 20 kali penulisan ke spreadsheet; sekarang cukup satu.
 * Isinya sama persis, yang berubah hanya caranya sampai ke sana.
 */

var _bufAudit = [];
var _bufTimeline = [];
var _bufNotif = [];

// ============================================================
// PENCATATAN
// ============================================================

function logAudit_(session, o) {
  logAuditRaw_({
    actor_user_id: session.user_id,
    actor_name: session.full_name,
    actor_role: session.role,
    entity: o.entity,
    entity_id: o.entity_id,
    trx_no: o.trx_no || '',
    action: o.action,
    field: o.field || '',
    old_value: o.old_value === undefined ? '' : o.old_value,
    new_value: o.new_value === undefined ? '' : o.new_value,
    reason: o.reason || '',
    source_page: o.source_page || '',
    session_token_short: session.token ? String(session.token).substring(0, 8) : ''
  });
}

function logAuditRaw_(o) {
  _bufAudit.push({
    log_id: Util.id('LOG'),
    at: nowIso_(),
    actor_user_id: o.actor_user_id || 'SYSTEM',
    actor_name: o.actor_name || 'Sistem',
    actor_role: o.actor_role || 'SYSTEM',
    entity: o.entity || '',
    entity_id: o.entity_id || '',
    trx_no: o.trx_no || '',
    action: o.action || '',
    field: o.field || '',
    old_value: o.old_value === undefined ? '' : String(o.old_value).substring(0, 500),
    new_value: o.new_value === undefined ? '' : String(o.new_value).substring(0, 500),
    reason: String(o.reason || '').substring(0, 300),
    source_page: o.source_page || '',
    session_token_short: o.session_token_short || ''
  });
}

function logTimeline_(session, o) {
  _bufTimeline.push({
    timeline_id: Util.id('TL'),
    trx_id: o.trx_id || '',
    trx_no: o.trx_no || '',
    at: nowIso_(),
    event_code: o.event_code || '',
    event_label: String(o.event_label || '').substring(0, 300),
    actor_user_id: session ? session.user_id : 'SYSTEM',
    actor_name: session ? session.full_name : 'Sistem',
    actor_role: session ? session.role : 'SYSTEM',
    stage_after: o.stage_after || '',
    detail: String(o.detail || '').substring(0, 400)
  });
}

/** Dipakai mulai Phase 2 untuk membandingkan sebelum dan sesudah */
function diffAndLog_(session, entity, entityId, trxNo, before, after, reason, page) {
  var n = 0;
  Object.keys(after).forEach(function (f) {
    if (f.charAt(0) === '_') return;
    if (String(before[f]) === String(after[f])) return;
    logAudit_(session, {
      entity: entity, entity_id: entityId, trx_no: trxNo,
      action: 'UPDATE', field: f,
      old_value: before[f], new_value: after[f],
      reason: reason, source_page: page
    });
    n++;
  });
  return n;
}

// ============================================================
// PENULISAN SEKALI JALAN
// ============================================================

/**
 * Menulis seluruh catatan yang terkumpul.
 *
 * Dipanggil otomatis di akhir setiap permintaan lewat withGuard_,
 * dan perlu dipanggil manual di akhir fungsi yang dijalankan trigger
 * karena fungsi itu tidak lewat withGuard_.
 */
function flushLog_() {
  try {
    if (_bufAudit.length) {
      Repo.appendMany(DB.SHEET.AUDIT, _bufAudit);
      _bufAudit = [];
    }
    if (_bufTimeline.length) {
      Repo.appendMany(DB.SHEET.TIMELINE, _bufTimeline);
      _bufTimeline = [];
    }
    if (_bufNotif.length) {
      Repo.appendMany(DB.SHEET.NOTIF, _bufNotif);
      var role = {};
      _bufNotif.forEach(function (n) { if (n.target_role) role[n.target_role] = 1; });
      Object.keys(role).forEach(function (r) { bumpPulse_(r); });
      _bufNotif = [];
    }
  } catch (e) {
    // Gagal mencatat tidak boleh menggagalkan pekerjaan user.
    // Tetap muncul di log eksekusi Apps Script supaya bisa ditelusuri.
    console.error('flushLog gagal: ' + e.message);
    _bufAudit = []; _bufTimeline = []; _bufNotif = [];
  }
}

/** Membuang isi penampung tanpa menulis — dipakai kalau pekerjaan dibatalkan */
function dropLog_() {
  _bufAudit = []; _bufTimeline = []; _bufNotif = [];
}
