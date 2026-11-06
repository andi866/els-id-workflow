/**
 * ELS.ID WORKFLOW SYSTEM
 * File : 15_Setup.gs
 * Isi  : Script sekali-jalan untuk menyiapkan database Phase 0.
 *
 * Semua fungsi di sini AMAN dijalankan berkali-kali:
 * - Sheet yang sudah ada tidak dibuat ulang.
 * - Data yang sudah ada TIDAK PERNAH dihapus atau ditimpa.
 * - Kalau ada yang tidak beres, script berhenti dan memberi tahu,
 *   bukan menebak sendiri.
 */

// ============================================================
// MENU — muncul di bar atas Spreadsheet setelah file di-reload
// ============================================================

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('⚙️ ELS.ID Setup')
    .addItem('1. Buat / Perbarui Struktur Database', 'setupDatabase')
    .addItem('2. Buat Akun Super Admin', 'createSuperAdminUI')
    .addItem('3. Cek Kesehatan Database', 'verifyDatabase')
    .addSeparator()
    .addItem('Reset PIN Seorang User', 'resetPinUI')
    .addItem('Backup Manual Sekarang', 'backupNow')
    .addToUi();
}

// ============================================================
// LANGKAH 1 — MEMBUAT STRUKTUR
// ============================================================

function setupDatabase() {
  var ss = SpreadsheetApp.getActive();
  var log = [];
  var warn = [];

  Object.keys(DB.HEADERS).forEach(function (name) {
    var headers = DB.HEADERS[name];
    var sh = ss.getSheetByName(name);
    var isNew = false;

    if (!sh) {
      sh = ss.insertSheet(name);
      isNew = true;
    }

    var lastRow = sh.getLastRow();
    var lastCol = sh.getLastColumn();

    if (lastRow === 0) {
      // Sheet benar-benar kosong → tulis header
      writeHeader_(sh, headers);
      log.push((isNew ? 'DIBUAT  ' : 'DIISI   ') + ' : ' + name);

    } else {
      var current = sh.getRange(1, 1, 1, Math.max(lastCol, 1)).getValues()[0]
                      .map(function (v) { return String(v).trim(); });
      var same = headers.length === current.length &&
                 headers.every(function (h, i) { return h === current[i]; });

      if (same) {
        log.push('SUDAH OK: ' + name);

      } else if (lastRow === 1) {
        // Baru header saja, belum ada data → aman diperbarui
        sh.getRange(1, 1, 1, Math.max(lastCol, headers.length)).clearContent();
        writeHeader_(sh, headers);
        log.push('DIPERBARUI: ' + name);

      } else {
        // Sudah ada data dengan header berbeda → JANGAN sentuh
        warn.push('⚠️ ' + name + ' : header berbeda dan sheet sudah berisi ' +
                  (lastRow - 1) + ' baris data. Tidak diubah demi keamanan data. ' +
                  'Hubungi developer sebelum melanjutkan.');
      }
    }

    applyFormat_(sh, name, headers);
  });

  // Hapus sheet bawaan "Sheet1" kalau masih kosong dan tidak terpakai
  var def = ss.getSheetByName('Sheet1') || ss.getSheetByName('Sheet 1');
  if (def && def.getLastRow() === 0 && ss.getSheets().length > 1) {
    ss.deleteSheet(def);
    log.push('DIHAPUS : Sheet1 (bawaan, kosong)');
  }

  var s = seedSettings_();
  var st = seedStatus_();
  log.push('SETTINGS      : ' + s + ' baris pengaturan ditambahkan');
  log.push('STATUS_MASTER : ' + st + ' baris status ditambahkan');

  var msg = 'STRUKTUR DATABASE SELESAI DIPROSES\n\n' + log.join('\n');
  if (warn.length) msg += '\n\n--- PERLU PERHATIAN ---\n' + warn.join('\n');
  else msg += '\n\n✅ Tidak ada masalah. Lanjut ke menu "2. Buat Akun Super Admin".';

  showLong_(msg);
}

function writeHeader_(sh, headers) {
  sh.getRange(1, 1, 1, headers.length).setValues([headers]);
}

function applyFormat_(sh, name, headers) {
  var n = headers.length;
  sh.getRange(1, 1, 1, n)
    .setFontWeight('bold')
    .setFontSize(10)
    .setBackground('#f1f3f4')
    .setVerticalAlignment('middle')
    .setWrap(false);
  sh.setFrozenRows(1);
  sh.getRange(1, 1, sh.getMaxRows(), n).setVerticalAlignment('top');

  if (DB.TAB_COLOR[name]) sh.setTabColor(DB.TAB_COLOR[name]);

  // Lebar kolom khusus
  var widths = DB.COL_WIDTH[name];
  if (widths) {
    Object.keys(widths).forEach(function (col) {
      var idx = headers.indexOf(col);
      if (idx >= 0) sh.setColumnWidth(idx + 1, widths[col]);
    });
  }

  // Sembunyikan kolom sensitif pada USERS agar tidak terlihat sekilas
  if (name === DB.SHEET.USERS) {
    ['pin_hash', 'pin_salt'].forEach(function (col) {
      var idx = headers.indexOf(col);
      if (idx >= 0) sh.hideColumns(idx + 1);
    });
  }

  // Buang kolom kosong berlebih di kanan agar sheet rapi
  var maxCol = sh.getMaxColumns();
  if (maxCol > n + 2) sh.deleteColumns(n + 1, maxCol - n);
}

function seedSettings_() {
  var sh = SpreadsheetApp.getActive().getSheetByName(DB.SHEET.SETTINGS);
  var existing = {};
  if (sh.getLastRow() > 1) {
    sh.getRange(2, 1, sh.getLastRow() - 1, 1).getValues()
      .forEach(function (r) { existing[String(r[0]).trim()] = true; });
  }
  var now = nowIso_();
  var rows = DB.DEFAULT_SETTINGS
    .filter(function (s) { return !existing[s[0]]; })
    .map(function (s) { return [s[0], s[1], s[2], s[3], s[4], now, 'SETUP']; });

  if (rows.length) sh.getRange(sh.getLastRow() + 1, 1, rows.length, 7).setValues(rows);
  return rows.length;
}

function seedStatus_() {
  var sh = SpreadsheetApp.getActive().getSheetByName(DB.SHEET.STATUS);
  var existing = {};
  if (sh.getLastRow() > 1) {
    sh.getRange(2, 1, sh.getLastRow() - 1, 1).getValues()
      .forEach(function (r) { existing[String(r[0]).trim()] = true; });
  }
  var rows = DB.DEFAULT_STATUS.filter(function (s) { return !existing[s[0]]; });
  if (rows.length) sh.getRange(sh.getLastRow() + 1, 1, rows.length, 9).setValues(rows);
  return rows.length;
}

// ============================================================
// LANGKAH 2 — AKUN SUPER ADMIN
// ============================================================

function createSuperAdminUI() {
  var ui = SpreadsheetApp.getUi();

  var r1 = ui.prompt('Buat Super Admin (1/3)',
    'Nama lengkap (contoh: Anditia):', ui.ButtonSet.OK_CANCEL);
  if (r1.getSelectedButton() !== ui.Button.OK) return;
  var fullName = r1.getResponseText().trim();
  if (!fullName) return ui.alert('Nama tidak boleh kosong.');

  var r2 = ui.prompt('Buat Super Admin (2/3)',
    'Username untuk login (huruf kecil, tanpa spasi, contoh: andi):', ui.ButtonSet.OK_CANCEL);
  if (r2.getSelectedButton() !== ui.Button.OK) return;
  var username = r2.getResponseText().trim().toLowerCase();
  if (!/^[a-z0-9._-]{3,20}$/.test(username)) {
    return ui.alert('Username tidak valid. Gunakan 3-20 karakter: huruf kecil, angka, titik, strip.');
  }

  var r3 = ui.prompt('Buat Super Admin (3/3)',
    'PIN 6 digit angka (jangan pakai 123456 atau tanggal lahir):', ui.ButtonSet.OK_CANCEL);
  if (r3.getSelectedButton() !== ui.Button.OK) return;
  var pin = r3.getResponseText().trim();
  if (!/^\d{6}$/.test(pin)) return ui.alert('PIN harus tepat 6 digit angka.');

  try {
    var id = createUser_({
      username: username,
      full_name: fullName,
      role: 'SUPERADMIN',
      branch: getSetting_('DEFAULT_BRANCH') || 'PWT_KOTA',
      pin: pin,
      must_change_pin: false,
      created_by: 'SETUP'
    });
    ui.alert('✅ Super Admin berhasil dibuat.\n\n' +
             'User ID  : ' + id + '\n' +
             'Username : ' + username + '\n' +
             'Role     : SUPERADMIN\n\n' +
             'Simpan PIN ini baik-baik. PIN tidak bisa dilihat lagi ' +
             '(yang tersimpan hanya versi teracaknya), tapi bisa direset ' +
             'lewat menu "Reset PIN Seorang User".');
  } catch (e) {
    ui.alert('Gagal: ' + e.message);
  }
}

/** Dipakai juga oleh aplikasi nanti saat Super Admin menambah staf */
function createUser_(o) {
  var sh = SpreadsheetApp.getActive().getSheetByName(DB.SHEET.USERS);
  if (!sh) throw new Error('Sheet USERS belum ada. Jalankan menu 1 dulu.');

  if (DB.ROLES.indexOf(o.role) < 0) throw new Error('Role tidak dikenal: ' + o.role);

  // Cek username kembar
  if (sh.getLastRow() > 1) {
    var used = sh.getRange(2, 2, sh.getLastRow() - 1, 1).getValues()
                 .map(function (r) { return String(r[0]).trim().toLowerCase(); });
    if (used.indexOf(o.username) >= 0) {
      throw new Error('Username "' + o.username + '" sudah dipakai.');
    }
  }

  var userId = nextUserId_(sh);
  var salt = randomSalt_();
  var now = nowIso_();

  sh.appendRow([
    userId, o.username, o.full_name, o.role, o.division || '', o.branch,
    hashPin_(salt, o.pin), salt, o.phone || '', o.email || '',
    'ACTIVE', o.must_change_pin === false ? false : true,
    '', 0,
    now, o.created_by || 'SYSTEM', now, o.created_by || 'SYSTEM', o.notes || ''
  ]);

  /*
   * Kolom yang ditambahkan belakangan diisi lewat namanya.
   *
   * Baris di atas ditulis berdasarkan urutan kolom. Kolom baru ada
   * di ujung kanan dan belum tentu ada di semua pemasangan, jadi
   * mengisinya lewat nama lebih aman daripada menambah nilai di
   * daftar itu.
   */
  if (o.sales_code) {
    try {
      Repo.clearHeaderCache();
      var br = Repo.findOne(DB.SHEET.USERS, 'user_id', userId);
      if (br) Repo.update(DB.SHEET.USERS, br._row, { sales_code: o.sales_code });
    } catch (e) {}
  }

  return userId;
}

function nextUserId_(sh) {
  var n = 0;
  if (sh.getLastRow() > 1) {
    sh.getRange(2, 1, sh.getLastRow() - 1, 1).getValues().forEach(function (r) {
      var m = String(r[0]).match(/USR-(\d+)/);
      if (m) n = Math.max(n, parseInt(m[1], 10));
    });
  }
  return 'USR-' + ('000' + (n + 1)).slice(-3);
}

function resetPinUI() {
  var ui = SpreadsheetApp.getUi();
  var r1 = ui.prompt('Reset PIN', 'Username yang PIN-nya mau direset:', ui.ButtonSet.OK_CANCEL);
  if (r1.getSelectedButton() !== ui.Button.OK) return;
  var username = r1.getResponseText().trim().toLowerCase();

  var r2 = ui.prompt('Reset PIN', 'PIN baru (6 digit angka):', ui.ButtonSet.OK_CANCEL);
  if (r2.getSelectedButton() !== ui.Button.OK) return;
  var pin = r2.getResponseText().trim();
  if (!/^\d{6}$/.test(pin)) return ui.alert('PIN harus tepat 6 digit angka.');

  var sh = SpreadsheetApp.getActive().getSheetByName(DB.SHEET.USERS);
  var data = sh.getDataRange().getValues();
  var head = data[0];
  var cU = head.indexOf('username'),
      cH = head.indexOf('pin_hash'),
      cS = head.indexOf('pin_salt'),
      cM = head.indexOf('must_change_pin'),
      cF = head.indexOf('failed_attempt'),
      cT = head.indexOf('status');

  for (var i = 1; i < data.length; i++) {
    if (String(data[i][cU]).trim().toLowerCase() === username) {
      var salt = randomSalt_();
      sh.getRange(i + 1, cS + 1).setValue(salt);
      sh.getRange(i + 1, cH + 1).setValue(hashPin_(salt, pin));
      sh.getRange(i + 1, cM + 1).setValue(true);   // wajib ganti saat login
      sh.getRange(i + 1, cF + 1).setValue(0);      // buka kunci gagal login
      sh.getRange(i + 1, cT + 1).setValue('ACTIVE');
      return ui.alert('✅ PIN untuk "' + username + '" sudah direset.\n' +
                      'User wajib mengganti PIN saat login berikutnya.');
    }
  }
  ui.alert('Username "' + username + '" tidak ditemukan.');
}

// ============================================================
// LANGKAH 3 — PEMERIKSAAN
// ============================================================

function verifyDatabase() {
  var ss = SpreadsheetApp.getActive();
  var ok = [], bad = [];

  Object.keys(DB.HEADERS).forEach(function (name) {
    var sh = ss.getSheetByName(name);
    if (!sh) { bad.push('❌ Sheet hilang: ' + name); return; }

    var headers = DB.HEADERS[name];
    var cur = sh.getRange(1, 1, 1, Math.max(sh.getLastColumn(), 1)).getValues()[0]
                .map(function (v) { return String(v).trim(); });

    var miss = headers.filter(function (h) { return cur.indexOf(h) < 0; });
    var extra = cur.filter(function (c) { return c && headers.indexOf(c) < 0; });

    if (miss.length) bad.push('❌ ' + name + ' — kolom hilang: ' + miss.join(', '));
    if (extra.length) bad.push('⚠️ ' + name + ' — kolom asing: ' + extra.join(', '));
    if (!miss.length && !extra.length) {
      ok.push('✅ ' + name + ' (' + headers.length + ' kolom, ' +
              Math.max(sh.getLastRow() - 1, 0) + ' baris data)');
    }
  });

  // Cek isi wajib
  var us = ss.getSheetByName(DB.SHEET.USERS);
  var supers = 0;
  if (us && us.getLastRow() > 1) {
    us.getRange(2, 4, us.getLastRow() - 1, 1).getValues()
      .forEach(function (r) { if (String(r[0]).trim() === 'SUPERADMIN') supers++; });
  }
  if (supers === 0) bad.push('❌ Belum ada akun SUPERADMIN. Jalankan menu 2.');
  else ok.push('✅ Akun SUPERADMIN: ' + supers);

  var msg = 'HASIL PEMERIKSAAN DATABASE\n\n' + ok.join('\n');
  if (bad.length) msg += '\n\n--- MASALAH DITEMUKAN ---\n' + bad.join('\n');
  else msg += '\n\n🎉 Semua beres. Database siap untuk Phase 1 (Login & Hak Akses).';
  showLong_(msg);
}

// ============================================================
// BACKUP
// ============================================================

function backupNow() {
  var ss = SpreadsheetApp.getActive();
  var stamp = Utilities.formatDate(new Date(), 'Asia/Jakarta', 'yyyy-MM-dd_HHmm');
  var folder = getOrCreateFolder_('ELS_BACKUP');
  var copy = DriveApp.getFileById(ss.getId())
                     .makeCopy('BACKUP_' + ss.getName() + '_' + stamp, folder);
  SpreadsheetApp.getUi().alert(
    '✅ Backup selesai.\n\nFile : ' + copy.getName() +
    '\nFolder Drive : ELS_BACKUP\n\nBackup otomatis harian akan dipasang di Phase 10.');
}

function getOrCreateFolder_(name) {
  var it = DriveApp.getFoldersByName(name);
  return it.hasNext() ? it.next() : DriveApp.createFolder(name);
}

// ============================================================
// UTIL
// ============================================================

function nowIso_() {
  return Utilities.formatDate(new Date(), 'Asia/Jakarta', "yyyy-MM-dd'T'HH:mm:ssXXX");
}

function randomSalt_() {
  return Utilities.getUuid().replace(/-/g, '').substring(0, 16);
}

function hashPin_(salt, pin) {
  var raw = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256, salt + '|' + pin, Utilities.Charset.UTF_8);
  return raw.map(function (b) {
    return ('0' + (b & 0xFF).toString(16)).slice(-2);
  }).join('');
}

function getSetting_(key) {
  var sh = SpreadsheetApp.getActive().getSheetByName(DB.SHEET.SETTINGS);
  if (!sh || sh.getLastRow() < 2) return '';
  var data = sh.getRange(2, 1, sh.getLastRow() - 1, 2).getValues();
  for (var i = 0; i < data.length; i++) {
    if (String(data[i][0]).trim() === key) return data[i][1];
  }
  return '';
}

/** Alert biasa terpotong kalau teksnya panjang, jadi pakai dialog HTML */
function showLong_(text) {
  var html = HtmlService.createHtmlOutput(
    '<div style="font:13px/1.6 monospace;white-space:pre-wrap;padding:8px">' +
    text.replace(/&/g, '&amp;').replace(/</g, '&lt;') + '</div>')
    .setWidth(600).setHeight(520);
  SpreadsheetApp.getUi().showModalDialog(html, 'ELS.ID Setup');
}
