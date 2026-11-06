/**
 * ELS.ID WORKFLOW SYSTEM
 * File : 19_GudangStaffService.gs
 * Isi  : Daftar petugas gudang.
 *
 * Akun Gudang dipakai bersama oleh beberapa orang, sama seperti akun
 * Sales. Jadi "siapa yang menyiapkan barang" tidak bisa disimpulkan
 * dari akun yang dipakai login.
 *
 * Polanya sama persis dengan daftar sales: nama orangnya dipilih saat
 * menyiapkan barang, dan tersimpan di transaksi. Dengan begitu kalau
 * suatu hari ada barang yang keliru, ketahuan siapa yang menyiapkan —
 * bukan untuk mencari siapa yang salah, tapi supaya bisa ditanyakan
 * langsung ke orang yang memang memegangnya.
 */

var GUDANG_IDX_KEY = 'ELS_GUDANGIDX_V1';

function bustGudangCache_() {
  CacheService.getScriptCache().remove(GUDANG_IDX_KEY);
}

function daftarGudangIndex_() {
  var barisKini = 0;
  try { barisKini = Repo.sheet(DB.SHEET.GUDANG).getLastRow(); } catch (e) {}

  var hit = CacheService.getScriptCache().get(GUDANG_IDX_KEY);
  if (hit) {
    try {
      var simpan = JSON.parse(hit);
      if (simpan && simpan.baris === barisKini && simpan.isi) return simpan.isi;
    } catch (e) {}
  }

  var out = [];
  try {
    Repo.columns(DB.SHEET.GUDANG, [
      'gudang_code', 'gudang_name', 'branch', 'is_active'
    ]).forEach(function (r) {
      var kode = String(r.gudang_code || '').trim();
      if (!kode) return;
      out.push({
        k: kode, n: String(r.gudang_name || ''),
        b: String(r.branch || ''), a: Util.isTrue(r.is_active)
      });
    });
  } catch (e) {
    return [];
  }

  // Daftar kosong TIDAK ikut disimpan.
  //
  // Dulu daftar yang masih kosong tersimpan 15 menit. Akibatnya setelah
  // petugas ditambahkan, layar masih menganggap daftarnya kosong dan
  // kotak pilihannya tidak muncul — sementara server sudah melihat isinya
  // dan menolak konfirmasi karena nama petugasnya dianggap belum dipilih.
  // Dua sisi yang tidak sinkron, hanya karena salinan kosong disimpan.
  if (out.length) {
    CacheService.getScriptCache().put(GUDANG_IDX_KEY,
      JSON.stringify({ baris: barisKini, isi: out }), 600);
  }
  return out;
}

/**
 * Mencari nama petugas dari kodenya.
 *
 * Dicari di dua daftar sekaligus — petugas gudang dan PIC eksekusi.
 * Keduanya mengisi kolom yang sama di transaksi, dan yang penting
 * namanya tercatat benar, bukan dari daftar mana asalnya.
 */
function cariPetugasGudang_(kode) {
  var k = String(kode || '').trim().toUpperCase();
  if (!k) return null;

  try {
    var eks = daftarEksekusiIndex_();
    for (var e = 0; e < eks.length; e++) {
      if (eks[e].k.toUpperCase() === k) {
        return { code: eks[e].k, name: eks[e].n, branch: eks[e].b, active: eks[e].a };
      }
    }
  } catch (err) {}

  var idx = daftarGudangIndex_();
  for (var i = 0; i < idx.length; i++) {
    if (idx[i].k.toUpperCase() === k) {
      return { code: idx[i].k, name: idx[i].n, branch: idx[i].b, active: idx[i].a };
    }
  }
  return null;
}

// ============================================================
// API
// ============================================================

/**
 * Daftar petugas yang menyiapkan barang.
 *
 * Isinya mengikuti divisi yang bertanya: Gudang mendapat daftar
 * petugas gudang, Tim Eksekusi mendapat daftar PIC-nya sendiri.
 *
 * Tanpa pemisahan ini, Eksekusi memilih nama petugas gudang untuk
 * pekerjaan yang dia kerjakan sendiri — dan laporan siapa menyiapkan
 * apa jadi salah sejak awal.
 */
function apiListPetugasGudang(payload) {
  return withGuard_(payload, {}, function (session) {
    var semua = Util.isTrue(payload.semua);

    if (String(session.role) === 'EKSEKUSI' ||
        String(payload.divisi) === 'EKSEKUSI') {
      return daftarPicEksekusi_(session, semua);
    }

    var idx = daftarGudangIndex_();

    return idx
      .filter(function (p) {
        if (!semua && !p.a) return false;
        if (!semua && p.b && p.b !== String(session.branch) &&
            !hasPerm_(session, 'TRX_VIEW_ALL')) return false;
        return true;
      })
      .map(function (p) {
        return { gudang_code: p.k, gudang_name: p.n, branch: p.b, is_active: p.a };
      })
      .sort(function (a, b) { return a.gudang_name < b.gudang_name ? -1 : 1; });
  });
}

function apiSavePetugasGudang(payload) {
  return withGuard_(payload, { permission: 'USER_MANAGE', lock: true }, function (session) {
    var d = payload.data || {};
    var kode = String(d.gudang_code || '').trim().toUpperCase();
    var nama = String(d.gudang_name || '').trim();

    if (!/^[A-Z0-9\-_.]{3,30}$/.test(kode)) {
      throw appErr_('BAD_CODE',
        'Kode petugas 3-30 karakter, huruf besar, angka, atau strip. Contoh: GDG-PWT-RUDI.');
    }
    if (nama.length < 2) throw appErr_('BAD_NAME', 'Nama petugas wajib diisi.');
    if (DB.BRANCHES.indexOf(d.branch) < 0) throw appErr_('BAD_BRANCH', 'Cabang tidak dikenal.');

    var now = nowIso_();
    var ada = Repo.findOne(DB.SHEET.GUDANG, 'gudang_code', kode);

    if (ada) {
      var patch = {}, ubah = [];
      [['gudang_name', nama], ['branch', d.branch], ['phone', d.phone || ''],
       ['notes', d.notes || '']].forEach(function (p) {
        if (String(p[1]) !== String(ada[p[0]] || '')) { patch[p[0]] = p[1]; ubah.push(p[0]); }
      });
      if (d.is_active !== undefined && Util.isTrue(d.is_active) !== Util.isTrue(ada.is_active)) {
        patch.is_active = Util.isTrue(d.is_active);
        ubah.push('is_active');
      }

      if (ubah.length) {
        patch.updated_at = now;
        patch.updated_by = session.full_name;
        Repo.update(DB.SHEET.GUDANG, ada._row, patch);
        logAudit_(session, {
          entity: 'USER', entity_id: kode, action: 'UPDATE',
          field: ubah.join(','), old_value: String(ada.gudang_name),
          new_value: nama + (patch.is_active === false ? ' (dinonaktifkan)' : '')
        });
      }
      bustGudangCache_();
      return { mode: 'UPDATE', gudang_code: kode };
    }

    Repo.append(DB.SHEET.GUDANG, {
      gudang_code: kode, gudang_name: nama, branch: d.branch,
      phone: d.phone || '', notes: d.notes || '', is_active: true,
      created_at: now, created_by: session.full_name,
      updated_at: now, updated_by: session.full_name
    });

    logAudit_(session, {
      entity: 'USER', entity_id: kode, action: 'CREATE',
      new_value: kode + ' · ' + nama + ' · ' + d.branch
    });

    bustGudangCache_();
    return { mode: 'CREATE', gudang_code: kode };
  });
}

/**
 * Sama seperti sales: kode yang pernah dipakai menyiapkan barang hanya
 * dinonaktifkan, supaya catatan penyiapan lama tetap terbaca namanya.
 */
function apiDeletePetugasGudang(payload) {
  return withGuard_(payload, { permission: 'USER_MANAGE', lock: true }, function (session) {
    var kode = String(payload.gudang_code || '').trim().toUpperCase();
    var p = Repo.findOne(DB.SHEET.GUDANG, 'gudang_code', kode);
    if (!p) throw appErr_('NOT_FOUND', 'Kode petugas tidak ditemukan.');

    var jumlah = 0;
    try {
      Repo.columns(DB.SHEET.TRX, ['trx_id', 'gudang_petugas']).forEach(function (t) {
        if (String(t.gudang_petugas).trim().toUpperCase() === kode) jumlah++;
      });
    } catch (e) { jumlah = 1; }

    bustGudangCache_();

    /*
     * Hapus permanen, kalau memang diminta.
     *
     * Sama alasannya dengan akun dan kode sales: nama yang pernah
     * dipakai menempel pada transaksi lama, jadi bawaannya cuma
     * dinonaktifkan. Yang salah dibuat tetap perlu jalan keluar.
     */
    if (jumlah > 0 && Util.isTrue(payload.paksa)) {
      Repo.deleteRow(DB.SHEET.GUDANG, p._row);
      logAudit_(session, {
        entity: 'USER', entity_id: kode, action: 'DELETE',
        old_value: kode + ' · ' + p.gudang_name + ' · ' + jumlah + ' transaksi',
        new_value: '(dihapus permanen)',
        reason: payload.reason || 'Dihapus paksa oleh Super Admin'
      });
      flushLog_();
      return {
        mode: 'HAPUS_PAKSA', jumlah: jumlah,
        pesan: kode + ' dihapus permanen.'
      };
    }

    if (jumlah > 0) {
      Repo.update(DB.SHEET.GUDANG, p._row, {
        is_active: false, updated_at: nowIso_(), updated_by: session.full_name
      });
      logAudit_(session, {
        entity: 'USER', entity_id: kode, action: 'UPDATE', field: 'is_active',
        old_value: 'aktif', new_value: 'nonaktif', reason: payload.reason || ''
      });
      return {
        mode: 'NONAKTIF',
        pesan: kode + ' dinonaktifkan. Tidak muncul lagi saat menyiapkan barang, tapi ' +
               jumlah + ' catatan penyiapan lamanya tetap terbaca atas namanya.'
      };
    }

    Repo.deleteRow(DB.SHEET.GUDANG, p._row);
    logAudit_(session, {
      entity: 'USER', entity_id: kode, action: 'DELETE',
      old_value: kode + ' · ' + p.gudang_name, new_value: '(dihapus)',
      reason: payload.reason || 'Belum pernah dipakai'
    });

    return { mode: 'HAPUS', pesan: kode + ' dihapus. Belum pernah dipakai menyiapkan barang.' };
  });
}

// ============================================================
// PENYIAPAN — jalankan sekali dari editor
// ============================================================

function siapkanDaftarGudang() {
  var ss = SpreadsheetApp.getActive();
  var pesan = [];

  // 1. Sheet daftar petugas
  var sh = ss.getSheetByName(DB.SHEET.GUDANG);
  if (!sh) {
    sh = ss.insertSheet(DB.SHEET.GUDANG);
    var head = DB.HEADERS[DB.SHEET.GUDANG];
    sh.getRange(1, 1, 1, head.length).setValues([head])
      .setFontWeight('bold').setBackground('#f1f3f4');
    sh.setFrozenRows(1);
    sh.setColumnWidth(1, 170);
    sh.setColumnWidth(2, 200);
    pesan.push('Sheet ' + DB.SHEET.GUDANG + ' dibuat.');
  } else {
    pesan.push('Sheet ' + DB.SHEET.GUDANG + ' sudah ada.');
  }

  // 2. Kolom penyimpan petugas di transaksi, ditaruh paling kanan
  //    supaya kolom yang sudah ada tidak bergeser
  var shT = Repo.sheet(DB.SHEET.TRX);
  var headT = shT.getRange(1, 1, 1, shT.getLastColumn()).getValues()[0]
                 .map(function (v) { return String(v).trim(); });

  ['gudang_petugas', 'gudang_petugas_nama'].forEach(function (kol) {
    if (headT.indexOf(kol) >= 0) {
      pesan.push('Kolom ' + kol + ' sudah ada.');
      return;
    }
    var k = shT.getLastColumn() + 1;
    if (shT.getMaxColumns() < k) shT.insertColumnsAfter(shT.getMaxColumns(), 1);
    shT.getRange(1, k).setValue(kol).setFontWeight('bold').setBackground('#f1f3f4');
    shT.setColumnWidth(k, 160);
    headT.push(kol);
    pesan.push('Kolom ' + kol + ' ditambahkan di TRANSACTIONS.');
  });

  Repo.clearHeaderCache();
  bustGudangCache_();

  return kabar_(pesan.join('\n') + '\n\n' +
    'Tambahkan nama petugas lewat menu Kelola User, di bagian Petugas Gudang.\n\n' +
    'Contoh kode: GDG-PWT-RUDI, GDG-PWT-ANTO.\n\n' +
    'Setelah ada isinya, layar Gudang akan meminta memilih nama sebelum ' +
    'barang bisa dikonfirmasi siap.');
}

/* ============================================================
   PIC TIM EKSEKUSI

   Polanya sama dengan petugas gudang: satu akun divisi dipakai
   bersama, nama orangnya dipilih saat mulai menyiapkan.
   ============================================================ */

var EKS_IDX_KEY = 'ELS_EKSIDX_V1';

function bustEksekusiCache_() {
  CacheService.getScriptCache().remove(EKS_IDX_KEY);
}

function daftarEksekusiIndex_() {
  var barisKini = 0;
  try { barisKini = Repo.sheet(DB.SHEET.EKSEKUSI).getLastRow(); } catch (e) {}

  var hit = CacheService.getScriptCache().get(EKS_IDX_KEY);
  if (hit) {
    try {
      var simpan = JSON.parse(hit);
      if (simpan && simpan.baris === barisKini && simpan.isi) return simpan.isi;
    } catch (e) {}
  }

  var out = [];
  try {
    Repo.columns(DB.SHEET.EKSEKUSI, ['pic_code', 'pic_name', 'branch', 'is_active'])
      .forEach(function (r) {
        var kode = String(r.pic_code || '').trim();
        if (!kode) return;
        out.push({
          k: kode, n: String(r.pic_name || ''),
          b: String(r.branch || ''), a: Util.isTrue(r.is_active)
        });
      });
  } catch (e) {}

  CacheService.getScriptCache().put(EKS_IDX_KEY,
    JSON.stringify({ baris: barisKini, isi: out }), 1800);
  return out;
}

function daftarPicEksekusi_(session, semua) {
  return daftarEksekusiIndex_()
    .filter(function (p) {
      if (!semua && !p.a) return false;
      if (!semua && p.b && p.b !== String(session.branch) &&
          !hasPerm_(session, 'TRX_VIEW_ALL')) return false;
      return true;
    })
    .map(function (p) {
      // Dikirim dengan nama kolom yang sama seperti petugas gudang,
      // supaya layarnya tidak perlu dibuat dua kali
      return { gudang_code: p.k, gudang_name: p.n, branch: p.b, is_active: p.a };
    })
    .sort(function (a, b) { return a.gudang_name < b.gudang_name ? -1 : 1; });
}
