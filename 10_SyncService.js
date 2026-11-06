/**
 * ELS.ID WORKFLOW SYSTEM — Sinkronisasi Master Barang
 * File : 10_SyncService.gs
 *
 * ATURAN MUTLAK
 * File ini HANYA MEMBACA dari spreadsheet pusat. Tidak ada satu pun
 * perintah tulis di sini yang mengarah ke file pusat — yang ada hanya
 * getValues(). Penulisan seluruhnya ke PRODUCTS_LOCAL di spreadsheet
 * operasional milik cabang.
 *
 * DUA JALUR PEMBACAAN
 * - DIRECT : baca langsung dari spreadsheet pusat. Perlu akses view
 *            untuk akun yang menjalankan script ini. Ini yang disarankan.
 * - MIRROR : baca dari file perantara berisi IMPORTRANGE. Dipakai kalau
 *            pusat tidak bisa memberi akses ke akun tersebut.
 *
 * PENGAMAN
 * - Header wajib cocok dengan pemetaan. Kalau berubah, sync ditolak.
 * - Kalau jumlah baris anjlok drastis, sync ditolak dan data lama
 *   dipertahankan. Ini menjaga supaya pusat yang sedang bermasalah
 *   tidak mengosongkan katalog toko.
 * - Setiap sync dicatat di PRODUCT_SYNC_LOG, berhasil maupun gagal.
 */

// ============================================================
// KONFIGURASI
// ============================================================

function konfigSync_() {
  var mode = String(Settings.get('SYNC_MODE', 'DIRECT')).toUpperCase();
  var mirror = mode === 'MIRROR';

  return {
    mode: mode,
    id: String(mirror ? Settings.get('MIRROR_SPREADSHEET_ID', '')
                      : Settings.get('CENTER_SPREADSHEET_ID', '')).trim(),
    sheet: String(mirror ? Settings.get('MIRROR_SHEET_NAME', '')
                         : Settings.get('CENTER_SHEET_NAME', '')).trim(),
    barisHeader: Settings.num('CENTER_HEADER_ROW', 1),
    kolom: {
      kode:     String(Settings.get('MAP_KODE', 'Kode Barang')).trim(),
      nama:     String(Settings.get('MAP_NAMA', 'Nama Barang')).trim(),
      harga:    String(Settings.get('MAP_HARGA', 'Harga')).trim(),
      stok:     String(Settings.get('MAP_STOK', 'PWT')).trim(),
      stokLain: String(Settings.get('MAP_STOK_LAIN', '')).trim(),
      kategori: String(Settings.get('MAP_KATEGORI', '')).trim(),
      unit:     String(Settings.get('MAP_UNIT', '')).trim(),
      needSn:   String(Settings.get('MAP_NEED_SN', '')).trim()
    },
    batasTurunPct: Settings.num('SYNC_MIN_ROWS_PCT', 50),
    batasRusakPct: Settings.num('SYNC_MAX_SKIP_PCT', 30)
  };
}

/** Membuka sumber data. Hanya membaca — tidak ada perintah tulis. */
function bukaSumber_(cfg) {
  if (!cfg.id) {
    throw new Error('ID spreadsheet sumber belum diisi. Isi ' +
      (cfg.mode === 'MIRROR' ? 'MIRROR_SPREADSHEET_ID' : 'CENTER_SPREADSHEET_ID') +
      ' di sheet SETTINGS.');
  }

  var ss;
  try {
    ss = SpreadsheetApp.openById(cfg.id);
  } catch (e) {
    throw new Error('Spreadsheet sumber tidak bisa dibuka. Pastikan ID-nya benar dan akun ini ' +
      'punya akses view ke file tersebut. Pesan asli: ' + e.message);
  }

  var sh = cfg.sheet ? ss.getSheetByName(cfg.sheet) : ss.getSheets()[0];
  if (!sh) {
    var daftar = ss.getSheets().map(function (x) { return x.getName(); }).join(', ');
    throw new Error('Sheet "' + cfg.sheet + '" tidak ada di file sumber. ' +
      'Sheet yang tersedia: ' + daftar);
  }
  return { ss: ss, sh: sh };
}

// ============================================================
// PEMERIKSAAN SUMBER — jalankan dari editor untuk menyiapkan pemetaan
// ============================================================

/**
 * Membaca sumber lalu menampilkan nama sheet, header yang terbaca,
 * dan beberapa baris contoh. Dipakai sekali di awal untuk mengetahui
 * nama kolom di spreadsheet pusat.
 */
function cekSumberPusat() {
  var cfg = konfigSync_();
  var laporan = ['MODE: ' + cfg.mode, 'ID : ' + (cfg.id || '(belum diisi)'), ''];

  try {
    var s = bukaSumber_(cfg);
    laporan.push('File   : ' + s.ss.getName());
    laporan.push('Sheet  : ' + s.sh.getName());
    laporan.push('Semua sheet: ' + s.ss.getSheets().map(function (x) { return x.getName(); }).join(', '));
    laporan.push('Ukuran : ' + s.sh.getLastRow() + ' baris x ' + s.sh.getLastColumn() + ' kolom');
    laporan.push('');

    var br = Math.max(cfg.barisHeader, 1);
    var header = s.sh.getRange(br, 1, 1, s.sh.getLastColumn()).getValues()[0]
                   .map(function (v) { return String(v).trim(); });

    laporan.push('HEADER pada baris ke-' + br + ':');
    header.forEach(function (h, i) {
      if (h) laporan.push('  kolom ' + (i + 1) + ' : "' + h + '"');
    });
    laporan.push('');

    var petaTerbaca = [];
    ['kode', 'nama', 'harga', 'stok', 'kategori', 'unit', 'needSn'].forEach(function (k) {
      var cari = cfg.kolom[k];
      if (!cari) return;
      var idx = cariKolom_(header, cari);
      petaTerbaca.push('  ' + k + ' → "' + cari + '" ' +
        (idx >= 0 ? '✓ ketemu di kolom ' + (idx + 1) : '✗ TIDAK KETEMU'));
    });

    kolomStokLain_(cfg).forEach(function (c) {
      var idx = cariKolom_(header, c);
      petaTerbaca.push('  stok cabang lain → "' + c + '" ' +
        (idx >= 0 ? '✓ ketemu di kolom ' + (idx + 1) : '✗ TIDAK KETEMU'));
    });

    laporan.push('PEMETAAN SEKARANG:');
    laporan = laporan.concat(petaTerbaca);
    laporan.push('');

    var mulai = br + 1;
    var jml = Math.min(5, s.sh.getLastRow() - br);
    if (jml > 0) {
      var contoh = s.sh.getRange(mulai, 1, jml, s.sh.getLastColumn()).getValues();
      laporan.push('CONTOH ' + jml + ' BARIS PERTAMA:');
      contoh.forEach(function (r, n) {
        laporan.push('  ' + (n + 1) + '. ' + r.slice(0, 8).map(function (v) {
          return String(v).substring(0, 22);
        }).join(' | '));
      });
    }

  } catch (e) {
    laporan.push('GAGAL: ' + e.message);
  }

  return kabar_(laporan.join('\n'));
}

/** 'YK,SLO,SMG' → ['YK','SLO','SMG'] */
function kolomStokLain_(cfg) {
  return String(cfg.kolom.stokLain || '').split(',')
    .map(function (x) { return x.trim(); })
    .filter(function (x) { return x !== ''; });
}

function cariKolom_(header, nama) {
  var target = String(nama).trim().toLowerCase().replace(/\s+/g, '');
  for (var i = 0; i < header.length; i++) {
    if (String(header[i]).trim().toLowerCase().replace(/\s+/g, '') === target) return i;
  }
  return -1;
}

// ============================================================
// SINKRONISASI
// ============================================================

function jalankanSync_(oleh, mode) {
  var syncId = Util.id('SYN');
  var mulai = nowIso_();

  /*
   * Sinkronisasi TIDAK memakai kunci antre global.
   *
   * Dulu memakainya, dan itu menahan seluruh aplikasi selama proses
   * berjalan — bisa puluhan detik kalau barangnya ribuan. Akibatnya
   * staf yang kebetulan menyimpan pada saat itu mendapat pesan
   * "beberapa orang menyimpan bersamaan", padahal tidak ada orang lain.
   *
   * Yang perlu dijaga hanya supaya dua sinkronisasi tidak berjalan
   * bersamaan, dan itu cukup dengan penanda sederhana.
   */
  var cache = CacheService.getScriptCache();
  var PENANDA = 'ELS_SYNC_JALAN';

  if (cache.get(PENANDA)) {
    return { status: 'FAIL', message: 'Sinkronisasi lain sedang berjalan. Coba lagi sebentar.' };
  }
  cache.put(PENANDA, '1', 300);

  var lock = { releaseLock: function () { cache.remove(PENANDA); } };

  var dibaca = 0, ditulis = 0, berubah = 0, dilewati = 0;

  try {
    var cfg = konfigSync_();
    var s = bukaSumber_(cfg);
    var sh = s.sh;

    var lr = sh.getLastRow();
    var lc = sh.getLastColumn();
    var br = Math.max(cfg.barisHeader, 1);
    if (lr <= br) throw new Error('Sheet sumber kosong atau hanya berisi header.');

    var header = sh.getRange(br, 1, 1, lc).getValues()[0]
                   .map(function (v) { return String(v).trim(); });

    var cKode = cariKolom_(header, cfg.kolom.kode);
    var cNama = cariKolom_(header, cfg.kolom.nama);
    var cHarga = cariKolom_(header, cfg.kolom.harga);

    if (cKode < 0 || cNama < 0 || cHarga < 0) {
      var kurang = [];
      if (cKode < 0) kurang.push('kode barang ("' + cfg.kolom.kode + '")');
      if (cNama < 0) kurang.push('nama barang ("' + cfg.kolom.nama + '")');
      if (cHarga < 0) kurang.push('harga ("' + cfg.kolom.harga + '")');
      throw new Error('Kolom wajib tidak ditemukan di sumber: ' + kurang.join(', ') +
        '. Header yang terbaca: ' + header.filter(String).join(' | ') +
        '. Perbaiki pemetaan MAP_* di sheet SETTINGS, atau jalankan cekSumberPusat().');
    }

    var cStok = cfg.kolom.stok ? cariKolom_(header, cfg.kolom.stok) : -1;

    if (cfg.kolom.stok && cStok < 0) {
      throw new Error('Kolom stok cabang ("' + cfg.kolom.stok + '") tidak ketemu di sumber. ' +
        'Header yang terbaca: ' + header.filter(String).join(' | ') +
        '. Perbaiki MAP_STOK di sheet SETTINGS.');
    }

    var stokLain = [];
    kolomStokLain_(cfg).forEach(function (nm) {
      var idx = cariKolom_(header, nm);
      if (idx >= 0) stokLain.push({ nama: nm, idx: idx });
    });
    var cKat = cfg.kolom.kategori ? cariKolom_(header, cfg.kolom.kategori) : -1;
    var cUnit = cfg.kolom.unit ? cariKolom_(header, cfg.kolom.unit) : -1;
    var cSn = cfg.kolom.needSn ? cariKolom_(header, cfg.kolom.needSn) : -1;

    var nilai = sh.getRange(br + 1, 1, lr - br, lc).getValues();
    dibaca = nilai.length;

    // Keadaan sekarang, untuk menghitung apa yang berubah
    var lama = {};
    Repo.columns(DB.SHEET.PRODUCTS, ['product_code', 'product_name', 'price', 'stock'])
      .forEach(function (p) {
        lama[String(p.product_code).trim().toUpperCase()] = {
          n: String(p.product_name), p: Number(p.price) || 0, q: String(p.stock)
        };
      });

    var lamaNonDemo = 0;
    Object.keys(lama).forEach(function (k) { if (k.indexOf('DEMO-') !== 0) lamaNonDemo++; });

    var now = nowIso_();
    var terlihat = {};
    var baris = [];

    for (var i = 0; i < nilai.length; i++) {
      var r = nilai[i];
      var kode = String(r[cKode] === undefined ? '' : r[cKode]).trim();
      var nama = String(r[cNama] === undefined ? '' : r[cNama]).trim();

      if (!kode || !nama) { dilewati++; continue; }
      if (String(kode).indexOf('#') === 0) { dilewati++; continue; }  // #REF!, #N/A dari IMPORTRANGE

      var kodeUp = kode.toUpperCase();
      if (terlihat[kodeUp]) { dilewati++; continue; }                 // kode kembar di sumber
      terlihat[kodeUp] = true;

      var hargaMentah = r[cHarga];
      var harga = Number(String(hargaMentah).replace(/[^0-9.-]/g, ''));
      if (isNaN(harga)) harga = 0;

      var stok = cStok >= 0 ? String(r[cStok] === undefined ? '' : r[cStok]).trim() : '';
      if (stok !== '') {
        var angkaStok = Number(String(stok).replace(/[^0-9.-]/g, ''));
        stok = isNaN(angkaStok) ? '' : angkaStok;
      }

      var perluSn = cSn >= 0 ? Util.isTrue(r[cSn]) : needsSn_(kode);

      // Stok cabang lain, sekadar informasi supaya Sales bisa menawarkan
      // pesan dari cabang yang masih punya barangnya
      var lainTeks = '';
      if (stokLain.length) {
        var potong = [];
        stokLain.forEach(function (c) {
          var v = String(r[c.idx] === undefined ? '' : r[c.idx]).trim();
          if (v === '') return;
          var n2 = Number(String(v).replace(/[^0-9.-]/g, ''));
          if (isNaN(n2) || n2 <= 0) return;
          potong.push(c.nama + ': ' + n2);
        });
        lainTeks = potong.join(' · ');
      }

      baris.push([
        kode, nama,
        cKat >= 0 ? String(r[cKat] || '').trim() : '',
        cUnit >= 0 ? String(r[cUnit] || '').trim() : '',
        harga, stok, perluSn, true,
        (kode + nama).toLowerCase().replace(/\s+/g, ''),
        now, lainTeks
      ]);

      var sebelum = lama[kodeUp];
      if (!sebelum || sebelum.n !== nama || sebelum.p !== harga || String(sebelum.q) !== String(stok)) {
        berubah++;
      }
    }

    if (!baris.length) {
      throw new Error('Tidak ada baris yang bisa dipakai dari sumber. ' +
        'Cek apakah baris header sudah benar (CENTER_HEADER_ROW = ' + br + ').');
    }

    // Kalau katalog anjlok drastis, kemungkinan besar sumbernya sedang
    // bermasalah — bukan barangnya yang benar-benar dihapus.
    if (lamaNonDemo > 0) {
      var pctTersisa = Math.round((baris.length / lamaNonDemo) * 100);
      if (pctTersisa < cfg.batasTurunPct) {
        throw new Error('Sync ditolak demi keamanan. Sumber hanya berisi ' + baris.length +
          ' barang, padahal sebelumnya ada ' + lamaNonDemo + ' (' + pctTersisa + '%). ' +
          'Data lama dipertahankan. Cek dulu spreadsheet pusat — kalau memang benar berkurang ' +
          'sebanyak itu, turunkan SYNC_MIN_ROWS_PCT di SETTINGS lalu jalankan lagi.');
      }
    }

    // Terlalu banyak baris rusak biasanya berarti kolom IMPORTRANGE
    // bergeser, bukan datanya yang memang kosong
    if (dibaca > 0) {
      var pctRusak = Math.round((dilewati / dibaca) * 100);
      if (pctRusak > cfg.batasRusakPct && dilewati > 5) {
        throw new Error('Sync ditolak. ' + dilewati + ' dari ' + dibaca + ' baris (' + pctRusak +
          '%) tidak terbaca. Biasanya ini tanda kolom IMPORTRANGE bergeser — pastikan semua ' +
          'kolom memakai rentang baris yang sama persis, misalnya sama-sama A2:A dan D2:D. ' +
          'Data lama dipertahankan.');
      }
    }

    // Menulis ke PRODUCTS_LOCAL — file operasional milik cabang
    var target = Repo.sheet(DB.SHEET.PRODUCTS);
    var head = Repo.headers(DB.SHEET.PRODUCTS);
    var adaKolomLain = head.indexOf('stock_other') >= 0;
    if (!adaKolomLain) {
      baris = baris.map(function (b) { return b.slice(0, 10); });
    }
    var demo = [];
    Repo.all(DB.SHEET.PRODUCTS).forEach(function (p) {
      if (String(p.product_code).indexOf('DEMO-') === 0) {
        demo.push(head.map(function (k) { return p[k] === undefined ? '' : p[k]; }));
      }
    });

    /*
     * Ditulis menimpa, bukan dikosongkan dulu.
     *
     * Dulu seluruh data dihapus lebih dulu, baru ditulis ulang. Di
     * antara keduanya ada jeda di mana sheet barang benar-benar kosong.
     * Siapa pun yang mencari barang tepat pada jeda itu mendapat hasil
     * nihil — dan hasil kosong itu tersimpan sebagai salinan selama
     * lima belas menit, jadi akibatnya jauh lebih panjang dari jedanya.
     *
     * Kalau sinkronisasi berhenti di tengah karena kehabisan waktu,
     * yang tertinggal juga bukan sheet kosong, melainkan data lama
     * yang masih utuh.
     */
    var semua = baris.concat(demo);
    var lrLama = target.getLastRow();

    target.getRange(2, 1, semua.length, head.length).setValues(semua);

    // Sisa baris lama di bawahnya baru dibersihkan setelah data baru ada
    var sisa = lrLama - (semua.length + 1);
    if (sisa > 0) {
      target.getRange(semua.length + 2, 1, sisa, head.length).clearContent();
    }

    ditulis = baris.length;

    bustProductCache_();

    Repo.append(DB.SHEET.SYNC_LOG, {
      sync_id: syncId, started_at: mulai, finished_at: nowIso_(),
      mode: mode || 'MANUAL', triggered_by: oleh || 'SYSTEM',
      rows_read: dibaca, rows_written: ditulis, rows_changed: berubah,
      status: 'OK',
      message: dilewati ? dilewati + ' baris dilewati (kosong, kembar, atau tidak terbaca)' : ''
    });

    return {
      status: 'OK', sync_id: syncId,
      dibaca: dibaca, ditulis: ditulis, berubah: berubah, dilewati: dilewati,
      demo: demo.length,
      message: ditulis + ' barang tersinkron' + (berubah ? ', ' + berubah + ' berubah' : '') +
               (dilewati ? ', ' + dilewati + ' baris dilewati' : '') + '.'
    };

  } catch (e) {
    Repo.append(DB.SHEET.SYNC_LOG, {
      sync_id: syncId, started_at: mulai, finished_at: nowIso_(),
      mode: mode || 'MANUAL', triggered_by: oleh || 'SYSTEM',
      rows_read: dibaca, rows_written: 0, rows_changed: 0,
      status: 'FAIL', message: String(e.message).substring(0, 500)
    });

    return { status: 'FAIL', sync_id: syncId, message: String(e.message) };

  } finally {
    try { lock.releaseLock(); } catch (e2) {}
  }
}

// ============================================================
// API
// ============================================================

function apiSyncProduk(payload) {
  return withGuard_(payload, { permission: 'PRODUCT_SYNC_RUN' }, function (session) {
    var hasil = jalankanSync_(session.full_name, 'MANUAL');
    if (hasil.status !== 'OK') throw appErr_('SYNC_FAIL', hasil.message);

    logAudit_(session, {
      entity: 'SETTING', entity_id: 'PRODUCT_SYNC', action: 'UPDATE',
      field: 'sync', old_value: '', new_value: hasil.message
    });
    return hasil;
  });
}

function apiProductList(payload) {
  return withGuard_(payload, { permission: 'PRODUCT_VIEW' }, function () {
    var q = String(payload.q || '').trim().toLowerCase().replace(/\s+/g, '');
    var idx = getProductIndex_();

    var hasil = q
      ? idx.filter(function (p) { return p.s.indexOf(q) >= 0; })
      : idx;

    var log = Repo.all(DB.SHEET.SYNC_LOG);
    var terakhir = log.length ? log[log.length - 1] : null;

    return {
      list: hasil.slice(0, 200).map(function (p) {
        return {
          product_code: p.k, product_name: p.n, unit: p.u,
          price: p.p, stock: p.q, stock_other: p.o || '',
          need_sn: p.sn, synced_at: p.t,
          demo: String(p.k).indexOf('DEMO-') === 0
        };
      }),
      total: hasil.length,
      totalMaster: idx.length,
      demo: idx.filter(function (p) { return String(p.k).indexOf('DEMO-') === 0; }).length,
      sync: terakhir ? {
        at: Util.isoStr(terakhir.finished_at),
        status: String(terakhir.status),
        oleh: String(terakhir.triggered_by),
        mode: String(terakhir.mode),
        ditulis: Number(terakhir.rows_written) || 0,
        berubah: Number(terakhir.rows_changed) || 0,
        message: String(terakhir.message || '')
      } : null,
      pantau: (function () {
        try { return statusPantau_(); } catch (e) { return null; }
      })()
    };
  });
}

// ============================================================
// JADWAL OTOMATIS
// ============================================================

function syncProdukOtomatis() {
  var hasil = jalankanSync_('TRIGGER', 'AUTO');

  if (hasil.status !== 'OK') {
    pushNotif_({
      target_role: 'SUPERADMIN', target_branch: '',
      type: 'SYNC_FAIL', priority: 'NORMAL',
      title: 'Sinkronisasi master barang gagal',
      body: hasil.message
    });
  }
  return hasil;
}

function pasangJadwalSync() {
  hapusJadwalSync();
  var menit = Settings.num('SYNC_INTERVAL_MIN', 15);

  // Apps Script hanya menerima interval tertentu
  var pilihan = [1, 5, 10, 15, 30];
  var pakai = pilihan[0];
  for (var i = 0; i < pilihan.length; i++) if (menit >= pilihan[i]) pakai = pilihan[i];

  ScriptApp.newTrigger('syncProdukOtomatis')
    .timeBased()
    .everyMinutes(pakai)
    .create();

  return kabar_('Jadwal sinkronisasi dipasang setiap ' + pakai + ' menit.\n\n' +
    'Untuk mengubahnya: ganti SYNC_INTERVAL_MIN di sheet SETTINGS ' +
    '(pilihan: 1, 5, 10, 15, atau 30), lalu jalankan pasangJadwalSync() lagi.');
}

function hapusJadwalSync() {
  var n = 0;
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'syncProdukOtomatis') { ScriptApp.deleteTrigger(t); n++; }
  });
  return n;
}

function hapusJadwalSyncUI() {
  var n = hapusJadwalSync();
  return kabar_(n + ' jadwal sinkronisasi dihapus.');
}

// ============================================================
// PENGATURAN — jalankan sekali dari editor
// ============================================================

function siapkanPengaturanSync() {
  var sh = Repo.sheet(DB.SHEET.SETTINGS);
  var ada = {};
  Repo.columns(DB.SHEET.SETTINGS, ['key']).forEach(function (r) { ada[String(r.key).trim()] = true; });

  var now = nowIso_();
  var baru = [
    ['SYNC_MODE', 'MIRROR', 'TEXT', 'SYNC',
     'MIRROR = baca dari file perantara berisi IMPORTRANGE (dipakai ELS.ID). DIRECT = baca langsung dari spreadsheet pusat.'],
    ['CENTER_SHEET_NAME', '', 'TEXT', 'SYNC',
     'Nama sheet di spreadsheet pusat. Kosongkan untuk memakai sheet pertama.'],
    ['CENTER_HEADER_ROW', '1', 'NUMBER', 'SYNC',
     'Baris ke berapa header berada di spreadsheet pusat.'],
    ['MIRROR_SHEET_NAME', 'MIRROR_PRODUCTS', 'TEXT', 'SYNC',
     'Nama sheet di file mirror, dipakai hanya kalau SYNC_MODE = MIRROR.'],
    ['MAP_KODE', 'Kode Barang', 'TEXT', 'SYNC',
     'Nama kolom kode barang di spreadsheet pusat, ditulis persis seperti di sana.'],
    ['MAP_NAMA', 'Nama Barang', 'TEXT', 'SYNC', 'Nama kolom nama barang di spreadsheet pusat.'],
    ['MAP_HARGA', 'Harga', 'TEXT', 'SYNC', 'Nama kolom harga di spreadsheet pusat.'],
    ['MAP_STOK', 'PWT', 'TEXT', 'SYNC',
     'Nama kolom stok untuk cabang ini. Contoh: PWT. Inilah angka yang tampil sebagai stok saat Sales mencari barang.'],
    ['MAP_STOK_LAIN', '', 'TEXT', 'SYNC',
     'Kolom stok cabang lain yang ikut ditampilkan sebagai informasi, dipisah koma. Contoh: YK,SLO. Kosongkan kalau tidak perlu.'],
    ['MAP_KATEGORI', '', 'TEXT', 'SYNC', 'Nama kolom kategori. Kosongkan kalau tidak ada.'],
    ['MAP_UNIT', '', 'TEXT', 'SYNC', 'Nama kolom satuan. Kosongkan kalau tidak ada.'],
    ['MAP_NEED_SN', '', 'TEXT', 'SYNC',
     'Nama kolom penanda barang ber-serial-number. Kosongkan untuk memakai aturan SN_RULE_PREFIX.'],
    ['SYNC_MIN_ROWS_PCT', '50', 'NUMBER', 'SYNC',
     'Sync ditolak kalau jumlah barang tersisa di bawah persen ini dibanding sebelumnya. Pengaman agar sumber yang sedang bermasalah tidak mengosongkan katalog toko.'],
    ['SYNC_MAX_SKIP_PCT', '30', 'NUMBER', 'SYNC',
     'Sync ditolak kalau lebih dari persen ini baris yang tidak terbaca. Pengaman kalau kolom IMPORTRANGE bergeser.']
  ].filter(function (s) { return !ada[s[0]]; });

  if (baru.length) {
    sh.getRange(sh.getLastRow() + 1, 1, baru.length, 7).setValues(
      baru.map(function (s) { return [s[0], s[1], s[2], s[3], s[4], now, 'SETUP']; }));
  }
  Settings.bust();

  return kabar_((baru.length ? baru.length + ' pengaturan sinkronisasi ditambahkan.' : 'Pengaturan sudah ada.') +
    '\n\nLangkah berikutnya:\n' +
    '1. Buat file mirror berisi IMPORTRANGE per kolom\n' +
    '2. Isi MIRROR_SPREADSHEET_ID dan MIRROR_SHEET_NAME di SETTINGS\n' +
    '3. Jalankan siapkanKolomStokCabang()\n' +
    '4. Jalankan cekSumberPusat() untuk melihat nama kolom di mirror\n' +
    '5. Sesuaikan MAP_KODE, MAP_NAMA, MAP_HARGA, MAP_STOK, MAP_STOK_LAIN\n' +
    '6. Jalankan syncSekarang()\n' +
    '7. Kalau hasilnya benar, jalankan pasangJadwalSync()');
}

/** Menjalankan sinkronisasi dari editor */
function syncSekarang() {
  var hasil = jalankanSync_('MANUAL-EDITOR', 'MANUAL');
  return kabar_(hasil.status === 'OK'
    ? '✅ ' + hasil.message + '\n\nDibaca: ' + hasil.dibaca + ' baris\nDitulis: ' + hasil.ditulis +
      '\nBerubah: ' + hasil.berubah + '\nDilewati: ' + hasil.dilewati
    : '❌ Sync gagal.\n\n' + hasil.message);
}

// ============================================================
// MIGRASI KOLOM STOK CABANG LAIN — jalankan sekali dari editor
// ============================================================

/**
 * Menambahkan kolom stock_other di PRODUCTS_LOCAL, tempat menyimpan
 * stok cabang lain sebagai informasi. Ditaruh di paling kanan supaya
 * kolom lama tidak bergeser. Aman dijalankan berkali-kali.
 */
function siapkanKolomStokCabang() {
  var sh = Repo.sheet(DB.SHEET.PRODUCTS);
  var head = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0]
               .map(function (v) { return String(v).trim(); });

  if (head.indexOf('stock_other') >= 0) {
    return kabar_('Kolom stock_other sudah ada. Tidak ada yang perlu diubah.');
  }

  var kol = sh.getLastColumn() + 1;
  if (sh.getMaxColumns() < kol) sh.insertColumnsAfter(sh.getMaxColumns(), 1);
  sh.getRange(1, kol).setValue('stock_other')
    .setFontWeight('bold').setBackground('#f1f3f4');
  sh.setColumnWidth(kol, 160);

  Repo.clearHeaderCache();
  bustProductCache_();

  return kabar_('Kolom stock_other ditambahkan di PRODUCTS_LOCAL.\n\n' +
    'Jangan lupa tambahkan \'stock_other\' di akhir daftar kolom PRODUCTS_LOCAL ' +
    'pada file 00_Config, supaya pemeriksaan database tidak menganggapnya kolom asing.');
}

// ============================================================
// MEMANTAU PERUBAHAN DI PUSAT
//
// Harga dan barang dari pusat bisa berubah dua tiga kali sehari, dan
// tidak ada yang tahu jam berapa. Menjadwalkan sinkronisasi tiap
// setengah jam berarti dua hal yang sama-sama tidak enak: perubahan
// bisa terlambat sampai tiga puluh menit, sementara sisanya menyalin
// ribuan baris yang sama persis berulang-ulang.
//
// Jadi yang berjalan sering bukan penyalinannya, melainkan
// pemeriksaannya. Tiap lima menit sistem membaca dua kolom dari
// sumber pusat — kode dan harga — lalu meringkasnya jadi satu sidik
// pendek. Kalau sidiknya sama dengan yang terakhir dilihat, tidak ada
// yang dikerjakan. Kalau berbeda, sinkronisasi penuh langsung jalan.
//
// Hasilnya: perubahan sampai dalam lima menit, dan penyalinan penuh
// hanya terjadi saat memang ada yang berubah.
// ============================================================

var SIDIK_KEY = 'SYNC_SIDIK_PUSAT';
var SIDIK_JAM_KEY = 'SYNC_SIDIK_JAM';

/** Meringkas isi sumber pusat jadi satu sidik pendek */
function sidikPusat_() {
  var cfg = konfigSync_();
  var src = bukaSumber_(cfg);
  var sh = src.sh;

  var br = Number(cfg.barisHeader) || 1;
  var lr = sh.getLastRow();
  var lc = sh.getLastColumn();
  if (lr <= br || lc < 1) return { sidik: 'KOSONG', baris: 0 };

  var header = sh.getRange(br, 1, 1, lc).getValues()[0]
                 .map(function (v) { return String(v).trim(); });

  var iKode = header.indexOf(cfg.kolom.kode);
  var iHarga = header.indexOf(cfg.kolom.harga);
  var iStok = header.indexOf(cfg.kolom.stok);

  var kolom = [iKode, iHarga, iStok].filter(function (x) { return x >= 0; });
  if (!kolom.length) return { sidik: 'TANPA_KOLOM', baris: lr - br };

  var maks = Math.max.apply(null, kolom) + 1;
  var vals = sh.getRange(br + 1, 1, lr - br, maks).getValues();

  /*
   * Yang diringkas hanya kode, harga, dan stok.
   *
   * Tiga itu yang menentukan apa yang dijual dan berapa harganya.
   * Perubahan pada kolom lain — keterangan, kategori — tidak perlu
   * memicu penyalinan ulang seluruh daftar.
   */
  var bahan = [];
  for (var i = 0; i < vals.length; i++) {
    var r = vals[i];
    bahan.push(
      (iKode >= 0 ? String(r[iKode]) : '') + '|' +
      (iHarga >= 0 ? String(r[iHarga]) : '') + '|' +
      (iStok >= 0 ? String(r[iStok]) : '')
    );
  }

  var teks = bahan.join('\n');
  var byte = Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, teks);
  var hex = byte.map(function (b) {
    return ('0' + (b < 0 ? b + 256 : b).toString(16)).slice(-2);
  }).join('');

  return { sidik: hex, baris: vals.length };
}

/**
 * Dijalankan terjadwal tiap lima menit.
 * Menyalin hanya kalau isinya memang berubah.
 */
function pantauPerubahanPusat() {
  var jam = Number(Utilities.formatDate(new Date(), 'Asia/Jakarta', 'H'));
  var buka = Number(Settings.num('SYNC_JAM_BUKA', 7));
  var tutup = Number(Settings.num('SYNC_JAM_TUTUP', 22));
  if (jam < buka || jam >= tutup) return;

  var prop = PropertiesService.getScriptProperties();

  var hasil;
  try {
    hasil = sidikPusat_();
  } catch (e) {
    // Sumber tidak bisa dibaca — dicatat, tidak dipaksakan
    Repo.append(DB.SHEET.SYNC_LOG, {
      sync_id: Util.id('SYN'), started_at: nowIso_(), finished_at: nowIso_(),
      mode: 'PANTAU', triggered_by: 'SYSTEM',
      rows_read: 0, rows_written: 0, rows_changed: 0,
      status: 'FAIL', message: 'Gagal membaca sumber: ' + e.message
    });
    flushLog_();
    return;
  }

  var lama = String(prop.getProperty(SIDIK_KEY) || '');
  var jamLama = Number(prop.getProperty(SIDIK_JAM_KEY) || 0);
  var sekarang = new Date().getTime();

  /*
   * Jaring pengaman: tetap menyalin ulang paling lambat dua jam sekali,
   * walau sidiknya sama. Ini menutup kemungkinan ada perubahan pada
   * kolom yang tidak ikut diringkas.
   */
  var jaring = Number(Settings.num('SYNC_PAKSA_MENIT', 120)) * 60000;
  var sudahLama = !jamLama || (sekarang - jamLama) > jaring;

  if (hasil.sidik === lama && !sudahLama) return;

  var r = jalankanSync_('PANTAU', 'AUTO');

  if (r && r.status === 'OK') {
    prop.setProperty(SIDIK_KEY, hasil.sidik);
    prop.setProperty(SIDIK_JAM_KEY, String(sekarang));
  }
}

/** Memasang pemantauan tiap lima menit, menggantikan jadwal lama */
function pasangJadwalPantau() {
  ['syncProdukOtomatis', 'pantauPerubahanPusat'].forEach(function (nama) {
    ScriptApp.getProjectTriggers().forEach(function (t) {
      if (t.getHandlerFunction() === nama) ScriptApp.deleteTrigger(t);
    });
  });

  var menit = Number(Settings.num('SYNC_PANTAU_MENIT', 5));
  var pilihan = [1, 5, 10, 15, 30];
  var pakai = pilihan[0];
  for (var i = 0; i < pilihan.length; i++) if (menit >= pilihan[i]) pakai = pilihan[i];

  ScriptApp.newTrigger('pantauPerubahanPusat')
    .timeBased().everyMinutes(pakai).create();

  return kabar_('Pemantauan perubahan pusat dipasang tiap ' + pakai + ' menit.\n\n' +
    'Yang berjalan sering hanya pemeriksaannya — membaca kode, harga, dan stok ' +
    'dari sumber pusat lalu membandingkannya dengan yang terakhir dilihat.\n\n' +
    'Penyalinan penuh hanya jalan kalau memang ada yang berubah, atau paling ' +
    'lambat tiap ' + Settings.num('SYNC_PAKSA_MENIT', 120) + ' menit sebagai jaring pengaman.\n\n' +
    'Jadwal sinkronisasi lama sudah dihapus, jadi tidak ada yang berjalan dua kali.');
}

/** Melihat keadaan pemantauan sekarang */
function cekPantau() {
  var prop = PropertiesService.getScriptProperties();
  var lama = String(prop.getProperty(SIDIK_KEY) || '(belum ada)');
  var jamLama = Number(prop.getProperty(SIDIK_JAM_KEY) || 0);

  var out = ['KEADAAN PEMANTAUAN PUSAT', ''];
  out.push('Sidik terakhir : ' + lama.substring(0, 12));
  out.push('Terakhir salin : ' +
    (jamLama ? Utilities.formatDate(new Date(jamLama), 'Asia/Jakarta', 'dd MMM HH:mm')
             : 'belum pernah'));

  try {
    var kini = sidikPusat_();
    out.push('Sidik sekarang : ' + String(kini.sidik).substring(0, 12));
    out.push('Baris di pusat : ' + kini.baris);
    out.push('');
    out.push(kini.sidik === lama
      ? 'Tidak ada perubahan di pusat sejak penyalinan terakhir.'
      : 'ADA PERUBAHAN — penyalinan akan jalan pada pemeriksaan berikutnya.');
  } catch (e) {
    out.push('');
    out.push('Sumber pusat tidak bisa dibaca: ' + e.message);
  }

  var adaTrigger = false;
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'pantauPerubahanPusat') adaTrigger = true;
  });

  out.push('');
  out.push(adaTrigger ? 'Jadwal pemantauan aktif.'
                      : 'Jadwal pemantauan BELUM dipasang — jalankan pasangJadwalPantau().');

  return kabar_(out.join('\n'));
}

/**
 * Keadaan pemantauan untuk ditampilkan di layar Master Barang.
 *
 * Yang ingin diketahui staf: kapan terakhir data pusat disalin, dan
 * apakah saat ini ada perubahan yang belum masuk. Tanpa itu, satu-
 * satunya cara memastikan harga sudah terbaru adalah menekan tombol
 * sinkron — yang berarti menyalin ribuan baris hanya untuk menjawab
 * sebuah pertanyaan.
 */
function statusPantau_() {
  var prop = PropertiesService.getScriptProperties();
  var sidikLama = String(prop.getProperty(SIDIK_KEY) || '');
  var jamLama = Number(prop.getProperty(SIDIK_JAM_KEY) || 0);

  var aktif = false;
  try {
    ScriptApp.getProjectTriggers().forEach(function (t) {
      if (t.getHandlerFunction() === 'pantauPerubahanPusat') aktif = true;
    });
  } catch (e) {}

  var out = {
    aktif: aktif,
    jeda: Number(Settings.num('SYNC_PANTAU_MENIT', 5)),
    salin_terakhir: jamLama ? new Date(jamLama).toISOString() : '',
    ada_perubahan: null,
    pesan: ''
  };

  // Pemeriksaan sidik hanya dilakukan kalau diminta layar, dan
  // hasilnya disimpan sebentar supaya tidak membaca sumber berkali-kali
  var cache = CacheService.getScriptCache();
  var hit = cache.get('ELS_SIDIK_KINI');

  try {
    var kini = hit || sidikPusat_().sidik;
    if (!hit) cache.put('ELS_SIDIK_KINI', kini, 60);

    out.ada_perubahan = sidikLama ? (kini !== sidikLama) : null;
    out.pesan = !sidikLama
      ? 'Belum pernah dibandingkan.'
      : (out.ada_perubahan
         ? 'Ada perubahan di pusat yang belum tersalin.'
         : 'Data sudah sama dengan pusat.');
  } catch (e) {
    out.pesan = 'Sumber pusat tidak bisa dibaca: ' + e.message;
  }

  return out;
}
