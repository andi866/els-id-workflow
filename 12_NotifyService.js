/**
 * ELS.ID WORKFLOW SYSTEM — Phase 8
 * File : 12_NotifyService.gs
 * Isi  : Notifikasi antar divisi.
 *
 * Cara kerjanya:
 * Browser menanyakan satu angka penanda (pulse) setiap 12 detik.
 * Selama angkanya tidak berubah, tidak ada apa pun yang dibaca dari
 * spreadsheet — itulah yang membuat pengecekan terus-menerus tetap
 * murah. Begitu berubah, baru ringkasannya diambil sekali.
 *
 * Satu pengecek melayani seluruh divisi. Kalau tiap divisi punya
 * pengeceknya sendiri, kuota Apps Script habis berkali lipat.
 */

// ============================================================
// PENULISAN NOTIFIKASI
// ============================================================

/**
 * Notifikasi ikut dikumpulkan bersama catatan lain, lalu ditulis
 * sekali di akhir permintaan. Satu transaksi bisa memicu beberapa
 * notifikasi sekaligus — cukup satu kali penulisan untuk semuanya.
 */
function pushNotif_(o) {
  try {
    var now = nowIso_();
    var jam = Settings.num('NOTIF_KEEP_HOURS', 24);

    _bufNotif.push({
      notif_id: Util.id('NTF'),
      created_at: now,
      target_role: o.target_role || '',
      target_branch: o.target_branch || '',
      target_user_id: o.target_user_id || '',
      trx_id: o.trx_id || '',
      trx_no: o.trx_no || '',
      type: o.type || '',
      priority: o.priority || 'NORMAL',
      title: String(o.title || '').substring(0, 120),
      body: String(o.body || '').substring(0, 300),
      read_by: '',
      acted_by: '',
      acted_at: '',
      expires_at: Util.addHours(now, jam),
      is_active: true
    });
  } catch (e) {
    console.error('pushNotif gagal: ' + e.message);
  }
}

function bumpPulse_(role) {
  if (!role) return;
  var cache = CacheService.getScriptCache();
  var key = 'ELS_PULSE_' + role;
  var cur = Number(cache.get(key) || 0);
  cache.put(key, String(cur + 1), 21600);
}

function getPulse_(role) {
  return Number(CacheService.getScriptCache().get('ELS_PULSE_' + role) || 0);
}

// ============================================================
// PEMETAAN NOTIFIKASI KE MENU
// Supaya badge muncul di menu yang tepat, bukan sekadar angka total.
// ============================================================

function menuNotif_(role, type) {
  var peta = {
    GUDANG: {
      NEW_ORDER: 'queue', ORDER_EDITED: 'queue', ORDER_REVISED: 'queue',
      RECALL: 'queue', MINTA_SN: 'queue'
    },

    // Tim Eksekusi mengerjakan tahapan yang sama, jadi
    // pemberitahuannya diarahkan ke menu yang sama pula
    EKSEKUSI: {
      NEW_ORDER: 'queue', ORDER_EDITED: 'queue', ORDER_REVISED: 'queue',
      RECALL: 'queue', SN_SELESAI: 'queue', GANTI_UNIT: 'ganti'
    },
    ADMIN: {
      NEW_ORDER: 'monitor',
      ORDER_READY: 'nota', ORDER_REVISED: 'monitor', ORDER_EDITED: 'monitor',
      STUCK: 'monitor', PAID: 'monitor', DONE: 'monitor', NEED_APPROVAL: 'approve'
    },
    KASIR: {
      NOTA_CREATED: 'pay', PAID: 'pay'
    },
    TEKNISI: {
      PAID: 'act'
    },
    SALES: {
      ORDER_READY: 'mytrx', NOTA_CREATED: 'mytrx', PAID: 'mytrx', DONE: 'mytrx'
    },
    SUPERADMIN: {
      SYNC_FAIL: 'produk', STUCK: 'monitor'
    }
  };
  var r = peta[role] || {};
  return r[type] || 'home';
}

// ============================================================
// API — RINGKASAN UNTUK BADGE
// ============================================================

/**
 * Satu panggilan ringan yang dipakai seluruh divisi.
 * Kalau pulse tidak berubah, sheet notifikasi tidak dibaca sama sekali.
 */
function apiPulse(payload) {
  return withGuard_(payload, {}, function (session) {
    var pulse = getPulse_(session.role);
    var hasil = { pulse: pulse, serverTime: nowIso_() };

    // Angka pekerjaan selalu dikirim, walau tidak ada pemberitahuan baru.
    //
    // Pekerjaan bisa berkurang tanpa memicu pemberitahuan apa pun —
    // misalnya Kasir menuntaskan pembayaran. Kalau angkanya hanya dikirim
    // saat ada pemberitahuan, badge-nya tertinggal dan menampilkan
    // pekerjaan yang sebenarnya sudah selesai.
    hasil.kerja = hitungPekerjaan_(session);

    if (payload.lastPulse !== undefined && Number(payload.lastPulse) === pulse) {
      hasil.changed = false;
      return hasil;
    }

    hasil.changed = true;
    hasil.notif = ringkasNotif_(session);
    return hasil;
  });
}

/**
 * Menghitung pekerjaan yang benar-benar masih menunggu di tiap menu.
 *
 * Angka di samping menu dulu diambil dari jumlah pemberitahuan yang
 * belum dibaca. Itu keliru: pemberitahuan menumpuk walaupun
 * pekerjaannya sudah selesai, sehingga angkanya tidak pernah cocok
 * dengan isi layarnya — dan lama-lama tidak dipercaya siapa pun.
 *
 * Sekarang angkanya dihitung dari keadaan transaksi. Begitu pekerjaan
 * selesai, angkanya turun sendiri tanpa perlu ada yang menandai apa pun.
 */
function hitungPekerjaan_(session) {
  var kunci = 'ELS_KERJA_' + session.role + '_' + session.branch;
  var cache = CacheService.getScriptCache();
  var hit = cache.get(kunci);
  if (hit) {
    try { return JSON.parse(hit); } catch (e) {}
  }

  var out = {};

  try {
    var semuaCabang = hasPerm_(session, 'TRX_VIEW_ALL');

    var rows = Repo.columns(DB.SHEET.TRX, [
      'trx_id', 'branch', 'stage_status', 'payment_status',
      'nota_no', 'nota_indent', 'activation_done_at', 'channel',
      'override_flags', 'is_void'
    ]);

    var gudang = 0, gudangOnline = 0, nota = 0, bayar = 0, aktivasi = 0, ambil = 0;

    for (var i = 0; i < rows.length; i++) {
      var t = rows[i];
      if (Util.isTrue(t.is_void)) continue;
      if (String(t.stage_status) === 'DIBATALKAN') continue;
      if (!semuaCabang && String(t.branch) !== String(session.branch)) continue;

      var st = String(t.stage_status);

      /*
       * Pekerjaan penyiapan dihitung terpisah per saluran.
       *
       * Gudang dan Eksekusi berbagi tahapan yang sama, jadi kalau
       * dihitung jadi satu, angka di menu keduanya menunjukkan
       * pekerjaan yang bukan miliknya — dan alarm berbunyi untuk
       * pesanan yang ditangani divisi sebelah.
       */
      if (st === 'MENUNGGU_GUDANG' || st === 'PROSES_GUDANG') {
        if (String(t.channel || 'RITEL').toUpperCase() === 'ONLINE') gudangOnline++;
        else gudang++;
      }
      else if (st === 'SIAP_NOTA') nota++;
      // Pesanan indent yang belum punya nota pesanan juga pekerjaan Admin
      else if (st === 'MENUNGGU_BARANG' && !String(t.nota_indent || '').trim()) nota++;
      else if (st === 'MENUNGGU_PEMBAYARAN') bayar++;
      else if (st === 'MENUNGGU_AKTIVASI' || st === 'PROSES_AKTIVASI') aktivasi++;
      else if (st === 'SELESAI' || st === 'AKTIVASI_SELESAI') {
        /*
         * Tidak dibatasi hari ini.
         *
         * Unit yang selesai kemarin tapi belum ditandai diserahkan
         * tetap pekerjaan yang menunggu. Kalau dibatasi per hari,
         * angkanya bersih setiap pagi padahal barangnya masih
         * menggantung — dan tidak ada lagi yang mengingatkan.
         */
        var f = {};
        try { f = JSON.parse(String(t.override_flags || '') || '{}'); } catch (e) {}
        if (!(f.diserahkan && f.diserahkan.at)) ambil++;
      }

      // DP yang belum lunas tetap pekerjaan Kasir walau tahapnya sudah lewat
      if (st !== 'MENUNGGU_PEMBAYARAN' &&
          (String(t.nota_no || '').trim() || String(t.nota_indent || '').trim()) &&
          String(t.payment_status) === 'DP') bayar++;
    }

    if (session.role === 'GUDANG') out.queue = gudang;
    else if (session.role === 'EKSEKUSI') out.queue = gudangOnline;
    else if (session.role === 'ADMIN') {
      out.nota = nota;
      // Pesanan yang masih di Gudang ikut ditampilkan, supaya Admin bisa
      // menyiapkan notanya di aplikasi perusahaan sambil menunggu barang
      // disiapkan — bukan baru mulai setelah Gudang selesai.
      out.monitor = gudang + gudangOnline;
    }
    else if (session.role === 'KASIR') out.pay = bayar;
    else if (session.role === 'TEKNISI') out.act = aktivasi + ambil;
    else if (session.role === 'SUPERADMIN') {
      out.queue = gudang; out.monitor = nota; out.pay = bayar; out.act = aktivasi + ambil;
    }
  } catch (e) {}

  // Disimpan 20 detik. Cukup segar untuk terasa langsung, tapi tidak
  // membaca ulang seluruh sheet setiap 12 detik untuk tiap orang.
  try { cache.put(kunci, JSON.stringify(out), 20); } catch (e2) {}

  return out;
}

function ringkasNotif_(session) {
  var rows = Repo.columns(DB.SHEET.NOTIF, [
    'notif_id', 'created_at', 'target_role', 'target_branch', 'target_user_id',
    'trx_id', 'trx_no', 'type', 'priority', 'title', 'body', 'read_by',
    'expires_at', 'is_active'
  ]);

  var perMenu = {}, daftar = [], total = 0, penting = 0;

  for (var i = 0; i < rows.length; i++) {
    var n = rows[i];
    if (!Util.isTrue(n.is_active)) continue;
    if (Util.isPast(n.expires_at)) continue;
    if (String(n.target_role) !== session.role) continue;
    if (n.target_branch && String(n.target_branch) !== String(session.branch)) continue;
    if (String(n.read_by || '').indexOf(session.user_id) >= 0) continue;

    var menu = menuNotif_(session.role, String(n.type));
    perMenu[menu] = (perMenu[menu] || 0) + 1;
    total++;
    if (String(n.priority) === 'HIGH') penting++;

    daftar.push({
      notif_id: String(n.notif_id),
      at: Util.isoStr(n.created_at),
      trx_id: String(n.trx_id || ''), trx_no: String(n.trx_no || ''),
      type: String(n.type), priority: String(n.priority),
      title: String(n.title), body: String(n.body),
      menu: menu
    });
  }

  daftar.sort(function (a, b) { return a.at < b.at ? 1 : -1; });

  return {
    total: total, penting: penting, perMenu: perMenu,
    list: daftar.slice(0, 40)
  };
}

function apiMyNotifications(payload) {
  return withGuard_(payload, {}, function (session) {
    return ringkasNotif_(session);
  });
}

function apiMarkNotifRead(payload) {
  return withGuard_(payload, { lock: 'ringan' }, function (session) {
    var ids = payload.notif_ids || [];
    var semua = Util.isTrue(payload.semua);

    var pilih = {};
    ids.forEach(function (id) { pilih[String(id)] = true; });

    /*
     * Ditulis sekali untuk semua baris, bukan satu per satu.
     *
     * Fungsi ini dipanggil ratusan kali sehari. Dulu tiap baris berarti
     * satu penulisan terpisah ke spreadsheet — dan karena ikut mengantre
     * bersama penyimpanan transaksi, orang yang sedang melayani customer
     * ikut menunggu penanda notifikasi selesai ditulis.
     */
    var sh = Repo.sheet(DB.SHEET.NOTIF);
    var head = Repo.headers(DB.SHEET.NOTIF);
    var iRead = head.indexOf('read_by');
    var lr = sh.getLastRow();
    if (iRead < 0 || lr < 2) return { marked: 0, notif: ringkasNotif_(session) };

    var rows = Repo.columns(DB.SHEET.NOTIF, [
      'notif_id', 'target_role', 'target_branch', 'read_by', 'is_active'
    ]);

    var kolom = sh.getRange(2, iRead + 1, lr - 1, 1).getValues();
    var n = 0, ubah = false;

    for (var i = 0; i < rows.length && i < kolom.length; i++) {
      var r = rows[i];
      if (!Util.isTrue(r.is_active)) continue;
      if (String(r.target_role) !== session.role) continue;
      if (r.target_branch && String(r.target_branch) !== String(session.branch)) continue;
      if (!semua && !pilih[String(r.notif_id)]) continue;

      var read = String(r.read_by || '');
      if (read.indexOf(session.user_id) >= 0) continue;

      kolom[i][0] = read ? read + ',' + session.user_id : session.user_id;
      ubah = true;
      n++;
    }

    if (ubah) {
      sh.getRange(2, iRead + 1, kolom.length, 1).setValues(kolom);
      Repo.bustSheet(DB.SHEET.NOTIF);
    }

    bumpPulse_(session.role);
    return { marked: n, notif: ringkasNotif_(session) };
  });
}

// ============================================================
// API — SALES MEMANGGIL GUDANG
// ============================================================

/**
 * Tombol untuk Sales saat pesanannya lama tidak disentuh Gudang.
 *
 * Ada jeda minimal supaya tidak jadi alat menekan gudang secara
 * berlebihan, dan setiap penggunaannya tercatat. Kalau suatu saat ada
 * gesekan antar divisi, datanya ada — bukan saling mengaku.
 */
function apiPanggilGudang(payload) {
  return withGuard_(payload, { permission: 'GUDANG_RECALL', lock: true }, function (session) {
    var trx = Repo.findOne(DB.SHEET.TRX, 'trx_id', payload.trx_id);
    if (!trx) throw appErr_('NOT_FOUND', 'Transaksi tidak ditemukan.');

    var stage = String(trx.stage_status);
    if (['MENUNGGU_GUDANG', 'PROSES_GUDANG'].indexOf(stage) < 0) {
      throw appErr_('STAGE_LOCKED',
        'Pesanan ini tidak sedang di Gudang. Status sekarang: ' + stageLabel_(stage) + '.');
    }

    var flags = {};
    try { flags = JSON.parse(String(trx.override_flags || '') || '{}'); } catch (e) {}

    var jeda = Settings.num('RECALL_COOLDOWN_SEC', 120);
    if (flags.recall && flags.recall.at) {
      var lewat = Math.round((new Date().getTime() - new Date(flags.recall.at).getTime()) / 1000);
      if (lewat < jeda) {
        throw appErr_('COOLDOWN',
          'Gudang baru saja dipanggil. Tunggu ' + (jeda - lewat) + ' detik lagi.');
      }
    }

    var jumlah = (flags.recall ? Number(flags.recall.jumlah) || 0 : 0) + 1;
    flags.recall = { at: nowIso_(), by: session.full_name, jumlah: jumlah };
    Repo.update(DB.SHEET.TRX, trx._row, { override_flags: JSON.stringify(flags) });

    var menit = trx.sales_confirm_at
      ? Math.round((new Date().getTime() -
          new Date(Util.isoStr(trx.sales_confirm_at)).getTime()) / 60000)
      : 0;

    pushNotif_({
      target_role: peranPenyiap_(trx), target_branch: trx.branch,
      trx_id: trx.trx_id, trx_no: trx.trx_no,
      type: 'RECALL', priority: 'HIGH',
      title: 'Ditunggu Sales',
      body: trx.trx_no + ' · ' + trx.cust_name_snap + ' · sudah menunggu ' + menit + ' menit' +
            (payload.catatan ? ' · ' + String(payload.catatan).substring(0, 120) : '')
    });

    logAudit_(session, {
      entity: 'TRX', entity_id: trx.trx_id, trx_no: trx.trx_no,
      action: 'UPDATE', field: 'panggil_gudang',
      old_value: 'panggilan ke-' + (jumlah - 1), new_value: 'panggilan ke-' + jumlah,
      reason: payload.catatan || ''
    });
    logTimeline_(session, {
      trx_id: trx.trx_id, trx_no: trx.trx_no,
      event_code: 'GUDANG_RECALL', stage_after: stage,
      event_label: 'Sales ' + session.full_name + ' memanggil Gudang' +
        (jumlah > 1 ? ' (panggilan ke-' + jumlah + ')' : ''),
      detail: 'Sudah menunggu ' + menit + ' menit' +
        (payload.catatan ? ' · ' + String(payload.catatan) : '')
    });

    return { jumlah: jumlah, menit: menit, jeda: jeda };
  });
}

// ============================================================
// DETEKSI TRANSAKSI TERTAHAN — dijalankan trigger berkala
// ============================================================

/**
 * Transaksi yang diam terlalu lama di satu tahap diberitahukan ke
 * divisi pemiliknya DAN ke Admin.
 *
 * Yang kedua yang penting: kalau cuma divisi yang sama diberi tahu
 * berulang kali, masalahnya berputar di situ saja. Menaikkannya ke
 * Admin membuatnya sampai ke orang yang bisa menindaklanjuti.
 */
function cekTransaksiTertahan() {
  var batas = Settings.num('STUCK_ALERT_MIN', 30);
  var sekarang = new Date().getTime();

  var pemilik = {
    MENUNGGU_GUDANG: 'GUDANG', PROSES_GUDANG: 'GUDANG',
    SIAP_SERAH: 'EKSEKUSI',
    SIAP_NOTA: 'ADMIN',
    MENUNGGU_PEMBAYARAN: 'KASIR',
    MENUNGGU_AKTIVASI: 'TEKNISI', PROSES_AKTIVASI: 'TEKNISI'
  };

  var rows = Repo.all(DB.SHEET.TRX);
  var n = 0;

  for (var i = 0; i < rows.length; i++) {
    var t = rows[i];
    if (Util.isTrue(t.is_void)) continue;

    var stage = String(t.stage_status);
    var role = pemilik[stage];
    if (!role) continue;

    var acuan = Util.isoStr(t.updated_at) || Util.isoStr(t.created_at);
    if (!acuan) continue;

    var menit = Math.round((sekarang - new Date(acuan).getTime()) / 60000);
    if (menit < batas) continue;

    var flags = {};
    try { flags = JSON.parse(String(t.override_flags || '') || '{}'); } catch (e) {}

    // Jangan mengulang terlalu sering — sekali, lalu diulang setelah
    // dua kali lipat ambang batasnya
    if (flags.stuck && flags.stuck.at) {
      var jarak = Math.round((sekarang - new Date(flags.stuck.at).getTime()) / 60000);
      if (jarak < batas * 2) continue;
    }

    flags.stuck = { at: nowIso_(), stage: stage, menit: menit };
    Repo.update(DB.SHEET.TRX, t._row, { override_flags: JSON.stringify(flags) });

    var isi = String(t.trx_no) + ' · ' + String(t.cust_name_snap) +
              ' · tertahan ' + menit + ' menit di ' + stageLabel_(stage);

    pushNotif_({
      target_role: role, target_branch: t.branch,
      trx_id: t.trx_id, trx_no: t.trx_no,
      type: 'STUCK', priority: 'HIGH',
      title: 'Transaksi tertahan', body: isi
    });

    if (role !== 'ADMIN') {
      pushNotif_({
        target_role: 'ADMIN', target_branch: t.branch,
        trx_id: t.trx_id, trx_no: t.trx_no,
        type: 'STUCK', priority: 'NORMAL',
        title: 'Transaksi tertahan di ' + role, body: isi
      });
    }

    logTimeline_(null, {
      trx_id: t.trx_id, trx_no: t.trx_no,
      event_code: 'STUCK', stage_after: stage,
      event_label: 'Sistem menandai transaksi tertahan',
      detail: menit + ' menit di ' + stageLabel_(stage)
    });

    n++;
  }

  flushLog_();
  return n;
}

function pasangJadwalTertahan() {
  hapusJadwalTertahan();
  ScriptApp.newTrigger('cekTransaksiTertahan').timeBased().everyMinutes(15).create();
  return kabar_('Pemeriksaan transaksi tertahan dipasang setiap 15 menit.\n\n' +
    'Ambang batasnya diatur di SETTINGS pada STUCK_ALERT_MIN (sekarang ' +
    Settings.num('STUCK_ALERT_MIN', 30) + ' menit).');
}

function hapusJadwalTertahan() {
  var n = 0;
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'cekTransaksiTertahan') { ScriptApp.deleteTrigger(t); n++; }
  });
  return n;
}

// ============================================================
// PEMBERSIHAN — dijalankan trigger harian
// ============================================================

/**
 * Membuang notifikasi yang sudah lewat masa simpannya.
 *
 * Sheet ini yang paling sering dibaca — setiap pengecekan berkala
 * menyentuhnya. Makin ramping isinya, makin murah seluruh sistem.
 */
function bersihkanNotifLama() {
  var sh = Repo.sheet(DB.SHEET.NOTIF);
  var rows = Repo.all(DB.SHEET.NOTIF);
  var buang = [];

  for (var i = 0; i < rows.length; i++) {
    if (Util.isPast(rows[i].expires_at)) { buang.push(rows[i]._row); continue; }
    // Yang sudah dibaca semua orang tidak perlu menunggu kedaluwarsa
    if (String(rows[i].read_by || '').trim()) buang.push(rows[i]._row);
  }

  // Dihapus dari bawah ke atas supaya nomor barisnya tidak bergeser
  buang.sort(function (a, b) { return b - a; });
  for (var j = 0; j < buang.length; j++) sh.deleteRow(buang[j]);

  Repo.bustSheet(DB.SHEET.NOTIF);
  return buang.length;
}

function pasangJadwalBersihNotif() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'bersihkanNotifLama') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('bersihkanNotifLama')
    .timeBased().everyHours(6).create();
  return kabar_('Pembersihan notifikasi dipasang setiap 6 jam.\n\n' +
    'Notifikasi yang sudah dibaca langsung dibuang, sisanya setelah ' +
    Settings.num('NOTIF_KEEP_HOURS', 24) + ' jam.');
}
