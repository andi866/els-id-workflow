/**
 * ELS.ID WORKFLOW SYSTEM — v2 (percepatan)
 * File : 05_ProductService.gs
 *
 * Perubahan dari v1:
 * - Indeks produk memakai cache berpotongan, jadi katalog besar pun
 *   tetap tersimpan di cache (v1 menyerah di atas 95 KB).
 * - Hanya kolom yang perlu yang dibaca dari sheet.
 * - kabar_() menggantikan pemanggilan dialog langsung, supaya fungsi
 *   bisa dijalankan dari editor maupun dari menu spreadsheet.
 *
 * PENTING: file ini HANYA MEMBACA. Tidak ada fungsi di sini yang
 * menulis ke spreadsheet pusat.
 */

var PROD_IDX_KEY = 'ELS_PRODIDX_V2';

function getProductIndex_() {
  var hit = cacheGetBig_(PROD_IDX_KEY);
  if (hit) {
    try { return JSON.parse(hit); } catch (e) {}
  }

  var rows = Repo.columns(DB.SHEET.PRODUCTS,
    ['product_code', 'product_name', 'unit', 'price', 'stock', 'need_sn',
     'is_active', 'search_key', 'synced_at', 'stock_other']);

  var out = [];
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    var code = String(r.product_code).trim();
    if (!code) continue;
    if (r.is_active !== '' && !Util.isTrue(r.is_active)) continue;

    var key = r.search_key ? String(r.search_key) : (code + String(r.product_name));
    out.push({
      k: code,
      n: String(r.product_name),
      u: String(r.unit || ''),
      p: Number(r.price) || 0,
      q: r.stock === '' ? '' : Number(r.stock),
      sn: Util.isTrue(r.need_sn),
      t: Util.isoStr(r.synced_at),
      o: String(r.stock_other || ''),
      s: key.toLowerCase().replace(/\s+/g, '')
    });
  }

  /*
   * Hasil kosong tidak pernah disimpan.
   *
   * Pembacaan bisa saja mengenai saat sheet barang sedang ditulis
   * ulang. Kalau hasil kosong ikut disimpan, seluruh toko kehilangan
   * daftar barang selama lima belas menit berikutnya — padahal
   * datanya sudah kembali beberapa detik kemudian.
   */
  if (out.length) cacheSetBig_(PROD_IDX_KEY, JSON.stringify(out), 900);
  return out;
}

function bustProductCache_() { cacheDelBig_(PROD_IDX_KEY); }

// ============================================================
// API
// ============================================================

function apiSearchProduct(payload) {
  return withGuard_(payload, { permission: 'PRODUCT_VIEW' }, function () {
    var mentah = String(payload.q || '').trim().toLowerCase();
    if (mentah.length < 2) return [];

    var q = mentah.replace(/\s+/g, '');

    /*
     * Semua barang diperiksa, baru hasilnya diurutkan.
     *
     * Dulu pencarian berhenti setelah 24 hasil pertama menurut urutan
     * baris di sheet. Akibatnya barang yang letaknya di bawah tidak
     * pernah muncul walaupun namanya cocok — dan yang terlihat staf
     * adalah "barangnya tidak ada di sistem", padahal ada.
     *
     * Sekarang seluruh daftar diperiksa, lalu 25 yang paling cocok
     * yang ditampilkan. Kata yang diketik terpisah dicocokkan semuanya,
     * jadi "lenovo loq 15" menemukan barang yang memuat ketiganya
     * walaupun urutannya berbeda.
     */
    var kata = mentah.split(/\s+/).filter(function (x) { return x.length >= 2; });
    var idx = getProductIndex_();
    var hasil = [];

    for (var i = 0; i < idx.length; i++) {
      var p = idx[i];
      var kode = String(p.k).toLowerCase();
      var nilai = 0;

      if (kode === q) nilai = 1000;                          // kode persis
      else if (kode.indexOf(q) === 0) nilai = 800;           // kode diawali
      else if (p.s.indexOf(q) >= 0) nilai = 600;             // cocok utuh
      else if (kata.length > 1) {
        // Semua kata harus ada, urutannya bebas
        var lengkap = true;
        for (var w = 0; w < kata.length; w++) {
          if (p.s.indexOf(kata[w]) < 0) { lengkap = false; break; }
        }
        if (lengkap) nilai = 400;
      }

      if (!nilai) continue;

      // Yang ada stoknya didahulukan — itu yang bisa langsung dijual
      if (p.q !== '' && Number(p.q) > 0) nilai += 50;

      hasil.push({ p: p, nilai: nilai });
    }

    hasil.sort(function (a, b) {
      if (b.nilai !== a.nilai) return b.nilai - a.nilai;
      return String(a.p.n).localeCompare(String(b.p.n));
    });

    var persisAda = hasil.length && hasil[0].nilai >= 1000;

    return hasil.slice(0, 25).map(function (x) {
      var p = x.p;
      return {
        product_code: p.k, product_name: p.n, price: p.p,
        stock: p.q, stock_other: p.o, need_sn: p.sn, unit: p.u, synced_at: p.t,
        exact: persisAda && String(p.k).toLowerCase() === q
      };
    });
  });
}

function apiProductStats(payload) {
  return withGuard_(payload, { permission: 'PRODUCT_VIEW' }, function () {
    var idx = getProductIndex_();
    return {
      total: idx.length,
      synced_at: idx.length ? idx[0].t : '',
      demo: idx.filter(function (p) { return String(p.k).indexOf('DEMO-') === 0; }).length
    };
  });
}

// ============================================================
// SERIAL NUMBER — deteksi berlapis, tanpa perawatan manual
//
// Menandai ribuan barang satu per satu mustahil dirawat. Jadi
// penandanya disimpulkan sistem dari empat lapis:
//   1. Kolom dari pusat, kalau tersedia
//   2. Kata pada nama barang (laptop, printer, cctv, ...)
//   3. Awalan kode barang
//   4. Riwayat: kode ini pernah diisi SN sebelumnya
//
// Hasilnya hanya peringatan, bukan larangan. Gudang tetap boleh
// mengosongkan SN kalau barangnya memang tidak punya.
// ============================================================

var SN_HIST_KEY = 'ELS_SNHIST_V1';

/** Kode barang yang pernah diisi SN — sistem belajar dari kebiasaan Gudang */
function kodePernahSn_() {
  var hit = cacheGetBig_(SN_HIST_KEY);
  if (hit) {
    try { return JSON.parse(hit); } catch (e) {}
  }

  var set = {};
  try {
    Repo.columns(DB.SHEET.SN, ['sn_id', 'product_code', 'is_active']).forEach(function (r) {
      if (!Util.isTrue(r.is_active)) return;
      var k = String(r.product_code || '').trim().toUpperCase();
      if (k) set[k] = 1;
    });
  } catch (e) {}

  cacheSetBig_(SN_HIST_KEY, JSON.stringify(set), 1800);
  return set;
}

function bustSnHistCache_() { cacheDelBig_(SN_HIST_KEY); }

/**
 * Menentukan apakah sebuah barang sebaiknya punya SN.
 * Mengembalikan { perlu: true/false, alasan: '...' }
 */
function saranSn_(productCode, productName, fromMaster) {
  var code = String(productCode || '').toUpperCase();
  var nama = String(productName || '').toLowerCase();

  /*
   * Pengecualian diperiksa PALING AWAL.
   *
   * Aksesori sering menyebut barang induknya di namanya — "Skin Cover
   * 14 inci Laptop", "Tas Laptop", "Screen Protector". Aturan kata
   * menandainya sebagai barang ber-SN, padahal justru sebaliknya.
   *
   * Kalau pengecualian diperiksa belakangan, penanda dari aturan lain
   * sudah terlanjur menang.
   */
  var kecualiNama = Settings.list('SN_RULE_KECUALI_NAMA');
  for (var a = 0; a < kecualiNama.length; a++) {
    var kn = String(kecualiNama[a]).toLowerCase().trim();
    if (kn && nama.indexOf(kn) >= 0) return { perlu: false, alasan: '' };
  }

  var kecualiKode = Settings.list('SN_RULE_KECUALI_KODE');
  for (var b = 0; b < kecualiKode.length; b++) {
    var kk = String(kecualiKode[b]).toUpperCase().trim();
    if (kk && code.indexOf(kk) >= 0) return { perlu: false, alasan: '' };
  }

  // 1. Penanda dari pusat paling diutamakan
  if (fromMaster !== undefined && fromMaster !== '' && fromMaster !== null) {
    if (Util.isTrue(fromMaster)) return { perlu: true, alasan: 'ditandai dari pusat' };
  }

  // 2. Kata pada nama barang
  var kata = Settings.list('SN_RULE_NAMA');
  for (var i = 0; i < kata.length; i++) {
    var k = String(kata[i]).toLowerCase().trim();
    if (k && nama.indexOf(k) >= 0) return { perlu: true, alasan: 'nama mengandung "' + k + '"' };
  }

  // 3. Awalan kode barang
  var prefixes = Settings.list('SN_RULE_PREFIX');
  for (var j = 0; j < prefixes.length; j++) {
    var p = String(prefixes[j]).toUpperCase().trim();
    if (p && code.indexOf(p) === 0) return { perlu: true, alasan: 'kode berawalan ' + p };
  }

  // 4. Pernah diisi SN sebelumnya
  if (Util.isTrue(Settings.get('SN_LEARN_FROM_HISTORY', 'TRUE'))) {
    if (code && kodePernahSn_()[code]) {
      return { perlu: true, alasan: 'barang ini pernah diisi SN sebelumnya' };
    }
  }

  return { perlu: false, alasan: '' };
}

/** Bentuk ringkas, dipakai saat sinkronisasi dan penambahan barang */
function needsSn_(productCode, fromMaster, productName) {
  return saranSn_(productCode, productName, fromMaster).perlu;
}

/** Pengaturan aturan SN — jalankan sekali dari editor */
function siapkanAturanSn() {
  var sh = Repo.sheet(DB.SHEET.SETTINGS);
  var ada = {};
  Repo.columns(DB.SHEET.SETTINGS, ['key']).forEach(function (r) { ada[String(r.key).trim()] = true; });

  var now = nowIso_();
  var baru = [
    ['SN_RULE_NAMA',
     'laptop,notebook,macbook,handphone,smartphone,printer,cctv,kamera,monitor,proyektor,tablet,ipad,console,router,modem',
     'TEXT', 'PRODUK',
     'Kata pada NAMA barang yang menandakan barang itu biasanya punya serial number. Dipisah koma, tidak peduli huruf besar kecil. Ini lapis deteksi paling ampuh untuk data yang beragam.'],
    ['SN_LEARN_FROM_HISTORY', 'TRUE', 'TEXT', 'PRODUK',
     'TRUE = kode barang yang pernah diisi SN otomatis ditandai perlu SN di transaksi berikutnya. Sistem belajar dari kebiasaan Gudang tanpa perlu diatur.'],
    ['SN_RULE_KECUALI_NAMA',
     'skin,cover,sticker,garskin,sleeve,tas,pouch,screen protector,protector,anti gores,pelindung,stand,holder,kabel,adaptor,thermal,cleaning,anti virus,antivirus,office,windows,software,lisensi,license,warranty,total care,etc ',
     'TEXT', 'PRODUK',
     'Kata pada nama barang yang MEMBATALKAN penanda SN. Aksesori sering menyebut barang induknya — "Skin Cover 14 inci Laptop" bukan barang ber-SN. Diperiksa paling awal, mengalahkan aturan lain.'],
    ['SN_RULE_KECUALI_KODE', '-Z-,-NP-Z-,-SOFT-,PC-SOFT,Z-NB-ETC,-ETC-', 'TEXT', 'PRODUK',
     'Potongan kode barang yang MEMBATALKAN penanda SN. Contoh: -Z- kalau kode aksesori ELS memakai penanda itu. Kosongkan kalau tidak dipakai.']
  ].filter(function (s) { return !ada[s[0]]; });

  if (baru.length) {
    sh.getRange(sh.getLastRow() + 1, 1, baru.length, 7).setValues(
      baru.map(function (s) { return [s[0], s[1], s[2], s[3], s[4], now, 'SETUP']; }));
  }
  Settings.bust();
  bustSnHistCache_();

  return kabar_((baru.length ? baru.length + ' aturan SN ditambahkan.' : 'Aturan SN sudah ada.') +
    '\n\nDi layar Gudang, SEMUA barang punya kotak SN. Yang bertanda hanya diperingatkan ' +
    'kalau dikosongkan, tidak diblokir.\n\n' +
    'Sesuaikan SN_RULE_NAMA dengan jenis barang yang dijual ELS.ID, dan ' +
    'SN_RULE_KECUALI_NAMA dengan aksesori yang sering salah tertandai.');
}

// ============================================================
// DATA CONTOH — HANYA UNTUK UJI COBA
// ============================================================

function isiProdukContoh() {
  var demo = [
    ['DEMO-LPT001', 'Laptop ASUS Vivobook 14 i5', 'Laptop', 'UNIT', 8750000, 4, true],
    ['DEMO-LPT002', 'Laptop Lenovo IdeaPad Slim 3', 'Laptop', 'UNIT', 6350000, 2, true],
    ['DEMO-PRN001', 'Printer Epson L3210', 'Printer', 'UNIT', 2450000, 7, true],
    ['DEMO-HP001',  'Handphone Samsung A16 8/256', 'Handphone', 'UNIT', 3199000, 11, true],
    ['DEMO-CCTV01', 'CCTV Hikvision 2MP Indoor', 'CCTV', 'UNIT', 385000, 20, true],
    ['DEMO-ACC001', 'Mouse Wireless Logitech M170', 'Aksesoris', 'PCS', 145000, 35, false],
    ['DEMO-ACC002', 'Tas Laptop 14 inch', 'Aksesoris', 'PCS', 95000, 18, false],
    ['DEMO-ACC003', 'Tinta Epson 003 Black', 'Aksesoris', 'PCS', 89000, 42, false],
    ['DEMO-SRV001', 'Jasa Instalasi Windows + Office', 'Jasa', 'PCS', 150000, '', false],
    ['DEMO-SRV002', 'Jasa Pasang CCTV per titik', 'Jasa', 'PCS', 250000, '', false]
  ];

  var now = nowIso_();
  var rows = demo.map(function (d) {
    return {
      product_code: d[0], product_name: d[1], category: d[2], unit: d[3],
      price: d[4], stock: d[5], need_sn: d[6], is_active: true,
      search_key: (d[0] + d[1]).toLowerCase().replace(/\s+/g, ''),
      synced_at: now
    };
  });

  var ada = {};
  Repo.columns(DB.SHEET.PRODUCTS, ['product_code']).forEach(function (p) {
    ada[String(p.product_code)] = true;
  });
  var baru = rows.filter(function (r) { return !ada[r.product_code]; });

  Repo.appendMany(DB.SHEET.PRODUCTS, baru);
  bustProductCache_();

  return kabar_(baru.length + ' barang contoh ditambahkan. Semua berawalan DEMO-. ' +
    'Jalankan hapusProdukContoh() sebelum sistem dipakai operasional.');
}

function hapusProdukContoh() {
  var sh = Repo.sheet(DB.SHEET.PRODUCTS);
  var rows = Repo.columns(DB.SHEET.PRODUCTS, ['product_code']);
  var n = 0;
  for (var i = rows.length - 1; i >= 0; i--) {
    if (String(rows[i].product_code).indexOf('DEMO-') === 0) { sh.deleteRow(rows[i]._row); n++; }
  }
  bustProductCache_();
  return kabar_(n + ' barang contoh dihapus.');
}

/** Bersihkan semua cache — berguna kalau data sheet diubah manual */
function bersihkanCache() {
  bustProductCache_();
  bustCustomerCache_();
  bustSnHistCache_();
  Settings.bust();
  return kabar_('Cache dibersihkan. Data terbaru akan dibaca ulang dari sheet.');
}

/**
 * Menampilkan pesan lewat dialog kalau dijalankan dari menu spreadsheet,
 * atau lewat log kalau dijalankan dari editor Apps Script.
 */
/**
 * Menampilkan hasil fungsi perawatan di Execution log.
 *
 * Dulu memakai kotak dialog spreadsheet. Masalahnya, kalau
 * spreadsheetnya kebetulan terbuka di tab lain, perintahnya MENUNGGU
 * tombol OK ditekan di tab itu — dan dari sisi editor terlihat seperti
 * menggantung tanpa sebab. Sudah beberapa kali membuang waktu.
 *
 * Execution log selalu bisa dibaca, tidak pernah menunggu siapa pun.
 */
function kabar_(pesan) {
  console.log(pesan);
  return pesan;
}
