/**
 * ELS.ID WORKFLOW SYSTEM — Phase 2.3
 * File : 07_SalesService.gs
 * Isi  : Daftar kode sales beserta jalur penjualannya.
 *
 * Bentuk kode:
 *     SPW - O - MANTO
 *      |    |    └ nama sales
 *      |    └ jalur penjualan: O=Online, R=Ritel, P=Promotor
 *      └ tim atau cabang (SPW = Sales Purwokerto)
 *
 * Arti hurufnya dibaca dari pengaturan SALES_TYPE_MAP di sheet SETTINGS,
 * bukan ditanam di kode. Jadi kalau ELS.ID menambah jalur baru — misalnya
 * K=Korporat — cukup ditambahkan di spreadsheet.
 *
 * Kenapa terpisah dari USERS:
 * Akun login dibuat per divisi dan dipakai bergantian. Kalau nama sales
 * diambil dari akun, semua transaksi tercatat atas nama yang sama dan
 * penjualan per orang tidak bisa dihitung.
 */

var SALES_IDX_KEY = 'ELS_SALESIDX_V2';

// ============================================================
// JALUR PENJUALAN
// ============================================================

/** {O:'Online', R:'Ritel', P:'Promotor'} dibaca dari SETTINGS */
function salesTypeMap_() {
  var map = {};
  Settings.list('SALES_TYPE_MAP').forEach(function (pair) {
    var p = String(pair).split('=');
    if (p.length === 2) {
      var kunci = String(p[0]).trim().toUpperCase();
      if (kunci) map[kunci] = String(p[1]).trim();
    }
  });
  return map;
}

/** SPW-O-MANTO → 'O' */
function parseSalesType_(code) {
  var bagian = String(code || '').toUpperCase().split('-');
  if (bagian.length < 3) return '';
  return String(bagian[1]).trim();
}

function salesTypeLabel_(type) {
  if (!type) return 'Lainnya';
  return salesTypeMap_()[String(type).toUpperCase()] || String(type);
}

// ============================================================
// DAFTAR SALES
// ============================================================

function getSalesList_() {
  /*
   * Daftar sales yang ditambah langsung di sheet harus langsung
   * terpakai.
   *
   * Daftarnya disimpan sebagai salinan supaya tidak dibaca ulang
   * tiap kali layar pesanan dibuka. Tapi menambah baris langsung di
   * sheet tidak memberi tahu aplikasi, jadi nama baru tidak muncul
   * sampai belasan menit kemudian — dan yang menambahkan mengira
   * ketikannya salah lalu mengulanginya.
   *
   * Jumlah barisnya diperiksa dulu. Itu satu perjalanan yang sangat
   * ringan, dan cukup untuk tahu ada tambahan atau tidak.
   */
  var barisKini = 0;
  try { barisKini = Repo.sheet(DB.SHEET.SALES).getLastRow(); } catch (e) {}

  var hit = CacheService.getScriptCache().get(SALES_IDX_KEY);
  if (hit) {
    try {
      var simpan = JSON.parse(hit);
      if (simpan && simpan.baris === barisKini && simpan.isi) return simpan.isi;
    } catch (e) {}
  }

  var rows = Repo.columns(DB.SHEET.SALES,
    ['sales_code', 'sales_name', 'sales_type', 'branch', 'is_active']);
  var map = salesTypeMap_();

  var out = [];
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    var code = String(r.sales_code).trim();
    if (!code) continue;

    var type = String(r.sales_type || '').trim().toUpperCase() || parseSalesType_(code);
    out.push({
      code: code,
      name: String(r.sales_name).trim(),
      type: type,
      typeLabel: map[type] || (type ? type : 'Lainnya'),
      branch: String(r.branch || ''),
      active: Util.isTrue(r.is_active)
    });
  }

  CacheService.getScriptCache().put(SALES_IDX_KEY,
    JSON.stringify({ baris: barisKini, isi: out }), 900);
  return out;
}

function bustSalesCache_() { CacheService.getScriptCache().remove(SALES_IDX_KEY); }

function findSales_(code) {
  var c = String(code || '').trim();
  if (!c) return null;
  var list = getSalesList_();
  for (var i = 0; i < list.length; i++) if (list[i].code === c) return list[i];
  return null;
}

// ============================================================
// API
// ============================================================

function apiListSales(payload) {
  return withGuard_(payload, {}, function (session) {
    var semua = Util.isTrue(payload.includeInactive) && hasPerm_(session, 'USER_MANAGE');
    var map = salesTypeMap_();

    /*
     * Akun milik satu orang sales hanya melihat dirinya sendiri.
     *
     * Daftar berisi nama orang lain di layar yang dipakai tiap hari
     * cuma menambah kemungkinan salah pilih — dan salah pilih di
     * situ berarti komisinya masuk ke orang lain.
     */
    var milik = String(session.sales_code || '').trim();

    var list = getSalesList_()
      .filter(function (s) { return semua || s.active; })
      .filter(function (s) {
        if (milik && !hasPerm_(session, 'USER_MANAGE')) return s.code === milik;
        if (!s.branch) return true;
        if (hasPerm_(session, 'USER_MANAGE')) return true;
        return String(s.branch) === String(session.branch);
      })
      .map(function (s) {
        return {
          sales_code: s.code, sales_name: s.name,
          sales_type: s.type, type_label: s.typeLabel,
          branch: s.branch, is_active: s.active
        };
      });

    // Urutkan per jalur, lalu per nama — supaya pilihannya rapi
    list.sort(function (a, b) {
      if (a.type_label !== b.type_label) return a.type_label < b.type_label ? -1 : 1;
      return a.sales_name < b.sales_name ? -1 : 1;
    });

    return {
      list: list, typeMap: map,

      // Layar memakai ini untuk mengunci pilihannya
      milik_sendiri: String(session.sales_code || '')
    };
  });
}

function apiSaveSales(payload) {
  return withGuard_(payload, { permission: 'USER_MANAGE', lock: true }, function (session) {
    var d = payload.data || {};
    var code = String(d.sales_code || '').trim().toUpperCase();
    var name = String(d.sales_name || '').trim();

    if (!/^[A-Z0-9\-_.]{3,30}$/.test(code)) {
      throw appErr_('BAD_CODE', 'Kode sales 3-30 karakter, huruf besar, angka, atau strip. Contoh: SPW-O-MANTO.');
    }
    if (name.length < 2) throw appErr_('BAD_NAME', 'Nama sales wajib diisi.');
    if (DB.BRANCHES.indexOf(d.branch) < 0) throw appErr_('BAD_BRANCH', 'Cabang tidak dikenal.');

    var type = String(d.sales_type || '').trim().toUpperCase() || parseSalesType_(code);
    var now = nowIso_();
    var ada = Repo.findOne(DB.SHEET.SALES, 'sales_code', code);

    if (ada) {
      var patch = {}, changes = [];
      [['sales_name', name], ['sales_type', type], ['branch', d.branch],
       ['phone', d.phone || ''], ['notes', d.notes || '']]
        .forEach(function (p) {
          if (String(p[1]) !== String(ada[p[0]] || '')) { patch[p[0]] = p[1]; changes.push(p[0]); }
        });
      if (d.is_active !== undefined && Util.isTrue(d.is_active) !== Util.isTrue(ada.is_active)) {
        patch.is_active = Util.isTrue(d.is_active);
        changes.push('is_active');
      }
      if (!changes.length) return { changed: 0, sales_code: code };

      patch.updated_at = now;
      patch.updated_by = session.user_id;
      Repo.update(DB.SHEET.SALES, ada._row, patch);
      bustSalesCache_();

      changes.forEach(function (f) {
        logAudit_(session, {
          entity: 'SALES', entity_id: code, action: 'UPDATE',
          field: f, old_value: ada[f], new_value: patch[f]
        });
      });
      return { changed: changes.length, sales_code: code, type_label: salesTypeLabel_(type) };
    }

    Repo.append(DB.SHEET.SALES, {
      sales_code: code, sales_name: name, sales_type: type, branch: d.branch,
      phone: d.phone || '', is_active: true,
      created_at: now, created_by: session.user_id,
      updated_at: now, updated_by: session.user_id,
      notes: d.notes || ''
    });
    bustSalesCache_();

    logAudit_(session, {
      entity: 'SALES', entity_id: code, action: 'CREATE',
      new_value: code + ' / ' + name + ' / ' + salesTypeLabel_(type)
    });
    return { changed: 1, sales_code: code, created: true, type_label: salesTypeLabel_(type) };
  });
}

// ============================================================
// MIGRASI — jalankan sekali dari editor Apps Script
// ============================================================

/**
 * Menyiapkan sheet SALES_LIST, mengisi kode sales awal, dan menambahkan
 * kolom sales_code serta sales_type di TRANSACTIONS.
 *
 * Aman dijalankan berkali-kali. Kolom baru ditaruh di paling kanan
 * supaya kolom lama tidak bergeser dan transaksi lama tetap terbaca.
 */
function siapkanDaftarSales() {
  var ss = SpreadsheetApp.getActive();
  var pesan = [];
  var now = nowIso_();

  // --- 1. Pengaturan baru harus ada lebih dulu, karena dipakai membaca jalur
  var setSh = Repo.sheet(DB.SHEET.SETTINGS);
  var adaKey = {};
  Repo.columns(DB.SHEET.SETTINGS, ['key']).forEach(function (r) { adaKey[String(r.key).trim()] = true; });

  var tambahan = [
    ['SALES_CODE_REQUIRED', 'TRUE', 'TEXT', 'SALES',
     'Wajib memilih kode sales sebelum pesanan dikonfirmasi.'],
    ['SALES_TYPE_MAP', 'O=Online,R=Ritel,P=Promotor', 'TEXT', 'SALES',
     'Arti huruf tengah pada kode sales. Tambahkan jalur baru di sini, pisahkan dengan koma.'],
    ['TRX_NO_ON_CONFIRM', 'FALSE', 'TEXT', 'TRX',
     'TRUE = nomor transaksi terbit saat konfirmasi.']
  ].filter(function (s) { return !adaKey[s[0]]; });

  if (tambahan.length) {
    setSh.getRange(setSh.getLastRow() + 1, 1, tambahan.length, 7).setValues(
      tambahan.map(function (s) { return [s[0], s[1], s[2], s[3], s[4], now, 'SETUP']; }));
    pesan.push(tambahan.length + ' pengaturan ditambahkan.');
  }
  Settings.bust();

  // --- 2. Sheet SALES_LIST
  var sh = ss.getSheetByName(DB.SHEET.SALES);
  if (!sh) {
    sh = ss.insertSheet(DB.SHEET.SALES);
    sh.getRange(1, 1, 1, DB.HEADERS[DB.SHEET.SALES].length)
      .setValues([DB.HEADERS[DB.SHEET.SALES]])
      .setFontWeight('bold').setBackground('#f1f3f4');
    sh.setFrozenRows(1);
    if (DB.TAB_COLOR[DB.SHEET.SALES]) sh.setTabColor(DB.TAB_COLOR[DB.SHEET.SALES]);
    sh.setColumnWidth(1, 170);
    sh.setColumnWidth(2, 200);
    sh.setColumnWidth(3, 110);
    pesan.push('Sheet SALES_LIST dibuat.');
  } else {
    // Sheet sudah ada dari versi sebelumnya — tambahkan kolom sales_type
    var sHead = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0]
                  .map(function (v) { return String(v).trim(); });
    if (sHead.indexOf('sales_type') < 0) {
      var kol = sh.getLastColumn() + 1;
      if (sh.getMaxColumns() < kol) sh.insertColumnsAfter(sh.getMaxColumns(), 1);
      sh.getRange(1, kol).setValue('sales_type').setFontWeight('bold').setBackground('#f1f3f4');
      sh.setColumnWidth(kol, 110);
      pesan.push('Kolom sales_type ditambahkan di SALES_LIST.');
    }
    pesan.push('Sheet SALES_LIST sudah ada.');
  }

  Repo.clearHeaderCache();

  // --- 3. Isi kode sales awal
  var ada = {};
  Repo.columns(DB.SHEET.SALES, ['sales_code']).forEach(function (r) {
    ada[String(r.sales_code).trim().toUpperCase()] = true;
  });

  var baru = DB.DEFAULT_SALES
    .filter(function (s) { return !ada[s[0]]; })
    .map(function (s) {
      return {
        sales_code: s[0], sales_name: s[1], sales_type: parseSalesType_(s[0]),
        branch: s[2], phone: '', is_active: true,
        created_at: now, created_by: 'SETUP',
        updated_at: now, updated_by: 'SETUP', notes: ''
      };
    });

  if (baru.length) Repo.appendMany(DB.SHEET.SALES, baru);
  pesan.push(baru.length + ' kode sales ditambahkan.');

  // --- 4. Isi sales_type untuk baris lama yang masih kosong
  var isiType = 0;
  Repo.columns(DB.SHEET.SALES, ['sales_code', 'sales_type']).forEach(function (r) {
    if (String(r.sales_type || '').trim()) return;
    var t = parseSalesType_(r.sales_code);
    if (!t) return;
    Repo.update(DB.SHEET.SALES, r._row, { sales_type: t });
    isiType++;
  });
  if (isiType) pesan.push(isiType + ' baris lama diisi jalur penjualannya.');

  // --- 5. Kolom sales_code & sales_type di TRANSACTIONS
  var trx = ss.getSheetByName(DB.SHEET.TRX);
  var head = trx.getRange(1, 1, 1, trx.getLastColumn()).getValues()[0]
                .map(function (v) { return String(v).trim(); });

  ['sales_code', 'sales_type'].forEach(function (kolom) {
    if (head.indexOf(kolom) >= 0) return;
    var kb = trx.getLastColumn() + 1;
    if (trx.getMaxColumns() < kb) trx.insertColumnsAfter(trx.getMaxColumns(), 1);
    trx.getRange(1, kb).setValue(kolom).setFontWeight('bold').setBackground('#f1f3f4');
    trx.setColumnWidth(kb, kolom === 'sales_code' ? 150 : 110);
    head.push(kolom);
    pesan.push('Kolom ' + kolom + ' ditambahkan di TRANSACTIONS.');
  });

  // --- 6. Kolom yang sama di arsip
  var arc = ss.getSheetByName(DB.SHEET.TRX_ARCHIVE);
  if (arc && arc.getLastColumn() > 0) {
    var ah = arc.getRange(1, 1, 1, arc.getLastColumn()).getValues()[0]
                .map(function (v) { return String(v).trim(); });
    ['sales_code', 'sales_type'].forEach(function (kolom) {
      if (ah.indexOf(kolom) >= 0) return;
      var kb2 = arc.getLastColumn() + 1;
      if (arc.getMaxColumns() < kb2) arc.insertColumnsAfter(arc.getMaxColumns(), 1);
      arc.getRange(1, kb2).setValue(kolom).setFontWeight('bold').setBackground('#f1f3f4');
      ah.push(kolom);
    });
  }

  Repo.clearHeaderCache();
  bustSalesCache_();
  Settings.bust();

  var map = salesTypeMap_();
  var daftarJalur = Object.keys(map).map(function (k) { return k + ' = ' + map[k]; }).join(', ');
  pesan.push('Jalur penjualan yang dikenali: ' + (daftarJalur || '(belum ada)'));

  return kabar_(pesan.join('\n'));
}

// ============================================================
// HAPUS SALES
// ============================================================

/**
 * Menghapus kode sales.
 *
 * Kode yang pernah dipakai bertransaksi TIDAK dihapus, hanya
 * dinonaktifkan. Setiap transaksi menyimpan kode salesnya, dan
 * laporan penjualan per sales dihitung dari situ. Kalau kodenya
 * hilang, penjualan orang itu ikut hilang dari laporan bulan-bulan
 * sebelumnya — dan itu jenis kesalahan yang baru ketahuan saat
 * perhitungan komisi.
 *
 * Kode yang belum pernah dipakai boleh dihapus betulan.
 */
function apiDeleteSales(payload) {
  return withGuard_(payload, { permission: 'USER_MANAGE', lock: true }, function (session) {
    var code = String(payload.sales_code || '').trim().toUpperCase();
    var s = Repo.findOne(DB.SHEET.SALES, 'sales_code', code);
    if (!s) throw appErr_('NOT_FOUND', 'Kode sales tidak ditemukan.');

    var jumlahTrx = 0;
    try {
      Repo.columns(DB.SHEET.TRX, ['trx_id', 'sales_code']).forEach(function (t) {
        if (String(t.sales_code).trim().toUpperCase() === code) jumlahTrx++;
      });
    } catch (e) { jumlahTrx = 1; }   // kalau ragu, pilih yang lebih aman

    bustSalesCache_();

    /*
     * Hapus permanen, kalau memang diminta.
     *
     * Bawaannya tetap menonaktifkan: nama sales menempel pada
     * transaksi lama, dan menghapusnya membuat laporan bulan-bulan
     * sebelumnya kehilangan pemiliknya.
     *
     * Tapi ada kalanya kode memang salah dibuat — salah ketik, atau
     * dua kali untuk orang yang sama. Untuk itu Super Admin bisa
     * memaksa, dengan tahu persis berapa transaksi yang terdampak.
     */
    if (jumlahTrx > 0 && Util.isTrue(payload.paksa)) {
      Repo.deleteRow(DB.SHEET.SALES, s._row);
      logAudit_(session, {
        entity: 'USER', entity_id: code, action: 'DELETE',
        old_value: code + ' · ' + s.sales_name + ' · ' + jumlahTrx + ' transaksi',
        new_value: '(dihapus permanen)',
        reason: payload.reason || 'Dihapus paksa oleh Super Admin'
      });
      flushLog_();

      return {
        mode: 'HAPUS_PAKSA', jumlahTrx: jumlahTrx,
        pesan: code + ' dihapus permanen. ' + jumlahTrx + ' transaksi lamanya ' +
               'tetap menyimpan nama ini di datanya sendiri.'
      };
    }

    if (jumlahTrx > 0) {
      Repo.update(DB.SHEET.SALES, s._row, {
        is_active: false, updated_at: nowIso_(), updated_by: session.full_name
      });
      logAudit_(session, {
        entity: 'USER', entity_id: code, action: 'UPDATE', field: 'is_active',
        old_value: 'aktif', new_value: 'nonaktif',
        reason: payload.reason || 'Dihapus dari daftar sales'
      });
      return {
        mode: 'NONAKTIF', jumlahTrx: jumlahTrx,
        bisa_paksa: true,
        pesan: code + ' dinonaktifkan. Tidak muncul lagi saat membuat pesanan, ' +
               'tapi ' + jumlahTrx + ' transaksi lamanya tetap terhitung di laporan.'
      };
    }

    Repo.deleteRow(DB.SHEET.SALES, s._row);
    logAudit_(session, {
      entity: 'USER', entity_id: code, action: 'DELETE',
      old_value: code + ' · ' + s.sales_name, new_value: '(dihapus)',
      reason: payload.reason || 'Belum pernah dipakai bertransaksi'
    });

    return {
      mode: 'HAPUS', jumlahTrx: 0,
      pesan: code + ' dihapus. Kode ini belum pernah dipakai bertransaksi.'
    };
  });
}
