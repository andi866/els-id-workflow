/**
 * ELS.ID WORKFLOW SYSTEM — Phase 1
 * File : 03_Auth.gs
 * Isi  : Login, sesi, hak akses, dan pembungkus keamanan withGuard_.
 *
 * PENTING: withGuard_ adalah satu-satunya pintu operasi yang butuh sesi.
 * Dengan begitu tidak mungkin ada fungsi baru yang lupa mengecek role
 * atau lupa memasang kunci antre — karena pengecekannya dikerjakan
 * pembungkusnya, bukan oleh yang menulis fungsinya.
 */

// ============================================================
// MATRIKS HAK AKSES
// ============================================================

var PERM = {
  SUPERADMIN: ['*'],

  SALES: [
    'CUSTOMER_VIEW', 'CUSTOMER_VIEW_BASIC', 'CUSTOMER_CREATE', 'CUSTOMER_EDIT',
    'RESEP_PRINT',
    'TRX_CREATE', 'TRX_VIEW_OWN', 'TRX_EDIT_OWN',
    'ITEM_ADD', 'ITEM_EDIT_QTY', 'ITEM_EDIT_PRICE_LIMITED', 'ITEM_ADD_MANUAL', 'ITEM_VOID',
    'TRX_CONFIRM_SALES', 'GUDANG_RECALL',
    'PRODUCT_VIEW', 'PRODUCT_SYNC_RUN',
    'TIMELINE_VIEW', 'PAYMENT_VIEW_SUMMARY'
  ],

  /*
   * Sales Online — akun divisi tersendiri.
   *
   * Izinnya sama persis dengan Sales NB karena pekerjaannya sama:
   * menerima pesanan, menyusun barang, mengonfirmasi. Yang dipisah
   * bukan apa yang boleh dilakukan, melainkan apa yang dilihat —
   * masing-masing hanya melihat pesanannya sendiri, tidak tercampur.
   *
   * Dengan begitu Sales NB tidak perlu memilah pesanan online di
   * daftarnya, dan sebaliknya.
   */
  SALES_ONLINE: [
    'CUSTOMER_VIEW', 'CUSTOMER_VIEW_BASIC', 'CUSTOMER_CREATE', 'CUSTOMER_EDIT',
    'RESEP_PRINT',
    'TRX_CREATE', 'TRX_VIEW_OWN', 'TRX_EDIT_OWN',
    'ITEM_ADD', 'ITEM_EDIT_QTY', 'ITEM_EDIT_PRICE_LIMITED', 'ITEM_ADD_MANUAL', 'ITEM_VOID',
    'TRX_CONFIRM_SALES', 'GUDANG_RECALL',
    'PRODUCT_VIEW',
    'TIMELINE_VIEW', 'PAYMENT_VIEW_SUMMARY'
  ],

  GUDANG: [
    'CUSTOMER_VIEW_BASIC',
    'TRX_VIEW_STAGE', 'ITEM_VIEW',
    'SN_INPUT', 'ITEM_MARK_PREPARED', 'TRX_CONFIRM_GUDANG',
    'PRODUCT_VIEW', 'PRODUCT_SYNC_RUN',
    'TIMELINE_VIEW'
  ],

  /*
   * Tim Eksekusi — penyiap barang untuk pesanan online.
   *
   * Pekerjaannya sama persis dengan Gudang: cetak resep, ambil
   * barangnya, isi serial number, teruskan ke Admin. Yang berbeda
   * cuma sumber pesanannya.
   *
   * Jadi izinnya disamakan, dan yang memisahkan keduanya bukan
   * tahapan baru melainkan penyaring antrian: Gudang melihat pesanan
   * ritel, Eksekusi melihat pesanan online. Satu alur, dua pintu
   * masuk — persis seperti yang disepakati waktu merancangnya.
   */
  EKSEKUSI: [
    'CUSTOMER_VIEW_BASIC',
    'TRX_VIEW_STAGE', 'ITEM_VIEW',
    'SN_INPUT', 'ITEM_MARK_PREPARED', 'TRX_CONFIRM_GUDANG',
    'PRODUCT_VIEW',
    'RESEP_PRINT',
    'TIMELINE_VIEW'
  ],

  ADMIN: [
    'CUSTOMER_VIEW', 'CUSTOMER_VIEW_BASIC', 'CUSTOMER_CREATE', 'CUSTOMER_EDIT',
    'TRX_CREATE', 'TRX_VIEW_ALL', 'TRX_EDIT_ALL',
    'ITEM_ADD', 'ITEM_EDIT_QTY', 'ITEM_EDIT_PRICE', 'ITEM_ADD_MANUAL', 'ITEM_VOID',
    'SN_INPUT', 'PRICE_APPROVE',
    'RESEP_PRINT', 'NOTA_INPUT',
    'PRODUCT_VIEW', 'PRODUCT_SYNC_RUN',
    'TIMELINE_VIEW', 'AUDIT_VIEW', 'PAYMENT_VIEW_DETAIL',
    'REPORT_VIEW'
  ],

  KASIR: [
    'CUSTOMER_VIEW_BASIC',
    'TRX_VIEW_STAGE', 'ITEM_VIEW',
    'PAYMENT_ADD', 'PAYMENT_VIEW_DETAIL',
    'CUSTOMER_CALL',
    'TIMELINE_VIEW'
  ],

  TEKNISI: [
    'CUSTOMER_VIEW_BASIC',
    'TRX_VIEW_STAGE', 'ITEM_VIEW', 'SN_VIEW', 'SN_INPUT',
    'ACTIVATION_START', 'ACTIVATION_DONE', 'CUSTOMER_CALL',
    'TIMELINE_VIEW', 'PAYMENT_VIEW_SUMMARY'
  ]
};

/** Izin khusus Super Admin yang tidak dimiliki role lain (untuk ditampilkan di UI) */
var SUPER_ONLY = [
  'USER_MANAGE', 'ROLE_MANAGE', 'SETTING_MANAGE',
  'TRX_VOID', 'TRX_REOPEN', 'PAYMENT_VOID', 'GUARD_OVERRIDE', 'BACKUP_RUN'
];

function permissionsOf_(role) {
  var p = PERM[role] || [];
  if (p.indexOf('*') >= 0) {
    var allPerms = [];
    Object.keys(PERM).forEach(function (r) {
      (PERM[r] || []).forEach(function (c) {
        if (c !== '*' && allPerms.indexOf(c) < 0) allPerms.push(c);
      });
    });
    return allPerms.concat(SUPER_ONLY);
  }
  var out = p.slice();
  p.forEach(function (k) {
    (PERM_MENCAKUP[k] || []).forEach(function (t) {
      if (out.indexOf(t) < 0) out.push(t);
    });
  });
  return out;
}

/**
 * Izin yang lebih tinggi otomatis mencakup yang lebih rendah.
 *
 * Tanpa ini pernah terjadi: Sales punya CUSTOMER_VIEW (lihat data
 * lengkap) tapi ditolak saat mencari customer, karena yang diminta
 * CUSTOMER_VIEW_BASIC (lihat sekadar nama dan nomor) — izin yang
 * lebih kecil, tapi tidak tertulis di daftarnya.
 *
 * Daftar ini menutup jenis kesalahan itu untuk seterusnya.
 */
var PERM_MENCAKUP = {
  CUSTOMER_VIEW:      ['CUSTOMER_VIEW_BASIC'],
  CUSTOMER_EDIT:      ['CUSTOMER_VIEW_BASIC', 'CUSTOMER_VIEW'],
  TRX_VIEW_ALL:       ['TRX_VIEW_STAGE', 'TRX_VIEW_OWN'],
  TRX_EDIT_ALL:       ['TRX_EDIT_OWN', 'TRX_VIEW_STAGE', 'TRX_VIEW_OWN'],
  ITEM_EDIT_PRICE:    ['ITEM_EDIT_PRICE_LIMITED'],
  ITEM_ADD:           ['ITEM_VIEW'],
  SN_INPUT:           ['SN_VIEW'],
  PAYMENT_VIEW_DETAIL:['PAYMENT_VIEW_SUMMARY'],
  PAYMENT_ADD:        ['PAYMENT_VIEW_SUMMARY', 'PAYMENT_VIEW_DETAIL'],
  ACTIVATION_DONE:    ['ACTIVATION_START']
};

function hasPerm_(session, code) {
  if (!code) return true;

  var p = PERM[session.role] || [];
  if (p.indexOf('*') >= 0) return true;
  if (p.indexOf(code) >= 0) return true;

  // Dicari juga lewat izin yang mencakupnya
  for (var i = 0; i < p.length; i++) {
    var turunan = PERM_MENCAKUP[p[i]];
    if (turunan && turunan.indexOf(code) >= 0) return true;
  }
  return false;
}

// ============================================================
// LOGIN
// ============================================================

function login_(username, pin, device) {
  if (!username || !pin) throw appErr_('EMPTY', 'Username dan PIN wajib diisi.');

  var lock = LockService.getScriptLock();
  lock.tryLock(10000);
  try {
    var u = Repo.findOne(DB.SHEET.USERS, 'username', username);

    // Pesan sengaja sama untuk user tidak ada / PIN salah,
    // supaya tidak bisa dipakai menebak username mana yang terdaftar.
    if (!u) throw appErr_('BAD_CRED', 'Username atau PIN salah.');

    if (String(u.status) === 'SUSPENDED') {
      throw appErr_('SUSPENDED', 'Akun terkunci. Hubungi Super Admin untuk membukanya.');
    }
    if (String(u.status) === 'RESIGNED') {
      throw appErr_('INACTIVE', 'Akun sudah tidak aktif.');
    }

    var maxFail = Settings.num('MAX_FAILED_LOGIN', 5);

    if (hashPin_(u.pin_salt, pin) !== String(u.pin_hash)) {
      var fail = Number(u.failed_attempt || 0) + 1;
      var patch = { failed_attempt: fail };
      if (fail >= maxFail) patch.status = 'SUSPENDED';
      Repo.update(DB.SHEET.USERS, u._row, patch);

      logAuditRaw_({
        actor_user_id: u.user_id, actor_name: u.full_name, actor_role: u.role,
        entity: 'USER', entity_id: u.user_id, action: 'LOGIN_FAIL',
        new_value: 'percobaan ke-' + fail, source_page: device
      });

      if (fail >= maxFail) {
        throw appErr_('SUSPENDED', 'Akun terkunci setelah ' + maxFail +
          ' kali PIN salah. Hubungi Super Admin.');
      }
      throw appErr_('BAD_CRED', 'Username atau PIN salah. Sisa percobaan: ' + (maxFail - fail) + '.');
    }

    // Berhasil
    var now = nowIso_();
    Repo.update(DB.SHEET.USERS, u._row, { failed_attempt: 0, last_login_at: now });

    var token = Util.token();
    Repo.append(DB.SHEET.SESSIONS, {
      token: token,
      user_id: u.user_id,
      role: u.role,
      branch: u.branch,
      created_at: now,
      expires_at: Util.addHours(now, Settings.num('SESSION_HOURS', 168)),
      last_seen_at: now,
      device_info: device || '',
      is_revoked: false
    });

    var session = {
      token: token, user_id: u.user_id, username: u.username,
      full_name: u.full_name, role: u.role, branch: u.branch,
      division: u.division, must_change_pin: Util.isTrue(u.must_change_pin),

      /*
       * Kode sales ikut sejak masuk.
       *
       * Sempat tertinggal di sini: sesi yang dibaca ulang membawanya,
       * tapi sesi yang baru dibuat saat masuk tidak. Akibatnya
       * namanya baru terpasang setelah aplikasinya dibuka ulang —
       * dan orangnya tetap diminta memilih pada pesanan pertama.
       */
      sales_code: String(u.sales_code || '')
    };
    cacheSession_(token, session);

    logAuditRaw_({
      actor_user_id: u.user_id, actor_name: u.full_name, actor_role: u.role,
      entity: 'USER', entity_id: u.user_id, action: 'LOGIN',
      source_page: device, session_token_short: token.substring(0, 8)
    });

    return publicSession_(session);

  } finally {
    try { lock.releaseLock(); } catch (e) {}
  }
}

/** Data sesi yang boleh dikirim ke browser (token ikut, hash tidak pernah) */
function publicSession_(s) {
  return {
    token: s.token, user_id: s.user_id, username: s.username,
    full_name: s.full_name, role: s.role, branch: s.branch,
    division: s.division || '',
    must_change_pin: s.must_change_pin === true,

    /*
     * Kode sales ikut dikirim ke layar.
     *
     * Inilah yang membuat namanya tetap harus dipilih: kodenya
     * tersimpan dan terbaca di server, tapi disaring habis di sini
     * sebelum sampai ke layar — jadi layar tidak pernah tahu
     * akunnya milik siapa.
     */
    sales_code: String(s.sales_code || ''),

    permissions: permissionsOf_(s.role)
  };
}

// ============================================================
// SESI
// ============================================================

/*
 * Kunci salinan sesi diberi nomor versi.
 *
 * Isi sesi bertambah dari waktu ke waktu — kode sales, misalnya.
 * Salinan lama yang masih tersimpan tidak punya tambahan itu, dan
 * selama belum kedaluwarsa, yang terpakai tetap yang lama.
 *
 * Menaikkan nomornya membuat salinan lama diabaikan tanpa perlu
 * menunggu atau menghapus apa pun.
 */
function cacheKey_(token) { return 'ELS_SESS_V2_' + String(token).substring(0, 24); }

function cacheSession_(token, session) {
  CacheService.getScriptCache().put(cacheKey_(token), JSON.stringify(session), 300);
}

function clearSessionCache_(token) {
  CacheService.getScriptCache().remove(cacheKey_(token));
}

function readSession_(token) {
  if (!token) return null;

  var c = CacheService.getScriptCache().get(cacheKey_(token));
  if (c) return JSON.parse(c);

  var row = Repo.findOne(DB.SHEET.SESSIONS, 'token', token);
  if (!row) return null;
  if (Util.isTrue(row.is_revoked)) return null;
  if (Util.isPast(row.expires_at)) return null;

  var u = Repo.findOne(DB.SHEET.USERS, 'user_id', row.user_id);
  if (!u || String(u.status) !== 'ACTIVE') return null;

  /*
   * Masa berlaku diperpanjang selama dipakai.
   *
   * Keluhan dari iPhone: harus masuk ulang berkali-kali dalam
   * sehari. Sebabnya masa sesi dihitung dari saat masuk, bukan dari
   * pemakaian terakhir — orang yang bekerja seharian tetap terputus
   * begitu batasnya lewat, di tengah pekerjaan.
   *
   * Sekarang tiap kali dipakai, batasnya didorong maju. Yang
   * benar-benar ditinggalkan tetap kedaluwarsa dengan sendirinya.
   */
  try {
    var sisaJam = (new Date(Util.isoStr(row.expires_at)) - new Date()) / 3600000;
    var ttl = Settings.num('SESSION_HOURS', 168);

    if (sisaJam < ttl * 0.6) {
      Repo.update(DB.SHEET.SESSIONS, row._row, {
        expires_at: Util.addHours(new Date(), ttl),
        last_seen_at: nowIso_()
      });
    }
  } catch (eP) {}

  var session = {
    token: token, user_id: u.user_id, username: u.username,
    full_name: u.full_name, role: u.role, branch: u.branch,
    division: u.division, must_change_pin: Util.isTrue(u.must_change_pin),

    /*
     * Kode sales yang menempel pada akun ini.
     *
     * Kalau terisi, akunnya milik satu orang sales — namanya tidak
     * perlu dipilih lagi tiap membuat pesanan, dan yang terlihat
     * olehnya hanya penjualannya sendiri.
     *
     * Kalau kosong, akunnya dipakai bersama satu divisi seperti
     * selama ini. Dua-duanya tetap berjalan berdampingan.
     */
    sales_code: String(u.sales_code || ''),

    _row: row._row
  };
  cacheSession_(token, session);
  return session;
}

function requireSession_(token) {
  var s = readSession_(token);
  if (!s) throw appErr_('NO_SESSION', 'Sesi habis atau tidak dikenal. Silakan login lagi.');
  return s;
}

function touchSession_(token) {
  var row = Repo.findOne(DB.SHEET.SESSIONS, 'token', token);
  if (row) Repo.update(DB.SHEET.SESSIONS, row._row, { last_seen_at: nowIso_() });
}

function revokeSession_(token) {
  var row = Repo.findOne(DB.SHEET.SESSIONS, 'token', token);
  if (row) Repo.update(DB.SHEET.SESSIONS, row._row, { is_revoked: true });
  clearSessionCache_(token);
}

function revokeAllSessionsOf_(userId) {
  Repo.all(DB.SHEET.SESSIONS).forEach(function (r) {
    if (String(r.user_id) === String(userId) && !Util.isTrue(r.is_revoked)) {
      Repo.update(DB.SHEET.SESSIONS, r._row, { is_revoked: true });
      clearSessionCache_(r.token);
    }
  });
}

/** Dipasang sebagai trigger harian nanti — membersihkan sesi mati */
function cleanupSessions() {
  var rows = Repo.all(DB.SHEET.SESSIONS);
  var sh = Repo.sheet(DB.SHEET.SESSIONS);
  for (var i = rows.length - 1; i >= 0; i--) {
    if (Util.isPast(rows[i].expires_at) || Util.isTrue(rows[i].is_revoked)) {
      sh.deleteRow(rows[i]._row);
    }
  }
}

// ============================================================
// PEMBUNGKUS KEAMANAN
// ============================================================

/**
 * opts:
 *   permission     : kode izin yang dibutuhkan (opsional)
 *   lock           : true  → ambil kunci antre sebelum menulis
 *   allowPinChange : true  → boleh dijalankan meski user wajib ganti PIN
 *   idempotencyKey : nama field di payload yang berisi kunci sekali-pakai
 */
function withGuard_(payload, opts, fn) {
  opts = opts || {};
  var lock = null;
  var mulaiMs = new Date().getTime();
  try {
    var session = requireSession_(payload && payload.token);

    if (opts.permission && !hasPerm_(session, opts.permission)) {
      return err_('FORBIDDEN', 'Role ' + session.role + ' tidak punya akses untuk tindakan ini.');
    }

    if (session.must_change_pin && !opts.allowPinChange) {
      return err_('MUST_CHANGE_PIN', 'Ganti PIN Anda dulu sebelum melanjutkan.');
    }

    // Tolak kiriman ganda (tombol diklik dua kali / koneksi diulang)
    var idemKey = payload && payload.idem;
    if (idemKey) {
      var cache = CacheService.getScriptCache();
      var seen = cache.get('ELS_IDEM_' + idemKey);
      if (seen) return JSON.parse(seen);
    }

    /*
     * Kunci antre hanya untuk yang benar-benar perlu.
     *
     * Dulu semua penyimpanan mengambil kunci global — termasuk yang
     * cuma mengubah satu baris miliknya sendiri. Akibatnya Kasir
     * menunggu Sales, Sales menunggu Gudang, dan semuanya menunggu
     * penanda notifikasi yang sebenarnya tidak berebut apa pun.
     *
     * lock: 'ringan' = mengubah satu baris tertentu, tidak berebut
     *   dengan siapa pun. Tidak perlu antre.
     * lock: true = mengambil nomor urut, memeriksa keunikan SN atau
     *   nomor nota. Di situ dua orang bisa mendapat nomor yang sama
     *   kalau tidak diantrekan.
     */
    if (opts.lock && opts.lock !== 'ringan') {
      lock = LockService.getScriptLock();

      // Menunggu giliran lebih lama lebih baik daripada langsung menolak.
      // Menunggu 8 detik terasa lambat; ditolak lalu harus mengulang dari
      // awal terasa rusak — dan orangnya sedang berdiri di depan customer.
      if (!lock.tryLock(30000)) {
        return err_('LOCK_BUSY',
          'Beberapa orang menyimpan data bersamaan dan giliran Anda belum sampai. ' +
          'Tekan sekali lagi — data yang sudah Anda isi tidak hilang.');
      }
    }

    var result = ok_(fn(session, payload));

    if (idemKey) {
      CacheService.getScriptCache().put('ELS_IDEM_' + idemKey, JSON.stringify(result), 600);
    }
    return result;

  } catch (e) {
    // Dibungkus supaya kegagalan mencatat tidak menutupi kesalahan aslinya.
    // Dulu kalau fungsi ini belum ada, pesan error aslinya hilang dan yang
    // sampai ke layar cuma halaman kosong.
    try { dropLog_(); } catch (e9) {}

    var pesanAsli = (e && e.message) ? e.message : String(e || '');
    if (!pesanAsli) pesanAsli = 'Terjadi kesalahan tanpa keterangan di server.';
    return err_((e && e.code) || 'ERROR', pesanAsli);

  } finally {
    // Seluruh catatan yang terkumpul selama permintaan ini ditulis sekali
    try { flushLog_(); } catch (e3) {}
    if (lock) { try { lock.releaseLock(); } catch (e2) {} }
    /*
     * Penulisan yang masih tertunda dituntaskan sebelum permintaan
     * ditutup. Tanpa ini, perubahan yang dikumpulkan bisa hilang.
     */
    try { Repo.flushTunda(); } catch (eT) {}

    catatPemakaian_(new Date().getTime() - mulaiMs, payload && payload._fn);
  }
}

/**
 * Menjumlahkan lama pemrosesan hari ini, supaya pemakaian kuota bisa
 * dilihat tanpa menghitung manual dari daftar eksekusi.
 *
 * Disimpan di memori sementara, jadi angkanya perkiraan — bisa ikut
 * hilang kalau memori dibersihkan Google. Cukup untuk melihat pola,
 * bukan untuk tagihan.
 */
/**
 * Mengunci hanya bagian yang benar-benar bisa bentrok.
 *
 * Sebelumnya seluruh fungsi penyimpanan berjalan di dalam kunci: baca
 * data, tulis barang, catat riwayat, baca ulang — semuanya. Padahal
 * yang bisa bentrok antar orang cuma beberapa detik di tengahnya:
 * mengambil nomor urut, memeriksa nomor nota kembar, memeriksa serial
 * number kembar.
 *
 * Akibat mengunci semuanya: saat Gudang menyimpan, Sales dan Kasir
 * ikut menunggu walau mereka mengerjakan transaksi yang sama sekali
 * berbeda. Dari pengukuran, itu yang membuat satu penyimpanan bisa
 * memakan sembilan puluh detik pada jam ramai.
 *
 * Sekarang kuncinya dipegang hanya selama bagian yang rawan, biasanya
 * di bawah satu detik.
 */
function denganKunci_(fn, tungguMs) {
  var lock = LockService.getScriptLock();

  if (!lock.tryLock(tungguMs || 25000)) {
    throw appErr_('LOCK_BUSY',
      'Beberapa orang menyimpan data bersamaan dan giliran Anda belum sampai. ' +
      'Tekan sekali lagi — data yang sudah Anda isi tidak hilang.');
  }

  try {
    return fn();
  } finally {
    try { lock.releaseLock(); } catch (e) {}
  }
}

/* ============================================================
   Pengukur langkah

   Mengukur lama tiap bagian di dalam satu fungsi, bukan cuma
   totalnya. Tanpa ini, "penyimpanan sembilan detik" tidak memberi
   tahu apa pun tentang di mana sembilan detik itu habis — dan yang
   tersisa cuma menebak, yang sudah beberapa kali meleset.

   Pemakaian:
     var jam = Jam.mulai('apiConfirmWarehouse');
     ... kerjakan sesuatu ...
     jam.tandai('baca transaksi');
     ... kerjakan lagi ...
     jam.tandai('tulis SN');
     jam.selesai();
   ============================================================ */
var Jam = {
  mulai: function (nama) {
    var t0 = new Date().getTime();
    var lalu = t0;
    var langkah = [];

    return {
      tandai: function (label) {
        var kini = new Date().getTime();
        langkah.push([label, kini - lalu]);
        lalu = kini;
      },
      selesai: function () {
        try {
          var c = CacheService.getScriptCache();
          var hari = Utilities.formatDate(new Date(), 'Asia/Jakarta', 'yyyyMMdd');
          var kunci = 'ELS_STEP_' + hari + '_' + nama;

          var data = {};
          try { data = JSON.parse(c.get(kunci) || '{}'); } catch (e) {}

          langkah.forEach(function (x) {
            var k = x[0];
            if (!data[k]) data[k] = { n: 0, ms: 0, max: 0 };
            data[k].n++;
            data[k].ms += x[1];
            if (x[1] > data[k].max) data[k].max = x[1];
          });

          data._total = data._total || { n: 0, ms: 0, max: 0 };
          var total = new Date().getTime() - t0;
          data._total.n++;
          data._total.ms += total;
          if (total > data._total.max) data._total.max = total;

          c.put(kunci, JSON.stringify(data).substring(0, 90000), 21600);
        } catch (e) {}
      }
    };
  }
};

function catatPemakaian_(ms, namaFungsi) {
  try {
    var c = CacheService.getScriptCache();
    var hari = Utilities.formatDate(new Date(), 'Asia/Jakarta', 'yyyyMMdd');
    var kMs = 'ELS_USE_MS_' + hari;
    var kN = 'ELS_USE_N_' + hari;
    c.put(kMs, String(Number(c.get(kMs) || 0) + Math.max(ms, 0)), 21600);
    c.put(kN, String(Number(c.get(kN) || 0) + 1), 21600);

    // Rincian per fungsi. Tanpa ini, "lambat" cuma perasaan —
    // dengan ini ketahuan fungsi mana yang benar-benar memakan waktu.
    if (!namaFungsi) return;
    var kP = 'ELS_PERF_' + hari;
    var data = {};
    try { data = JSON.parse(c.get(kP) || '{}'); } catch (e2) {}

    var f = String(namaFungsi).substring(0, 40);
    if (!data[f]) data[f] = { n: 0, ms: 0, max: 0 };
    data[f].n++;
    data[f].ms += Math.max(ms, 0);
    if (ms > data[f].max) data[f].max = ms;

    c.put(kP, JSON.stringify(data).substring(0, 90000), 21600);
  } catch (e) {}
}
