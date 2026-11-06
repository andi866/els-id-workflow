/**
 * ELS.ID WORKFLOW SYSTEM — v2 (percepatan)
 * File : 02_Repo.gs
 *
 * Perubahan dari v1:
 * - findManyFast(): baca kolom kunci dulu, lalu ambil hanya blok baris
 *   yang cocok. Bedanya makin terasa saat transaksi sudah ribuan baris.
 * - columns(): baca sebagian kolom saja, untuk membangun indeks pencarian.
 * - cacheSetBig_/cacheGetBig_: cache yang menampung data besar dengan
 *   cara memecahnya jadi beberapa potong.
 * - ok_/err_ mengirim teks JSON, supaya tidak ada tipe data (terutama
 *   tanggal) yang tersesat dalam perjalanan ke browser.
 */

/**
 * Penanda versi per sheet.
 *
 * Setiap penulisan menaikkan versinya. Kunci cache pembacaan memuat
 * versi ini, jadi begitu ada yang menulis, seluruh salinan lama
 * otomatis tidak terpakai lagi — tanpa perlu dihapus satu per satu.
 */
/*
 * Penanda versi salinan data.
 *
 * Ini sumber keanehan yang cukup lama: daftar kadang menampilkan isi
 * lama, lalu benar lagi, lalu lama lagi tanpa pola yang jelas.
 *
 * Sebabnya penanda versi dulu dibuat dari sisa bagi waktu terhadap
 * seratus ribu — angka yang berulang setiap seratus detik. Kalau
 * penandanya kebetulan terhapus lalu dibuat lagi dengan angka yang
 * sama seperti dua menit sebelumnya, salinan lama yang masih
 * tersimpan di bawah angka itu ikut terbaca sebagai data terbaru.
 *
 * Lebih buruk lagi: saat dinaikkan, kalau penandanya hilang maka
 * hitungannya mulai dari satu — dan angka kecil seperti itu hampir
 * pasti pernah dipakai sebelumnya.
 *
 * Sekarang penandanya memakai waktu penuh ditambah angka acak, jadi
 * tidak mungkin terulang.
 */
function _verBaru_() {
  return String(Date.now()) + '-' + Math.floor(Math.random() * 100000);
}

function _verSheet(name) {
  var c = CacheService.getScriptCache();
  var k = 'ELS_VER_' + name;
  var v = c.get(k);
  if (!v) {
    v = _verBaru_();
    c.put(k, v, 21600);
  }
  return v;
}

/**
 * Meringkas daftar nama kolom jadi kode pendek.
 *
 * Kunci cache Google dibatasi 250 karakter. Kalau nama kolom digabung
 * apa adanya, sheet berkolom banyak seperti TRANSACTIONS langsung
 * melewatinya dan seluruh pembacaan gagal.
 */
function _kodeRingkas(teks) {
  var h = 0;
  for (var i = 0; i < teks.length; i++) {
    h = ((h * 31) + teks.charCodeAt(i)) | 0;
  }
  return Math.abs(h).toString(36) + '_' + teks.length;
}

function _bumpVer(name) {
  // Penanda baru, bukan penanda lama ditambah satu — lihat keterangan
  // di atas. Angka yang pernah dipakai tidak boleh muncul lagi.
  CacheService.getScriptCache().put('ELS_VER_' + name, _verBaru_(), 21600);
}

var Repo = (function () {
  var _ss = null;
  var _head = {};
  var _memo = {};          // salinan dalam satu permintaan, hilang saat selesai

  var CACHE_DETIK = 45;

  /*
   * Batas ukuran salinan yang dititipkan ke penyimpanan bersama.
   *
   * Dulu 400 KB. Untuk sheet transaksi yang besar, mengubahnya jadi teks
   * dan menitipkannya memakan ratusan milidetik — dan karena setiap
   * penyimpanan membatalkan salinan itu, ongkosnya dibayar terus tanpa
   * pernah terpakai. Yang besar sekarang cukup hidup selama satu
   * permintaan saja.
   */
  var BATAS_CACHE = 350000;

  /** Membuang salinan satu sheat saja, bukan semuanya */
  function buangMemo_(name) {
    var awalan = 'RD' + _kodeRingkas(name);
    var awalanKv = 'KV' + _kodeRingkas(name);
    Object.keys(_memo).forEach(function (k) {
      if (k.indexOf(awalan) === 0 || k.indexOf(awalanKv) === 0) delete _memo[k];
    });
  }

  function ss() {
    if (!_ss) _ss = SpreadsheetApp.getActive();
    return _ss;
  }

  function sheet(name) {
    var s = ss().getSheetByName(name);
    if (!s) throw appErr_('NO_SHEET', 'Sheet "' + name + '" tidak ditemukan. Jalankan menu Setup.');
    return s;
  }

  /*
   * Judul kolom disimpan lintas permintaan, bukan hanya di dalam satu.
   *
   * Tiap permintaan menyentuh lima sampai tujuh sheet, dan tiap sheet
   * dulu dibaca baris judulnya sekali. Itu lima sampai tujuh perjalanan
   * ke spreadsheet hanya untuk mengetahui nama kolom — yang tidak
   * pernah berubah sepanjang hari.
   */
  function headers(name) {
    if (_head[name]) return _head[name];

    try {
      var simpan = CacheService.getScriptCache().get('ELS_HEAD_' + name);
      if (simpan) {
        _head[name] = JSON.parse(simpan);
        return _head[name];
      }
    } catch (e) {}

    var s = sheet(name);
    var lc = s.getLastColumn();
    if (lc < 1) throw appErr_('NO_HEADER', 'Sheet "' + name + '" belum punya header.');

    _head[name] = s.getRange(1, 1, 1, lc).getValues()[0]
                   .map(function (v) { return String(v).trim(); });

    try {
      CacheService.getScriptCache().put('ELS_HEAD_' + name,
        JSON.stringify(_head[name]), 21600);
    } catch (e2) {}

    return _head[name];
  }

  function rowToObj(h, row, rowIndex) {
    var o = {};
    for (var i = 0; i < h.length; i++) o[h[i]] = row[i];
    o._row = rowIndex;
    return o;
  }

  function objToRow(h, o) {
    return h.map(function (k) { return o[k] === undefined || o[k] === null ? '' : o[k]; });
  }

  function bacaCache_(kunci) {
    if (_memo[kunci]) return _memo[kunci];
    if (kunci.length > 200) return null;
    var teks = cacheGetBig_(kunci);
    if (!teks) return null;
    try {
      var d = JSON.parse(teks);
      _memo[kunci] = d;
      return d;
    } catch (e) { return null; }
  }

  function tulisCache_(kunci, data) {
    _memo[kunci] = data;
    if (kunci.length > 200) return;      // pengaman, seharusnya tidak pernah kejadian

    /*
     * Batas jumlah baris dinaikkan jauh.
     *
     * Sebelumnya apa pun di atas 1.200 baris tidak disimpan sama sekali,
     * dengan alasan mengubahnya jadi teks memakan waktu. Ternyata itu
     * salah arah: yang terjadi justru sheet besar dibaca ulang dari nol
     * pada setiap permintaan, dan itu jauh lebih mahal daripada sekali
     * mengubahnya jadi teks.
     *
     * Dari pengukuran: pembacaan detail transaksi memakan 4 sampai 7
     * detik, padahal isinya tidak berubah di antara pembukaan.
     */
    if (data && data.length > 20000) return;

    try {
      var teks = JSON.stringify(data);
      if (teks.length < BATAS_CACHE) cacheSetBig_(kunci, teks, CACHE_DETIK);
    } catch (e) {}
  }

  function all(name) {
    if (adaTunda(name)) flushTunda(name);

    // Jumlah baris ikut jadi kunci — lihat keterangan di columns()
    var s = sheet(name);
    var lr = s.getLastRow();
    if (lr < 2) return [];

    var kunci = 'RD' + _kodeRingkas(name) + _verSheet(name) + 'r' + lr + '_ALL';
    var hit = bacaCache_(kunci);
    if (hit) return hit;
    var h = headers(name);
    var vals = s.getRange(2, 1, lr - 1, h.length).getValues();
    var out = [];
    for (var i = 0; i < vals.length; i++) {
      if (String(vals[i][0]).trim() === '') continue;
      out.push(rowToObj(h, vals[i], i + 2));
    }

    tulisCache_(kunci, out);
    return out;
  }

  /** Baca hanya kolom yang disebut. Dipakai untuk indeks pencarian. */
  function columns(name, cols) {
    if (adaTunda(name)) flushTunda(name);

    /*
     * Jumlah baris ikut jadi bagian kunci salinan.
     *
     * Gejalanya muncul di banyak tempat: daftar yang hilang sendiri,
     * angka laporan yang berubah tiap kali dimuat ulang, catatan
     * yang baru ditulis belum terlihat. Satu sebab yang sama —
     * salinan data yang tidak sejajar lagi dengan isi sheet.
     *
     * Nomor versi saja tidak cukup: nomor itu disimpan di tempat
     * yang juga bisa kedaluwarsa, dan beberapa orang menulis
     * bersamaan. Jumlah baris dibaca langsung dari sheet, jadi
     * begitu ada baris masuk atau keluar, salinan lamanya otomatis
     * tidak terpakai.
     *
     * Harganya satu pembacaan ringan — hanya nomor baris terakhir,
     * bukan isinya. Jauh lebih murah daripada angka laporan yang
     * tidak bisa dipercaya.
     */
    var s = sheet(name);
    var lr = s.getLastRow();
    if (lr < 2) return [];

    var kunci = 'RD' + _kodeRingkas(name) + _verSheet(name) + 'r' + lr +
                '_' + _kodeRingkas(cols.join('.'));
    var hit = bacaCache_(kunci);
    if (hit) return hit;
    var h = headers(name);
    var idx = cols.map(function (c) { return h.indexOf(c); });
    var lc = Math.max.apply(null, idx) + 1;

    /*
     * Tidak ada satu pun kolom yang diminta ada di sheet ini.
     *
     * Terjadi kalau sheetnya masih kosong atau baris judulnya belum
     * ditulis. Dulu ini membuat pembacaan gagal dengan pesan yang tidak
     * menjelaskan apa-apa — dan yang paling sering kena justru fungsi
     * penyiapan, yang memang dijalankan saat sheetnya belum lengkap.
     */
    if (lc < 1) return [];

    var vals = s.getRange(2, 1, lr - 1, lc).getValues();

    var out = [];
    for (var i = 0; i < vals.length; i++) {
      if (String(vals[i][0]).trim() === '') continue;
      var o = { _row: i + 2 };
      for (var j = 0; j < cols.length; j++) o[cols[j]] = idx[j] >= 0 ? vals[i][idx[j]] : '';
      out.push(o);
    }

    tulisCache_(kunci, out);
    return out;
  }

  /**
   * Isi satu kolom kunci, disimpan sementara.
   *
   * Dulu setiap pencarian baris membaca ulang seluruh kolom dari awal.
   * Satu kali simpan bisa melakukannya lima sampai sepuluh kali — dan
   * pada sheet berisi ribuan baris, di situlah waktunya habis.
   *
   * Sekarang kolomnya dibaca sekali, lalu dipakai bersama sampai ada
   * yang menulis ke sheet itu.
   */
  function kolomKunci_(name, col) {
    var h = headers(name);
    var idx = h.indexOf(col);
    if (idx < 0) throw appErr_('NO_COLUMN', 'Kolom "' + col + '" tidak ada di ' + name);

    // Jumlah baris ikut jadi kunci — lihat keterangan di columns()
    var s = sheet(name);
    var lr = s.getLastRow();
    if (lr < 2) return { h: h, idx: idx, vals: [] };

    var kunci = 'KV' + _kodeRingkas(name) + _verSheet(name) + 'r' + lr +
                '_' + _kodeRingkas(col);
    var hit = bacaCache_(kunci);
    if (hit) return { h: h, idx: idx, vals: hit };

    var raw = s.getRange(2, idx + 1, lr - 1, 1).getValues();
    var vals = new Array(raw.length);
    for (var i = 0; i < raw.length; i++) vals[i] = String(raw[i][0]).trim();

    tulisCache_(kunci, vals);
    return { h: h, idx: idx, vals: vals };
  }

  function findOne(name, col, val) {
    if (adaTunda(name)) flushTunda(name);
    var k = kolomKunci_(name, col);
    var target = String(val).trim();

    var sh = sheet(name);
    var lrNow = sh.getLastRow();

    // Kalau salinan kolomnya lebih panjang daripada isi sheet sekarang,
    // berarti ada baris yang sudah dihapus sejak salinan dibuat.
    // Membaca baris yang tidak ada lagi akan menggagalkan seluruh aplikasi.
    if (k.vals.length > Math.max(lrNow - 1, 0)) {
      buangMemo_(name);
      _bumpVer(name);
      return findOneLangsung_(name, col, val);
    }

    for (var i = 0; i < k.vals.length; i++) {
      if (k.vals[i] !== target) continue;
      if (i + 2 > lrNow) {
        buangMemo_(name);
        _bumpVer(name);
        return findOneLangsung_(name, col, val);
      }

      var row = sh.getRange(i + 2, 1, 1, k.h.length).getValues()[0];

      // Kalau isinya ternyata sudah bergeser, salinan kolomnya basi —
      // dibuang lalu dicari ulang langsung ke sheet
      if (String(row[k.idx]).trim() !== target) {
        buangMemo_(name);
        _bumpVer(name);
        return findOneLangsung_(name, col, val);
      }
      return rowToObj(k.h, row, i + 2);
    }
    return null;
  }

  function findManyLangsung_(name, col, val) {
    var h = headers(name);
    var idx = h.indexOf(col);
    var s = sheet(name);
    var lr = s.getLastRow();
    if (lr < 2) return [];

    var keys = s.getRange(2, idx + 1, lr - 1, 1).getValues();
    var target = String(val).trim();
    var first = -1, last = -1;
    for (var i = 0; i < keys.length; i++) {
      if (String(keys[i][0]).trim() === target) { if (first < 0) first = i; last = i; }
    }
    if (first < 0) return [];

    var block = s.getRange(first + 2, 1, last - first + 1, h.length).getValues();
    var out = [];
    for (var j = 0; j < block.length; j++) {
      if (String(block[j][idx]).trim() !== target) continue;
      out.push(rowToObj(h, block[j], first + 2 + j));
    }
    return out;
  }

  function findOneLangsung_(name, col, val) {
    var h = headers(name);
    var idx = h.indexOf(col);
    var s = sheet(name);
    var lr = s.getLastRow();
    if (lr < 2) return null;

    var keys = s.getRange(2, idx + 1, lr - 1, 1).getValues();
    var target = String(val).trim();
    for (var i = 0; i < keys.length; i++) {
      if (String(keys[i][0]).trim() === target) {
        var row = s.getRange(i + 2, 1, 1, h.length).getValues()[0];
        return rowToObj(h, row, i + 2);
      }
    }
    return null;
  }

  /**
   * Baris milik satu transaksi hampir selalu berdekatan karena ditulis
   * berurutan. Jadi cukup baca kolom kuncinya, lalu ambil satu blok dari
   * baris pertama sampai terakhir yang cocok.
   */
  function findManyFast(name, col, val) {
    if (adaTunda(name)) flushTunda(name);
    var k = kolomKunci_(name, col);
    var h = k.h, idx = k.idx;
    if (!k.vals.length) return [];

    var target = String(val).trim();
    var first = -1, last = -1;

    for (var i = 0; i < k.vals.length; i++) {
      if (k.vals[i] === target) { if (first < 0) first = i; last = i; }
    }
    if (first < 0) return [];

    var s = sheet(name);
    var lrNow = s.getLastRow();

    // Pengaman yang sama: jangan membaca baris yang sudah tidak ada
    if (last + 2 > lrNow) {
      buangMemo_(name);
      _bumpVer(name);
      return findManyLangsung_(name, col, val);
    }

    var block = s.getRange(first + 2, 1, last - first + 1, h.length).getValues();
    var out = [];
    for (var j = 0; j < block.length; j++) {
      if (String(block[j][idx]).trim() !== target) continue;
      out.push(rowToObj(h, block[j], first + 2 + j));
    }
    return out;
  }

  function findMany(name, col, val) { return findManyFast(name, col, val); }

  function exists(name, col, val) { return findOne(name, col, val) !== null; }

  /*
   * appendRow diganti penulisan langsung ke baris berikutnya.
   *
   * appendRow memaksa spreadsheet menyelaraskan seluruh isinya lebih
   * dulu sebelum menambah baris. Menulis langsung ke barisnya jauh
   * lebih ringan, dan hasilnya sama.
   */
  function append(name, obj) {
    var h = headers(name);
    var s = sheet(name);
    s.getRange(s.getLastRow() + 1, 1, 1, h.length).setValues([objToRow(h, obj)]);
    _bumpVer(name); buangMemo_(name);
    return obj;
  }

  function appendMany(name, objs) {
    if (!objs || !objs.length) return 0;
    var h = headers(name);
    var rows = objs.map(function (o) { return objToRow(h, o); });
    var s = sheet(name);
    s.getRange(s.getLastRow() + 1, 1, rows.length, h.length).setValues(rows);
    _bumpVer(name); buangMemo_(name);
    return rows.length;
  }

  function update(name, rowIndex, patch) {
    var h = headers(name);
    var s = sheet(name);
    var cur = s.getRange(rowIndex, 1, 1, h.length).getValues()[0];
    var o = rowToObj(h, cur, rowIndex);
    Object.keys(patch).forEach(function (k) {
      if (h.indexOf(k) >= 0) o[k] = patch[k];
    });
    s.getRange(rowIndex, 1, 1, h.length).setValues([objToRow(h, o)]);
    _bumpVer(name); buangMemo_(name);
    return o;
  }

  function deleteRow(name, rowIndex) {
    sheet(name).deleteRow(rowIndex);
    _bumpVer(name); buangMemo_(name);
  }

  function clearHeaderCache() {
    _head = {}; _memo = {};
    // Salinan lintas permintaan ikut dibuang, kalau tidak judul lama
    // akan terus dipakai sampai enam jam ke depan
    try {
      var c = CacheService.getScriptCache();
      Object.keys(DB.SHEET).forEach(function (k) { c.remove('ELS_HEAD_' + DB.SHEET[k]); });
    } catch (e) {}
  }

  /** Membuang seluruh salinan pembacaan sebuah sheet */
  /* ============================================================
     Penulisan yang ditunda

     Satu kali konfirmasi menulis ke baris transaksi yang sama tiga
     kali berturut-turut: saat menghitung total, saat menghitung
     pembayaran, dan saat menaikkan nomor revisi. Tiap penulisan
     adalah satu perjalanan ke spreadsheet — 200 sampai 400 milidetik
     yang dibayar tiga kali untuk mengubah satu baris.

     Sekarang ketiganya dikumpulkan dulu, lalu ditulis sekali.

     Yang menjaga supaya tidak ada data basi: setiap pembacaan pada
     sheet yang punya tunggakan akan menuliskannya lebih dulu. Jadi
     tidak mungkin ada yang membaca nilai lama, dan urutannya tetap
     seperti semula.
     ============================================================ */
  var _tunda = {};      // 'SHEET|row' -> { name, row, data }

  function tundaUpdate(name, rowIndex, patch) {
    var kunci = name + '|' + rowIndex;
    if (!_tunda[kunci]) _tunda[kunci] = { name: name, row: rowIndex, data: {} };
    Object.keys(patch).forEach(function (k) { _tunda[kunci].data[k] = patch[k]; });
    return true;
  }

  /** Menuliskan tunggakan satu sheet, atau semuanya kalau name kosong */
  function flushTunda(name) {
    var kunci = Object.keys(_tunda);
    if (!kunci.length) return 0;

    var n = 0;
    kunci.forEach(function (k) {
      var t = _tunda[k];
      if (name && t.name !== name) return;
      delete _tunda[k];
      if (Object.keys(t.data).length) { update(t.name, t.row, t.data); n++; }
    });
    return n;
  }

  function adaTunda(name) {
    var ada = false;
    Object.keys(_tunda).forEach(function (k) {
      if (!name || _tunda[k].name === name) ada = true;
    });
    return ada;
  }

  /**
   * Menulis beberapa kolom pada satu baris TANPA membaca barisnya dulu.
   *
   * update() membaca seluruh baris lebih dulu supaya kolom yang tidak
   * disentuh tetap utuh. Itu benar, tapi berarti dua perjalanan ke
   * spreadsheet untuk tiap perubahan kecil.
   *
   * Kalau yang diubah hanya satu dua kolom dan kita tahu persis
   * kolomnya, menulis langsung ke selnya jauh lebih murah.
   */
  function setNilai(name, rowIndex, patch) {
    var h = headers(name);
    var s = sheet(name);
    var n = 0;

    Object.keys(patch).forEach(function (k) {
      var idx = h.indexOf(k);
      if (idx < 0) return;
      s.getRange(rowIndex, idx + 1).setValue(patch[k]);
      n++;
    });

    if (n) { _bumpVer(name); buangMemo_(name); }
    return n;
  }

  /**
   * Mengisi satu kolom pada banyak baris dengan nilai BERBEDA-BEDA.
   *
   * Barang dalam satu pesanan biasanya menempati baris yang berurutan,
   * jadi seluruhnya bisa ditulis dalam satu perintah. Menulis sel per
   * sel berarti satu perjalanan ke spreadsheet untuk tiap barang —
   * untuk pesanan lima barang, lima perjalanan hanya untuk satu kolom.
   *
   * pasangan: [[nomorBaris, nilai], ...]
   */
  function setKolomNilai(name, pasangan, kolom) {
    if (!pasangan || !pasangan.length) return 0;

    var h = headers(name);
    var idx = h.indexOf(kolom);
    if (idx < 0) return 0;

    var s = sheet(name);
    var urut = pasangan.slice().sort(function (a, b) { return a[0] - b[0]; });

    var i = 0;
    while (i < urut.length) {
      var mulai = urut[i][0];
      var isi = [[urut[i][1]]];
      var akhir = mulai;

      while (i + 1 < urut.length && urut[i + 1][0] === akhir + 1) {
        i++; akhir = urut[i][0];
        isi.push([urut[i][1]]);
      }
      i++;

      s.getRange(mulai, idx + 1, isi.length, 1).setValues(isi);
    }

    _bumpVer(name); buangMemo_(name);
    return urut.length;
  }

  function bustSheet(name) { _bumpVer(name); buangMemo_(name); }

  /**
   * Mengisi satu kolom pada banyak baris sekaligus.
   *
   * Menulis baris per baris berarti satu perjalanan ke spreadsheet
   * untuk tiap baris — dan tiap perjalanan memakan ratusan milidetik.
   * Untuk pesanan berisi enam barang, itu enam kali ongkos yang
   * sebenarnya bisa dibayar sekali.
   *
   * baris: daftar nomor baris sheet. nilai: satu nilai untuk semuanya.
   */
  function setKolom(name, baris, kolom, nilai) {
    if (!baris || !baris.length) return 0;

    var h = headers(name);
    var idx = h.indexOf(kolom);
    if (idx < 0) return 0;

    var s = sheet(name);
    var urut = baris.slice().sort(function (a, b) { return a - b; });

    // Baris yang berurutan ditulis dalam satu perintah
    var i = 0;
    while (i < urut.length) {
      var mulai = urut[i], akhir = urut[i];
      while (i + 1 < urut.length && urut[i + 1] === akhir + 1) { i++; akhir = urut[i]; }
      i++;

      var n = akhir - mulai + 1;
      var isi = [];
      for (var k = 0; k < n; k++) isi.push([nilai]);
      s.getRange(mulai, idx + 1, n, 1).setValues(isi);
    }

    _bumpVer(name); buangMemo_(name);
    return urut.length;
  }

  return {
    all: all, columns: columns, findOne: findOne, findMany: findMany,
    findManyFast: findManyFast, exists: exists,
    append: append, appendMany: appendMany, update: update,
    deleteRow: deleteRow, headers: headers, sheet: sheet,
    clearHeaderCache: clearHeaderCache, bustSheet: bustSheet,
    setKolom: setKolom, setNilai: setNilai, setKolomNilai: setKolomNilai,
    tundaUpdate: tundaUpdate, flushTunda: flushTunda, adaTunda: adaTunda
  };
})();

// ============================================================
// CACHE BESAR (dipecah jadi beberapa potong)
// ============================================================

/** Satu potong cache Apps Script maksimal 100 KB, jadi dipotong 90 KB. */
function cacheSetBig_(key, str, seconds) {
  var c = CacheService.getScriptCache();
  var CH = 90000;
  var n = Math.ceil(str.length / CH);
  if (n > 10) { c.remove(key + '_n'); return false; }

  var obj = {};
  for (var i = 0; i < n; i++) obj[key + '_' + i] = str.substr(i * CH, CH);
  obj[key + '_n'] = String(n);
  c.putAll(obj, seconds || 600);
  return true;
}

function cacheGetBig_(key) {
  var c = CacheService.getScriptCache();
  var n = Number(c.get(key + '_n') || 0);
  if (!n) return null;

  var keys = [];
  for (var i = 0; i < n; i++) keys.push(key + '_' + i);
  var m = c.getAll(keys);

  var out = '';
  for (var j = 0; j < n; j++) {
    var part = m[key + '_' + j];
    if (part === undefined || part === null) return null;
    out += part;
  }
  return out;
}

function cacheDelBig_(key) {
  var c = CacheService.getScriptCache();
  var n = Number(c.get(key + '_n') || 0);
  var keys = [key + '_n'];
  for (var i = 0; i < n; i++) keys.push(key + '_' + i);
  c.removeAll(keys);
}

// ============================================================
// PENGATURAN
// ============================================================

var Settings = (function () {
  var _map = null;
  var CACHE_KEY = 'ELS_SETTINGS_V1';

  function load() {
    if (_map) return _map;
    var c = CacheService.getScriptCache().get(CACHE_KEY);
    if (c) { _map = JSON.parse(c); return _map; }

    _map = {};
    Repo.all(DB.SHEET.SETTINGS).forEach(function (r) {
      _map[String(r.key).trim()] = r.value;
    });
    CacheService.getScriptCache().put(CACHE_KEY, JSON.stringify(_map), 600);
    return _map;
  }

  return {
    get: function (key, def) {
      var v = load()[key];
      return (v === undefined || v === '') ? def : v;
    },
    num: function (key, def) {
      var v = parseFloat(this.get(key, def));
      return isNaN(v) ? def : v;
    },
    list: function (key) {
      return String(this.get(key, '')).split(',')
        .map(function (s) { return s.trim(); })
        .filter(function (s) { return s !== ''; });
    },
    bust: function () {
      _map = null;
      CacheService.getScriptCache().remove(CACHE_KEY);
    }
  };
})();

// ============================================================
// FUNGSI BANTU
// ============================================================

var Util = {
  id: function (prefix) {
    return prefix + '-' + Utilities.getUuid().replace(/-/g, '').substring(0, 8).toUpperCase();
  },

  token: function () {
    return Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '').substring(0, 8);
  },

  pad: function (n, len) {
    var s = String(n);
    while (s.length < len) s = '0' + s;
    return s;
  },

  todayStr: function () {
    return Utilities.formatDate(new Date(), 'Asia/Jakarta', 'yyyy-MM-dd');
  },

  /** Apa pun bentuk aslinya (teks atau tanggal sheet) → 'YYYY-MM-DD' */
  dateStr: function (v) {
    if (!v) return '';
    if (v instanceof Date) return Utilities.formatDate(v, 'Asia/Jakarta', 'yyyy-MM-dd');
    return String(v).substring(0, 10);
  },

  /** Apa pun bentuk aslinya → teks ISO */
  isoStr: function (v) {
    if (!v) return '';
    if (v instanceof Date) return Utilities.formatDate(v, 'Asia/Jakarta', "yyyy-MM-dd'T'HH:mm:ssXXX");
    return String(v);
  },

  normPhone: function (p) {
    var d = String(p || '').replace(/[^0-9]/g, '');
    if (!d) return '';
    if (d.indexOf('0') === 0) d = '62' + d.substring(1);
    else if (d.indexOf('62') !== 0) d = '62' + d;
    return d;
  },

  /** 0877… / +62877… / 62877… / 877… → semuanya jadi 877… */
  /**
   * Mengembalikan angka nol di depan nomor telepon.
   *
   * Spreadsheet memperlakukan 085xxxx sebagai angka, dan angka tidak
   * punya nol di depan — jadi yang tersimpan jadi 85xxxx. Itu terjadi
   * diam-diam, dan baru ketahuan saat ada yang mau menelepon.
   *
   * Dikembalikan saat dibaca, bukan dipaksakan saat ditulis, supaya
   * nomor yang terlanjur kehilangan nolnya ikut terbaca benar tanpa
   * perlu membetulkan satu per satu di sheet.
   */
  hp: function (v) {
    var t = String(v === undefined || v === null ? '' : v).trim();
    if (!t) return '';

    // Sudah benar — diawali 0, +62, atau bukan angka sama sekali
    if (t.indexOf('0') === 0 || t.indexOf('+') === 0) return t;
    if (!/^[0-9]+$/.test(t)) return t;

    // Nomor Indonesia tanpa nol: 8xx, panjangnya 9 sampai 13 angka
    if (t.indexOf('8') === 0 && t.length >= 9 && t.length <= 13) return '0' + t;

    // Sudah memakai kode negara
    if (t.indexOf('62') === 0 && t.length >= 11) return '0' + t.substring(2);

    return t;
  },

  coreHp: function (s) {
    var d = String(s || '').replace(/[^0-9]/g, '');
    if (d.indexOf('62') === 0) d = d.substring(2);
    else if (d.indexOf('0') === 0) d = d.substring(1);
    return d;
  },

  isTrue: function (v) {
    return v === true || String(v).toUpperCase() === 'TRUE' || v === 1 || v === '1';
  },

  addHours: function (iso, hours) {
    var d = iso ? new Date(iso) : new Date();
    d.setTime(d.getTime() + hours * 3600 * 1000);
    return Utilities.formatDate(d, 'Asia/Jakarta', "yyyy-MM-dd'T'HH:mm:ssXXX");
  },

  isPast: function (iso) {
    if (!iso) return true;
    return new Date(iso).getTime() < new Date().getTime();
  }
};

// ============================================================
// BENTUK JAWABAN KE BROWSER
// Selalu teks JSON, supaya tidak ada tipe data yang berubah
// bentuk di tengah perjalanan.
// ============================================================

function ok_(data) {
  return JSON.stringify({
    ok: true,
    data: data === undefined ? null : data,
    meta: { serverTime: nowIso_() }
  });
}

function err_(code, message, details) {
  return JSON.stringify({
    ok: false,
    code: code || 'ERROR',
    message: message || 'Terjadi kesalahan.',
    details: details || null,
    meta: { serverTime: nowIso_() }
  });
}

function appErr_(code, message) {
  var e = new Error(message);
  e.code = code;
  return e;
}

/**
 * Mencari transaksi di sheet utama, lalu jatuh ke sheet arsip kalau
 * tidak ketemu. Dengan begitu transaksi lama tetap bisa dibuka
 * detailnya walau sudah dipindah.
 */
function cariTrx_(trxId) {
  var t = Repo.findOne(DB.SHEET.TRX, 'trx_id', trxId);
  if (t) return t;
  try {
    var a = Repo.findOne(DB.SHEET.TRX_ARCHIVE, 'trx_id', trxId);
    if (a) { a._arsip = true; return a; }
  } catch (e) {}
  return null;
}
