/**
 * ELS.ID WORKFLOW SYSTEM
 * File : 24_MenuService.gs
 * Isi  : Pengaturan menu — per divisi oleh Super Admin, dan urutan
 *        per akun oleh pemakainya sendiri.
 *
 * Dua tingkat, dengan pembagian yang jelas:
 *
 *   Super Admin menentukan menu APA SAJA yang boleh dilihat sebuah
 *   divisi. Itu urusan wewenang — Kasir tidak perlu melihat Master
 *   Barang, dan menyembunyikannya mengurangi salah klik.
 *
 *   Pemakai menentukan URUTANNYA. Itu urusan kebiasaan kerja —
 *   orang yang seharian di Cetak Resep ingin menu itu di atas,
 *   dan tidak ada gunanya memaksakan urutan yang sama untuk semua.
 *
 * Pemakai tidak bisa memunculkan menu yang disembunyikan untuknya.
 * Menyusun ulang bukan menambah wewenang.
 */

/** Menu bawaan tiap divisi — dipakai kalau belum pernah diatur */
function menuBawaan_(peran) {
  var umum = ['home', 'pesan', 'notif'];

  var peta = {
    SALES: ['home', 'order', 'mytrx', 'cust', 'resep', 'indent', 'pesan', 'notif'],
    SALES_ONLINE: ['home', 'order', 'mytrx', 'cari', 'cust', 'resep', 'indent',
                   'pesan', 'notif'],
    GUDANG: ['home', 'queue', 'done', 'resep', 'ganti', 'lacak', 'sn', 'pantau',
             'pesan', 'notif'],
    EKSEKUSI: ['home', 'queue', 'serah', 'indent', 'done', 'cari', 'resep',
               'ganti', 'lacak', 'pantau', 'pesan', 'notif'],
    ADMIN: ['home', 'monitor', 'resep', 'etc', 'indent', 'ganti', 'cust',
            'pantau', 'pesan', 'notif'],
    KASIR: ['home', 'pay', 'hist', 'pantau', 'pesan', 'notif'],
    TEKNISI: ['home', 'act', 'panggil', 'riwakt', 'kerja', 'lapteknisi',
              'pantau', 'pesan', 'notif'],
    SUPERADMIN: null      // Super Admin selalu melihat semuanya
  };

  return peta[String(peran)] || umum;
}

function kunciMenuRole_(peran) {
  return 'MENU_' + String(peran).toUpperCase();
}

/**
 * Menu yang berlaku untuk sesi ini.
 *
 * Tiga lapis: bawaan divisi, pengaturan Super Admin, lalu urutan
 * pilihan orangnya sendiri. Lapis terakhir hanya boleh menyusun
 * ulang — menu yang tidak diizinkan tetap tidak muncul.
 */
function apiMenuSaya(payload) {
  return withGuard_(payload, {}, function (session) {
    var peran = String(session.role);

    var izin = menuRoleAktif_(peran);
    var urut = [];

    try {
      var u = Repo.findOne(DB.SHEET.USERS, 'user_id', session.user_id);
      if (u && u.menu_urut) {
        urut = String(u.menu_urut).split(',')
          .map(function (x) { return x.trim(); })
          .filter(function (x) { return x; });
      }
    } catch (e) {}

    return {
      izin: izin,            // null berarti semua menu bawaan perannya
      urut: urut,
      peran: peran
    };
  });
}

function menuRoleAktif_(peran) {
  if (String(peran) === 'SUPERADMIN') return null;

  var simpan = String(Settings.get(kunciMenuRole_(peran), '') || '').trim();
  if (!simpan) return menuBawaan_(peran);

  return simpan.split(',').map(function (x) { return x.trim(); })
    .filter(function (x) { return x; });
}

/** Super Admin mengatur menu sebuah divisi */
function apiMenuSimpanRole(payload) {
  return withGuard_(payload, { permission: 'SETTING_MANAGE', lock: 'ringan' }, function (session) {
    var peran = String(payload.peran || '').toUpperCase();
    if (!peran || DB.ROLES.indexOf(peran) < 0) {
      throw appErr_('BAD_ROLE', 'Divisi tidak dikenal.');
    }

    var keys = (payload.keys || []).map(function (x) { return String(x).trim(); })
                 .filter(function (x) { return x; });

    /*
     * Beranda tidak bisa dibuang.
     *
     * Itu satu-satunya layar yang pasti bisa dibuka siapa pun. Tanpa
     * itu, salah atur berarti orangnya masuk ke aplikasi tanpa satu
     * pun menu — dan tidak bisa memperbaikinya sendiri.
     */
    if (keys.indexOf('home') < 0) keys.unshift('home');

    simpanSetting_(kunciMenuRole_(peran), keys.join(','),
      'Menu yang terlihat oleh divisi ' + Fmt_roleLabel_(peran) +
      ', berurutan. Dikosongkan berarti memakai bawaan.');

    logAudit_(session, {
      entity: 'SETTING', entity_id: kunciMenuRole_(peran), action: 'UPDATE',
      new_value: keys.join(',')
    });
    flushLog_();

    return { ok: true, jumlah: keys.length };
  });
}

/** Pemakai menyusun ulang urutan menunya sendiri */
function apiMenuSimpanSaya(payload) {
  return withGuard_(payload, { lock: 'ringan' }, function (session) {
    var keys = (payload.keys || []).map(function (x) { return String(x).trim(); })
                 .filter(function (x) { return x; });

    var u = Repo.findOne(DB.SHEET.USERS, 'user_id', session.user_id);
    if (!u) throw appErr_('NOT_FOUND', 'Akun tidak ditemukan.');

    /*
     * Disimpan di barisnya sendiri, bukan di browser.
     *
     * Satu orang bisa berpindah komputer — di meja kasir pagi, di
     * gudang sore. Urutan yang tersimpan di browser ikut hilang
     * setiap kali itu terjadi.
     */
    Repo.update(DB.SHEET.USERS, u._row, { menu_urut: keys.join(',') });

    return { ok: true };
  });
}

/** Menyimpan satu baris SETTINGS tanpa menimpa yang lain */
function simpanSetting_(kunci, nilai, keterangan) {
  var sh = Repo.sheet(DB.SHEET.SETTINGS);
  var lr = sh.getLastRow(), lc = sh.getLastColumn();

  var head = sh.getRange(1, 1, 1, lc).getValues()[0]
               .map(function (v) { return String(v).trim(); });
  var iKey = head.indexOf('key'), iVal = head.indexOf('value');
  if (iKey < 0 || iVal < 0) throw appErr_('NO_COL', 'Sheet SETTINGS tidak lengkap.');

  var vals = lr > 1 ? sh.getRange(2, 1, lr - 1, lc).getValues() : [];
  for (var i = 0; i < vals.length; i++) {
    if (String(vals[i][iKey]).trim() === kunci) {
      sh.getRange(i + 2, iVal + 1).setValue(nilai);
      SpreadsheetApp.flush();
      Settings.bust();
      return;
    }
  }

  sh.getRange(sh.getLastRow() + 1, 1, 1, 7).setValues([[
    kunci, nilai, 'TEXT', 'MENU', keterangan || '', nowIso_(), 'SETUP'
  ]]);
  SpreadsheetApp.flush();
  Settings.bust();
}

/** Daftar menu sebuah divisi, untuk layar pengaturan Super Admin */
function apiMenuRole(payload) {
  return withGuard_(payload, { permission: 'SETTING_MANAGE' }, function () {
    var peran = String(payload.peran || '').toUpperCase();
    if (!peran) throw appErr_('BAD_ROLE', 'Divisi belum dipilih.');

    return {
      peran: peran,
      aktif: menuRoleAktif_(peran) || menuBawaan_(peran),
      bawaan: menuBawaan_(peran),
      diatur: !!String(Settings.get(kunciMenuRole_(peran), '') || '').trim()
    };
  });
}

/** Mengembalikan menu sebuah divisi ke bawaannya */
function apiMenuReset(payload) {
  return withGuard_(payload, { permission: 'SETTING_MANAGE', lock: 'ringan' }, function (session) {
    var peran = String(payload.peran || '').toUpperCase();
    if (!peran) throw appErr_('BAD_ROLE', 'Divisi belum dipilih.');

    simpanSetting_(kunciMenuRole_(peran), '', 'Dikosongkan berarti memakai bawaan.');

    logAudit_(session, {
      entity: 'SETTING', entity_id: kunciMenuRole_(peran), action: 'UPDATE',
      new_value: '(kembali ke bawaan)'
    });
    flushLog_();

    return { ok: true };
  });
}
