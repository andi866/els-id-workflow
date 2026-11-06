/**
 * ELS.ID WORKFLOW SYSTEM — Phase 11 (optimasi)
 * File : 17_Maintenance.gs
 * Isi  : Perkakas pemeliharaan — arsip, pengukuran, pemeriksaan.
 *
 * Semua fungsi di sini dijalankan dari editor Apps Script, bukan dari
 * aplikasi. Sifatnya sesekali, bukan harian.
 */

// ============================================================
// PENGUKURAN PEMAKAIAN
// ============================================================

/**
 * Melihat perkiraan pemakaian waktu server hari ini.
 *
 * Angkanya perkiraan, karena disimpan di memori sementara yang bisa
 * dibersihkan Google kapan saja. Gunanya melihat pola, bukan menghitung
 * tepat. Untuk angka pasti, buka menu Executions di panel kiri.
 */
function cekPemakaianHarian() {
  var c = CacheService.getScriptCache();
  var hari = Utilities.formatDate(new Date(), 'Asia/Jakarta', 'yyyyMMdd');

  var ms = Number(c.get('ELS_USE_MS_' + hari) || 0);
  var n = Number(c.get('ELS_USE_N_' + hari) || 0);
  var menit = Math.round(ms / 600) / 100;
  var jatah = 360;                       // Google Workspace: 6 jam per hari
  var pct = Math.round((menit / jatah) * 100);

  var trxHariIni = 0;
  try {
    var today = Util.todayStr();
    Repo.columns(DB.SHEET.TRX, ['trx_id', 'trx_date', 'stage_status']).forEach(function (t) {
      if (Util.dateStr(t.trx_date) === today && String(t.stage_status) !== 'DRAFT') trxHariIni++;
    });
  } catch (e) {}

  var perTrx = trxHariIni ? Math.round((ms / trxHariIni) / 100) / 10 : 0;

  return kabar_(
    'PERKIRAAN PEMAKAIAN HARI INI\n\n' +
    'Waktu server : ' + menit + ' menit dari ' + jatah + ' menit (' + pct + '%)\n' +
    'Permintaan   : ' + n + ' kali\n' +
    'Transaksi    : ' + trxHariIni + '\n' +
    (perTrx ? 'Per transaksi: ' + perTrx + ' detik\n' : '') +
    '\nAngka ini perkiraan dari memori sementara dan bisa ikut hilang ' +
    'kalau memorinya dibersihkan. Untuk angka pasti, buka menu Executions ' +
    'di panel kiri Apps Script.\n\n' +
    (pct > 70
      ? '⚠️ Pemakaian sudah di atas 70%. Jalankan arsipkanTransaksiLama() dan ' +
        'pertimbangkan menaikkan jeda pengecekan di SETTINGS.'
      : '✅ Masih lapang.'));
}

// ============================================================
// ARSIP TRANSAKSI LAMA
// ============================================================

/**
 * Memindahkan transaksi yang sudah selesai dan sudah lama ke sheet
 * arsip, supaya sheet utama tetap ringan.
 *
 * Yang dipindah hanya kepala transaksinya. Barang, SN, pembayaran,
 * dan riwayatnya tetap di tempatnya — jadi pelacakan SN dan laporan
 * lama tidak terganggu.
 *
 * Transaksi yang sudah diarsipkan tetap bisa dibuka detailnya, karena
 * pencariannya jatuh ke sheet arsip kalau tidak ketemu di sheet utama.
 */
/* ============================================================
   PENGARSIPAN HARIAN

   Dengan 100 sampai 300 transaksi sehari, menunggu berbulan-bulan
   membuat sheet utama berisi puluhan ribu baris — dan tiap pembacaan
   mengambil seluruh isinya. Jadi diarsipkan tiap hari.

   Yang dipindah HANYA yang benar-benar tuntas:
     - sudah selesai DAN barangnya sudah diserahkan, atau
     - sudah dibatalkan

   Yang belum tuntas tetap tinggal, berapa lama pun umurnya: indent
   yang menunggu barang, yang belum lunas, yang belum diaktivasi, yang
   belum diambil. Semuanya masih pekerjaan seseorang, jadi harus tetap
   terlihat.

   Susunan berkasnya:

     ELS_ARSIP / 2026 / 2026-09 / ELS_ARSIP_2026-09-21

   Tiap transaksi yang diarsipkan dicatat di sheet ARSIP_INDEX pada
   database utama, lengkap dengan tautan berkasnya — jadi mencarinya
   nanti tidak perlu membuka folder satu per satu.
   ============================================================ */

var ARSIP_FOLDER = 'ELS_ARSIP';
var ARSIP_INDEX = 'ARSIP_INDEX';
var ARSIP_SHEET = ['TRX', 'ITEMS', 'SN', 'PAYMENTS', 'TIMELINE'];

function folderArsip_(nama, induk) {
  var cari = induk ? induk.getFoldersByName(nama) : DriveApp.getFoldersByName(nama);
  if (cari.hasNext()) return cari.next();
  return induk ? induk.createFolder(nama) : DriveApp.createFolder(nama);
}

/** Berkas arsip untuk satu tanggal, dibuat kalau belum ada */
function berkasArsip_(tanggal) {
  var tahun = String(tanggal).substring(0, 4);
  var bulan = String(tanggal).substring(0, 7);

  var fRoot = folderArsip_(ARSIP_FOLDER, null);
  var fTahun = folderArsip_(tahun, fRoot);
  var fBulan = folderArsip_(bulan, fTahun);

  var nama = 'ELS_ARSIP_' + tanggal;
  var ada = fBulan.getFilesByName(nama);
  if (ada.hasNext()) return SpreadsheetApp.open(ada.next());

  var ss = SpreadsheetApp.create(nama);
  var berkas = DriveApp.getFileById(ss.getId());
  fBulan.addFile(berkas);
  try { DriveApp.getRootFolder().removeFile(berkas); } catch (e) {}

  ARSIP_SHEET.forEach(function (k) {
    var nm = DB.SHEET[k];
    var sh = ss.insertSheet(nm);
    var h = DB.HEADERS[nm];
    if (h && h.length) {
      sh.getRange(1, 1, 1, h.length).setValues([h])
        .setFontWeight('bold').setBackground('#f1f3f4');
      sh.setFrozenRows(1);
    }
  });

  var bawaan = ss.getSheetByName('Sheet1') || ss.getSheetByName('Sheet 1');
  if (bawaan) ss.deleteSheet(bawaan);

  return ss;
}

function pindahBaris_(namaSheet, punyaTrx, arsipSS) {
  var sh = Repo.sheet(namaSheet);
  var lr = sh.getLastRow(), lc = sh.getLastColumn();
  if (lr < 2 || lc < 1) return 0;

  var head = sh.getRange(1, 1, 1, lc).getValues()[0]
               .map(function (v) { return String(v).trim(); });
  var iTrx = head.indexOf('trx_id');
  if (iTrx < 0) return 0;

  var vals = sh.getRange(2, 1, lr - 1, lc).getValues();
  var pindah = [], sisa = [];

  for (var i = 0; i < vals.length; i++) {
    if (punyaTrx[String(vals[i][iTrx])]) pindah.push(vals[i]);
    else sisa.push(vals[i]);
  }
  if (!pindah.length) return 0;

  var shArsip = arsipSS.getSheetByName(namaSheet);
  if (!shArsip) {
    shArsip = arsipSS.insertSheet(namaSheet);
    shArsip.getRange(1, 1, 1, head.length).setValues([head])
           .setFontWeight('bold').setBackground('#f1f3f4');
    shArsip.setFrozenRows(1);
  }
  shArsip.getRange(shArsip.getLastRow() + 1, 1, pindah.length, head.length)
         .setValues(pindah);

  // Sisanya ditulis ulang sekaligus, bukan dihapus baris per baris
  if (sisa.length) sh.getRange(2, 1, sisa.length, lc).setValues(sisa);
  var kosong = (lr - 1) - sisa.length;
  if (kosong > 0) sh.getRange(sisa.length + 2, 1, kosong, lc).clearContent();

  Repo.bustSheet(namaSheet);
  return pindah.length;
}

/** Sheet daftar arsip di database utama, dibuat kalau belum ada */
function sheetIndexArsip_() {
  var ss = SpreadsheetApp.getActive();
  var sh = ss.getSheetByName(ARSIP_INDEX);
  if (sh) return sh;

  sh = ss.insertSheet(ARSIP_INDEX);
  var h = ['trx_no', 'trx_date', 'cust_name', 'sales_name', 'grand_total',
           'stage_status', 'nota_no', 'berkas', 'tautan', 'diarsipkan_at'];
  sh.getRange(1, 1, 1, h.length).setValues([h])
    .setFontWeight('bold').setBackground('#f1f3f4');
  sh.setFrozenRows(1);
  sh.setColumnWidth(1, 170); sh.setColumnWidth(3, 200); sh.setColumnWidth(9, 320);
  return sh;
}

/** Menentukan apakah satu transaksi sudah benar-benar tuntas */
function sudahTuntas_(t) {
  var tahap = String(t.stage_status);

  if (tahap === 'DIBATALKAN' || Util.isTrue(t.is_void)) return true;

  if (tahap !== 'SELESAI' && tahap !== 'AKTIVASI_SELESAI') return false;
  if (String(t.payment_status) !== 'LUNAS') return false;

  // Barangnya harus sudah benar-benar diserahkan
  var f = {};
  try { f = JSON.parse(String(t.override_flags || '') || '{}'); } catch (e) {}
  return !!(f.diserahkan && f.diserahkan.at);
}

/**
 * Mengarsipkan transaksi yang sudah tuntas.
 * Dijadwalkan harian, aman dijalankan kapan saja.
 */
function arsipHarian() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) return kabar_('Ada proses lain sedang berjalan. Coba lagi sebentar.');

  try {
    var hari = Number(Settings.num('ARCHIVE_AFTER_DAYS', 1));
    var batasJumlah = Number(Settings.num('ARCHIVE_MAX_PER_RUN', 300));

    var batas = new Date();
    batas.setDate(batas.getDate() - hari);
    var batasStr = Utilities.formatDate(batas, 'Asia/Jakarta', 'yyyy-MM-dd');

    var perTanggal = {};
    Repo.all(DB.SHEET.TRX).forEach(function (t) {
      if (!sudahTuntas_(t)) return;
      var tgl = Util.dateStr(t.trx_date);
      if (!tgl || tgl > batasStr) return;          // hari ini tidak ikut
      if (!perTanggal[tgl]) perTanggal[tgl] = [];
      perTanggal[tgl].push(t);
    });

    var tanggalAda = Object.keys(perTanggal).sort();
    if (!tanggalAda.length) {
      return kabar_('Tidak ada transaksi yang perlu diarsipkan.\n\n' +
        'Yang diarsipkan hanya yang sudah tuntas: selesai dan barangnya sudah ' +
        'diserahkan, atau dibatalkan. Yang masih berjalan tetap tinggal.');
    }

    // Satu tanggal per jalan, dimulai dari yang paling lama
    var tanggal = tanggalAda[0];
    var daftar = perTanggal[tanggal].slice(0, batasJumlah);

    var punyaTrx = {};
    daftar.forEach(function (t) { punyaTrx[String(t.trx_id)] = true; });

    var arsipSS = berkasArsip_(tanggal);
    var tautan = arsipSS.getUrl();
    var namaBerkas = 'ELS_ARSIP_' + tanggal;

    /*
     * Daftar arsip ditulis DULU, sebelum barisnya dipindah.
     *
     * Kalau pemindahan berhenti di tengah, yang terjadi adalah ada
     * catatan untuk transaksi yang masih di tempatnya — itu mudah
     * diperiksa. Kebalikannya jauh lebih buruk: transaksi hilang dari
     * sheet utama tanpa ada catatan di mana mencarinya.
     */
    var shIdx = sheetIndexArsip_();
    var barisIdx = daftar.map(function (t) {
      return [
        String(t.trx_no), Util.dateStr(t.trx_date), String(t.cust_name_snap),
        String(t.sales_name || ''), Number(t.grand_total) || 0,
        String(t.stage_status), String(t.nota_no || ''),
        namaBerkas, tautan, nowIso_()
      ];
    });
    shIdx.getRange(shIdx.getLastRow() + 1, 1, barisIdx.length, 10).setValues(barisIdx);

    var hasil = {};
    hasil.barang = pindahBaris_(DB.SHEET.ITEMS, punyaTrx, arsipSS);
    hasil.sn = pindahBaris_(DB.SHEET.SN, punyaTrx, arsipSS);
    hasil.bayar = pindahBaris_(DB.SHEET.PAYMENTS, punyaTrx, arsipSS);
    hasil.riwayat = pindahBaris_(DB.SHEET.TIMELINE, punyaTrx, arsipSS);
    hasil.transaksi = pindahBaris_(DB.SHEET.TRX, punyaTrx, arsipSS);

    logAuditRaw_({
      actor_name: 'Sistem', actor_role: 'SYSTEM',
      entity: 'SETTING', entity_id: 'ARSIP_' + tanggal, action: 'UPDATE',
      new_value: hasil.transaksi + ' transaksi tanggal ' + tanggal + ' diarsipkan'
    });
    flushLog_();
    bersihkanCache();

    var sisaTanggal = perTanggal[tanggal].length - daftar.length;
    var tanggalLain = tanggalAda.length - 1;

    return kabar_('Arsip tanggal ' + tanggal + ' selesai.\n\n' +
      '  Transaksi      : ' + hasil.transaksi + '\n' +
      '  Barang         : ' + hasil.barang + '\n' +
      '  Serial number  : ' + hasil.sn + '\n' +
      '  Pembayaran     : ' + hasil.bayar + '\n' +
      '  Riwayat        : ' + hasil.riwayat + '\n\n' +
      'Berkas : ' + namaBerkas + '\n' +
      'Folder : ' + ARSIP_FOLDER + ' / ' + tanggal.substring(0, 4) +
        ' / ' + tanggal.substring(0, 7) + '\n\n' +
      'Semua transaksinya tercatat di sheet ' + ARSIP_INDEX +
      ', jadi mencarinya nanti tinggal lewat cariArsip().\n\n' +
      (sisaTanggal > 0
        ? 'Masih ada ' + sisaTanggal + ' transaksi tanggal ini. Jalankan lagi.\n' : '') +
      (tanggalLain > 0
        ? 'Masih ada ' + tanggalLain + ' tanggal lain. Jalankan lagi.\n' : '') +
      ((sisaTanggal <= 0 && tanggalLain <= 0) ? 'Semua sudah bersih.' : ''));

  } finally {
    try { lock.releaseLock(); } catch (e) {}
  }
}

/* Nama lama, supaya jadwal yang terlanjur dipasang tetap jalan */
function arsipBulanan() { return arsipHarian(); }
function arsipkanTransaksiLama() { return arsipHarian(); }

/** Memasang pengarsipan harian */
function pasangJadwalArsip() {
  ['arsipHarian', 'arsipBulanan', 'arsipkanTransaksiLama'].forEach(function (nm) {
    ScriptApp.getProjectTriggers().forEach(function (t) {
      if (t.getHandlerFunction() === nm) ScriptApp.deleteTrigger(t);
    });
  });

  ScriptApp.newTrigger('arsipHarian')
    .timeBased().atHour(1).everyDays(1).inTimezone('Asia/Jakarta').create();

  return kabar_('Pengarsipan dipasang tiap hari sekitar pukul 01.00.\n\n' +
    'Yang dipindah hanya transaksi yang sudah tuntas — selesai dan barangnya ' +
    'sudah diserahkan, atau dibatalkan. Yang masih berjalan tetap tinggal ' +
    'berapa lama pun umurnya.\n\n' +
    'Satu tanggal per jalan, maksimal ' + Settings.num('ARCHIVE_MAX_PER_RUN', 300) +
    ' transaksi. Kalau ada tunggakan, jalankan arsipHarian() beberapa kali.');
}

/** Mengubah pengaturan ke arsip harian — jalankan sekali */
function siapkanArsipHarian() {
  var row = Repo.findOne(DB.SHEET.SETTINGS, 'key', 'ARCHIVE_AFTER_DAYS');
  if (row) {
    Repo.update(DB.SHEET.SETTINGS, row._row, {
      value: '1', updated_at: nowIso_(), updated_by: 'SETUP',
      description: 'Transaksi tuntas diarsipkan setelah sekian hari. 1 = diarsipkan besoknya.'
    });
  }
  sheetIndexArsip_();
  Settings.bust();
  bersihkanCache();

  return kabar_('Pengaturan diubah ke arsip harian.\n\n' +
    'ARCHIVE_AFTER_DAYS sekarang 1 — transaksi yang tuntas hari ini diarsipkan ' +
    'besok dini hari.\n\n' +
    'Sheet ' + ARSIP_INDEX + ' sudah disiapkan untuk mencatat semua yang diarsipkan.\n\n' +
    'Lanjutkan dengan pasangJadwalArsip(), lalu jalankan arsipHarian() beberapa kali ' +
    'untuk membereskan tunggakan yang sudah ada.');
}

/** Mencari transaksi yang sudah diarsipkan */
function cariArsip() {
  Settings.bust();
  var row = Repo.findOne(DB.SHEET.SETTINGS, 'key', 'CARI_ARSIP');

  if (!row) {
    var sh0 = Repo.sheet(DB.SHEET.SETTINGS);
    sh0.getRange(sh0.getLastRow() + 1, 1, 1, 7).setValues([[
      'CARI_ARSIP', '', 'TEXT', 'SYSTEM',
      'Nomor transaksi, nama customer, atau nomor nota yang mau dicari di arsip.',
      nowIso_(), 'SETUP'
    ]]);
    Settings.bust();
    return kabar_('Baris CARI_ARSIP dibuat di sheet SETTINGS.\n\n' +
      'Isi kolom value dengan nomor transaksi, nama customer, atau nomor nota, ' +
      'lalu jalankan lagi.');
  }

  var q = String(row.value || '').trim().toUpperCase();
  if (!q) return kabar_('Baris CARI_ARSIP masih kosong.');

  var sh = SpreadsheetApp.getActive().getSheetByName(ARSIP_INDEX);
  if (!sh || sh.getLastRow() < 2) {
    return kabar_('Belum ada transaksi yang diarsipkan.');
  }

  var vals = sh.getRange(2, 1, sh.getLastRow() - 1, 10).getValues();
  var hasil = [];

  vals.forEach(function (r) {
    var bahan = [r[0], r[2], r[3], r[6]].join(' ').toUpperCase();
    if (bahan.indexOf(q) < 0) return;
    hasil.push('  ' + r[0] + ' · ' + r[1] + ' · ' + r[2] +
      '\n      ' + formatRp_(r[4]) + (r[6] ? ' · Nota ' + r[6] : '') +
      '\n      ' + r[7] + '\n      ' + r[8]);
  });

  if (!hasil.length) {
    return kabar_('Tidak ada yang cocok dengan "' + q + '" di arsip.\n\n' +
      'Kalau transaksinya baru, mungkin masih di sheet utama — belum diarsipkan.');
  }

  return kabar_(hasil.length + ' ditemukan di arsip:\n\n' + hasil.slice(0, 20).join('\n\n') +
    (hasil.length > 20 ? '\n\n(ditampilkan 20 teratas)' : '') +
    '\n\nBuka tautannya untuk melihat rincian lengkap beserta barang, SN, dan riwayatnya.');
}

/** Melihat apa saja yang akan diarsipkan, tanpa memindahkan apa pun */
function cekArsip() {
  var hari = Number(Settings.num('ARCHIVE_AFTER_DAYS', 1));
  var batas = new Date();
  batas.setDate(batas.getDate() - hari);
  var batasStr = Utilities.formatDate(batas, 'Asia/Jakarta', 'yyyy-MM-dd');

  var perTanggal = {}, total = 0, tinggal = 0, sebabTinggal = {};

  Repo.all(DB.SHEET.TRX).forEach(function (t) {
    total++;
    var tgl = Util.dateStr(t.trx_date);

    if (!sudahTuntas_(t)) {
      tinggal++;
      var k = stageLabel_(t.stage_status);
      sebabTinggal[k] = (sebabTinggal[k] || 0) + 1;
      return;
    }
    if (!tgl || tgl > batasStr) { tinggal++; return; }

    perTanggal[tgl] = (perTanggal[tgl] || 0) + 1;
  });

  var out = ['YANG AKAN DIARSIPKAN', ''];
  var tgl = Object.keys(perTanggal).sort();

  if (!tgl.length) out.push('  (tidak ada)');
  else tgl.forEach(function (d) { out.push('  ' + d + ' : ' + perTanggal[d] + ' transaksi'); });

  out.push('');
  out.push('Total transaksi di sheet : ' + total);
  out.push('Tetap tinggal            : ' + tinggal);

  var sebab = Object.keys(sebabTinggal).sort();
  if (sebab.length) {
    out.push('');
    out.push('YANG TINGGAL KARENA BELUM TUNTAS:');
    sebab.forEach(function (k) { out.push('  ' + k + ' : ' + sebabTinggal[k]); });
  }

  out.push('');
  out.push('Batas umur ' + hari + ' hari. Belum ada yang dipindahkan.');
  out.push('Jalankan arsipHarian() untuk memindahkan.');

  return kabar_(out.join('\n'));
}


// ============================================================
// PEMERIKSAAN KESEHATAN
// ============================================================

/**
 * Melihat ukuran tiap sheet dan memberi peringatan untuk yang mulai
 * membebani. Jalankan sebulan sekali.
 */
function cekBebanData() {
  var ss = SpreadsheetApp.getActive();
  var laporan = ['UKURAN DATA', ''];
  var total = 0;
  var berat = [];

  var panas = {
    'TRANSACTIONS': 3000, 'TRANSACTION_ITEMS': 12000,
    'NOTIFICATIONS': 1500, 'TRANSACTION_SN': 8000,
    'TRX_TIMELINE': 30000, 'AUDIT_LOG': 40000
  };

  Object.keys(DB.HEADERS).forEach(function (nama) {
    var sh = ss.getSheetByName(nama);
    if (!sh) return;
    var n = Math.max(sh.getLastRow() - 1, 0);
    total += n;

    var tanda = '';
    if (panas[nama] && n > panas[nama]) { tanda = '  ⚠️ mulai berat'; berat.push(nama); }
    laporan.push('  ' + nama + ': ' + n + ' baris' + tanda);
  });

  laporan.push('');
  laporan.push('Total: ' + total + ' baris');
  laporan.push('');

  if (berat.length) {
    laporan.push('YANG PERLU DITANGANI:');
    berat.forEach(function (b) {
      if (b === 'TRANSACTIONS') laporan.push('  • Jalankan arsipkanTransaksiLama()');
      else if (b === 'NOTIFICATIONS') laporan.push('  • Jalankan bersihkanNotifLama()');
      else laporan.push('  • ' + b + ' sudah besar — kabari saya untuk dipindah ke arsip');
    });
  } else {
    laporan.push('✅ Semua sheet masih dalam ukuran wajar.');
  }

  return kabar_(laporan.join('\n'));
}

// ============================================================
// PENGATURAN OPTIMASI
// ============================================================

function siapkanPengaturanOptimasi() {
  var sh = Repo.sheet(DB.SHEET.SETTINGS);
  var ada = {};
  Repo.columns(DB.SHEET.SETTINGS, ['key']).forEach(function (r) { ada[String(r.key).trim()] = true; });

  var now = nowIso_();
  var baru = [
    ['NOTIF_KEEP_HOURS', '24', 'NUMBER', 'SYSTEM',
     'Lama notifikasi disimpan sebelum dibuang (jam). Yang sudah dibaca dibuang lebih awal. Makin ramping sheet ini, makin murah seluruh sistem.'],
    ['PULSE_IDLE_SEC', '45', 'NUMBER', 'NOTIF',
     'Jeda pengecekan saat layar lama tidak disentuh (detik). Menghemat kuota untuk komputer yang ditinggal menyala.']
  ].filter(function (s) { return !ada[s[0]]; });

  if (baru.length) {
    sh.getRange(sh.getLastRow() + 1, 1, baru.length, 7).setValues(
      baru.map(function (s) { return [s[0], s[1], s[2], s[3], s[4], now, 'SETUP']; }));
  }
  Settings.bust();

  return kabar_((baru.length ? baru.length + ' pengaturan optimasi ditambahkan.' : 'Pengaturan sudah ada.') +
    '\n\nJadwal yang sebaiknya dipasang:\n' +
    '• pasangJadwalBersihNotif — tiap 6 jam\n' +
    '• pasangJadwalSync — sinkronisasi barang\n' +
    '• pasangJadwalTertahan — peringatan transaksi diam\n' +
    '• pasangJadwalBackup — backup harian\n\n' +
    'Lalu jalankan cekJadwalOtomatis() untuk memastikan semuanya terpasang.');
}

// ============================================================
// MENGOSONGKAN DATA UJI COBA
//
// Dipakai sekali sebelum sistem mulai dipakai sungguhan, untuk
// membuang seluruh transaksi percobaan.
//
// Dibuat dua langkah dengan sengaja. Fungsi yang bisa mengosongkan
// seluruh transaksi tidak boleh bisa terpicu hanya karena salah klik
// di daftar fungsi — dan daftar itu diurutkan menurut abjad, jadi
// salah pilih sangat mungkin terjadi.
// ============================================================

var KUNCI_RESET = 'ELS_IZIN_RESET';

/** Langkah 1 — memberi izin, berlaku 10 menit */
function izinkanReset() {
  var token = String(Date.now());
  PropertiesService.getScriptProperties().setProperty(KUNCI_RESET, token);

  var isi = ringkasIsiData_();

  return kabar_(
    'IZIN PENGOSONGAN DIBERIKAN — berlaku 10 menit\n\n' +
    'Yang AKAN DIHAPUS:\n' + isi.hapus.join('\n') + '\n\n' +
    'Yang TETAP AMAN:\n' + isi.aman.join('\n') + '\n\n' +
    'Backup dibuat otomatis sebelum data dihapus, masuk ke folder Drive ELS_BACKUP.\n\n' +
    'Kalau sudah yakin, jalankan salah satu:\n' +
    '  • resetDataTransaksi()            — transaksi saja, customer tetap ada\n' +
    '  • resetDataTransaksiDanCustomer() — termasuk data customer\n' +
    '  • resetSemuaMulaiDariNol()        — termasuk customer DAN akun divisi\n' +
    '                                      (akun Super Admin tetap aman)\n\n' +
    'Kalau berubah pikiran, jangan jalankan apa-apa. Izinnya hangus sendiri.');
}

function ringkasIsiData_() {
  var ss = SpreadsheetApp.getActive();
  var hitung = function (nama) {
    var sh = ss.getSheetByName(nama);
    return sh ? Math.max(sh.getLastRow() - 1, 0) : 0;
  };

  return {
    hapus: [
      '  • Transaksi           : ' + hitung(DB.SHEET.TRX) + ' baris',
      '  • Barang transaksi    : ' + hitung(DB.SHEET.ITEMS) + ' baris',
      '  • Serial number       : ' + hitung(DB.SHEET.SN) + ' baris',
      '  • Pembayaran          : ' + hitung(DB.SHEET.PAYMENTS) + ' baris',
      '  • Riwayat transaksi   : ' + hitung(DB.SHEET.TIMELINE) + ' baris',
      '  • Audit log           : ' + hitung(DB.SHEET.AUDIT) + ' baris',
      '  • Notifikasi          : ' + hitung(DB.SHEET.NOTIF) + ' baris',
      '  • Arsip transaksi     : ' + hitung(DB.SHEET.TRX_ARCHIVE) + ' baris',
      '  • Nomor urut transaksi kembali ke 1'
    ],
    aman: [
      '  • Akun user           : ' + hitung(DB.SHEET.USERS) + ' akun',
      '  • Daftar sales        : ' + hitung(DB.SHEET.SALES) + ' orang',
      '  • Master barang       : ' + hitung(DB.SHEET.PRODUCTS) + ' barang',
      '  • Pengaturan          : ' + hitung(DB.SHEET.SETTINGS) + ' baris',
      '  • Data customer       : ' + hitung(DB.SHEET.CUSTOMERS) + ' orang'
    ],
    hitung: hitung
  };
}

function periksaIzinReset_() {
  var props = PropertiesService.getScriptProperties();
  var token = props.getProperty(KUNCI_RESET);
  if (!token) {
    throw new Error('Belum ada izin. Jalankan izinkanReset() dulu, baca daftarnya, ' +
      'baru jalankan fungsi ini lagi.');
  }
  var lewat = (Date.now() - Number(token)) / 60000;
  props.deleteProperty(KUNCI_RESET);        // izin sekali pakai
  if (lewat > 10) {
    throw new Error('Izinnya sudah lewat 10 menit. Jalankan izinkanReset() lagi.');
  }
}

function kosongkanSheet_(nama) {
  var sh = SpreadsheetApp.getActive().getSheetByName(nama);
  if (!sh) return 0;
  var n = Math.max(sh.getLastRow() - 1, 0);
  if (n > 0) sh.getRange(2, 1, n, sh.getLastColumn()).clearContent();
  try { Repo.bustSheet(nama); } catch (e) {}
  return n;
}

function jalankanReset_(termasukCustomer) {
  periksaIzinReset_();

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) {
    return kabar_('Ada proses lain sedang berjalan. Coba lagi sebentar.');
  }

  try {
    // Backup dulu. Kalau ternyata salah pilih, datanya masih bisa diambil.
    var namaBackup = '(gagal dibuat)';
    try {
      var ss = SpreadsheetApp.getActive();
      var stamp = Utilities.formatDate(new Date(), 'Asia/Jakarta', 'yyyy-MM-dd_HHmm');
      namaBackup = 'SEBELUM_RESET_' + ss.getName() + '_' + stamp;
      DriveApp.getFileById(ss.getId()).makeCopy(namaBackup, getOrCreateFolder_('ELS_BACKUP'));
    } catch (e) {
      return kabar_('Pengosongan DIBATALKAN karena backup gagal dibuat.\n\n' +
        e.message + '\n\nData tidak disentuh sama sekali. ' +
        'Perbaiki dulu masalah backupnya, baru ulangi.');
    }

    var daftar = [
      DB.SHEET.TRX, DB.SHEET.ITEMS, DB.SHEET.SN, DB.SHEET.PAYMENTS,
      DB.SHEET.TIMELINE, DB.SHEET.AUDIT, DB.SHEET.NOTIF, DB.SHEET.TRX_ARCHIVE
    ];
    if (termasukCustomer) daftar.push(DB.SHEET.CUSTOMERS);

    var hasil = [];
    daftar.forEach(function (nama) {
      hasil.push('  • ' + nama + ': ' + kosongkanSheet_(nama) + ' baris dihapus');
    });

    // Nomor urut kembali ke awal
    try {
      var shC = Repo.sheet(DB.SHEET.COUNTERS);
      var nC = Math.max(shC.getLastRow() - 1, 0);
      if (nC > 0) shC.getRange(2, 1, nC, shC.getLastColumn()).clearContent();
      Repo.bustSheet(DB.SHEET.COUNTERS);
      hasil.push('  • Nomor urut transaksi kembali ke 1');
    } catch (e) {}

    // Sesi login dikosongkan supaya semua orang login ulang dengan data bersih
    try { kosongkanSheet_(DB.SHEET.SESSIONS); } catch (e) {}

    try { bersihkanCache(); } catch (e) {}
    try {
      ['GUDANG', 'ADMIN', 'KASIR', 'TEKNISI', 'SALES', 'SUPERADMIN']
        .forEach(function (r) { bumpPulse_(r); });
    } catch (e) {}

    return kabar_(
      '✅ DATA SUDAH DIKOSONGKAN\n\n' +
      hasil.join('\n') + '\n\n' +
      'Backup tersimpan di folder Drive ELS_BACKUP:\n  ' + namaBackup + '\n\n' +
      'Yang tetap ada: akun user, daftar sales, master barang, pengaturan' +
      (termasukCustomer ? '.' : ', dan data customer.') + '\n\n' +
      'Semua orang perlu login ulang. Sistem siap dipakai dari nol.');

  } finally {
    try { lock.releaseLock(); } catch (e) {}
  }
}

/** Langkah 2 — transaksi dikosongkan, data customer tetap ada */
function resetDataTransaksi() {
  return jalankanReset_(false);
}

/** Langkah 2 — transaksi dan data customer dikosongkan sekaligus */
function resetDataTransaksiDanCustomer() {
  return jalankanReset_(true);
}

/** Melihat isi data sekarang tanpa menghapus apa pun */
function lihatIsiData() {
  var isi = ringkasIsiData_();
  return kabar_('ISI DATA SEKARANG\n\n' +
    'Data transaksi:\n' + isi.hapus.slice(0, 8).join('\n') + '\n\n' +
    'Data tetap:\n' + isi.aman.join('\n') + '\n\n' +
    'Untuk mengosongkan data transaksi, jalankan izinkanReset() dulu.');
}

// ============================================================
// MULAI DARI NOL
//
// Dipakai sekali, saat sistem hendak diserahkan ke staf untuk
// pertama kalinya. Seluruh jejak percobaan dibuang supaya yang
// tersisa benar-benar bersih.
//
// Akun Super Admin sengaja dipertahankan. Tanpa itu tidak ada
// seorang pun yang bisa masuk untuk membuat akun divisi lagi,
// dan sistemnya jadi terkunci dari luar.
// ============================================================

function resetSemuaMulaiDariNol() {
  periksaIzinReset_();

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) {
    return kabar_('Ada proses lain sedang berjalan. Coba lagi sebentar.');
  }

  try {
    // Pastikan masih ada Super Admin yang bisa masuk setelahnya
    var semua = Repo.all(DB.SHEET.USERS);
    var superAdmin = semua.filter(function (u) {
      return String(u.role) === 'SUPERADMIN' && String(u.status) === 'ACTIVE';
    });

    if (!superAdmin.length) {
      return kabar_('DIBATALKAN. Tidak ada akun Super Admin yang aktif.\n\n' +
        'Kalau seluruh akun dihapus sekarang, tidak ada seorang pun yang bisa masuk ' +
        'untuk membuat akun baru — sistemnya terkunci dari luar.\n\n' +
        'Buat Super Admin dulu lewat menu ELS Setup di spreadsheet.');
    }

    // Backup dulu
    var namaBackup;
    try {
      var ss = SpreadsheetApp.getActive();
      var stamp = Utilities.formatDate(new Date(), 'Asia/Jakarta', 'yyyy-MM-dd_HHmm');
      namaBackup = 'SEBELUM_RESET_' + ss.getName() + '_' + stamp;
      DriveApp.getFileById(ss.getId()).makeCopy(namaBackup, getOrCreateFolder_('ELS_BACKUP'));
    } catch (e) {
      return kabar_('Pengosongan DIBATALKAN karena backup gagal dibuat.\n\n' + e.message +
        '\n\nData tidak disentuh sama sekali.');
    }

    var hasil = [];

    // 1. Seluruh data transaksi dan customer
    [DB.SHEET.TRX, DB.SHEET.ITEMS, DB.SHEET.SN, DB.SHEET.PAYMENTS,
     DB.SHEET.TIMELINE, DB.SHEET.AUDIT, DB.SHEET.NOTIF, DB.SHEET.TRX_ARCHIVE,
     DB.SHEET.CUSTOMERS, DB.SHEET.SESSIONS, DB.SHEET.SYNC_LOG
    ].forEach(function (nama) {
      var n = kosongkanSheet_(nama);
      if (n) hasil.push('  • ' + nama + ': ' + n + ' baris dihapus');
    });

    // 2. Nomor urut kembali ke awal
    try {
      var shC = Repo.sheet(DB.SHEET.COUNTERS);
      var nC = Math.max(shC.getLastRow() - 1, 0);
      if (nC > 0) shC.getRange(2, 1, nC, shC.getLastColumn()).clearContent();
      Repo.bustSheet(DB.SHEET.COUNTERS);
      hasil.push('  • Nomor urut transaksi kembali ke 1');
    } catch (e) {}

    // 3. Akun divisi dibuang, Super Admin ditulis ulang apa adanya
    var shU = Repo.sheet(DB.SHEET.USERS);
    var headU = Repo.headers(DB.SHEET.USERS);
    var dibuang = semua.length - superAdmin.length;

    var nU = Math.max(shU.getLastRow() - 1, 0);
    if (nU > 0) shU.getRange(2, 1, nU, headU.length).clearContent();

    var barisSA = superAdmin.map(function (u) {
      return headU.map(function (k) { return u[k] === undefined ? '' : u[k]; });
    });
    shU.getRange(2, 1, barisSA.length, headU.length).setValues(barisSA);
    Repo.bustSheet(DB.SHEET.USERS);

    hasil.push('  • Akun divisi: ' + dibuang + ' akun dihapus');
    hasil.push('  • Akun Super Admin: ' + superAdmin.length + ' tetap aman');

    try { bersihkanCache(); } catch (e) {}
    try {
      ['GUDANG', 'ADMIN', 'KASIR', 'TEKNISI', 'SALES', 'SUPERADMIN']
        .forEach(function (r) { bumpPulse_(r); });
    } catch (e) {}

    return kabar_(
      '✅ SISTEM SUDAH KEMBALI KE NOL\n\n' +
      hasil.join('\n') + '\n\n' +
      'MASIH ADA:\n' +
      '  • Akun Super Admin: ' +
        superAdmin.map(function (u) { return u.username; }).join(', ') + '\n' +
      '  • Daftar sales    : ' + Math.max(Repo.sheet(DB.SHEET.SALES).getLastRow() - 1, 0) + ' orang\n' +
      '  • Master barang   : ' + Math.max(Repo.sheet(DB.SHEET.PRODUCTS).getLastRow() - 1, 0) + ' barang\n' +
      '  • Seluruh pengaturan, termasuk kalibrasi cetak\n\n' +
      'Backup tersimpan di folder Drive ELS_BACKUP:\n  ' + namaBackup + '\n\n' +
      'LANGKAH BERIKUTNYA:\n' +
      '  1. Login pakai akun Super Admin\n' +
      '  2. Buat akun tiap divisi lewat menu Kelola User\n' +
      '  3. Periksa daftar sales, sesuaikan dengan orang yang bertugas\n' +
      '  4. Bagikan PIN ke staf masing-masing');

  } finally {
    try { lock.releaseLock(); } catch (e) {}
  }
}

// ============================================================
// FUNGSI MANA YANG LAMBAT
// ============================================================

/**
 * Menampilkan lama pemrosesan tiap fungsi hari ini, diurutkan dari
 * yang paling memakan waktu.
 *
 * Jalankan setelah beberapa jam dipakai. Kolom "rata" menunjukkan
 * fungsi mana yang perlu diperbaiki; kolom "total" menunjukkan mana
 * yang paling membebani kuota.
 */
function cekLambat() {
  var c = CacheService.getScriptCache();
  var hari = Utilities.formatDate(new Date(), 'Asia/Jakarta', 'yyyyMMdd');

  var data = {};
  try { data = JSON.parse(c.get('ELS_PERF_' + hari) || '{}'); } catch (e) {}

  var baris = Object.keys(data).map(function (f) {
    var d = data[f];
    return { nama: f, n: d.n, rata: Math.round(d.ms / d.n), total: d.ms, max: d.max };
  });

  if (!baris.length) {
    return kabar_('Belum ada data hari ini.\n\n' +
      'Angka mulai terkumpul setelah aplikasi dipakai. Pastikan juga berkas JsCore ' +
      'versi terbaru sudah dipasang dan sudah di-deploy.');
  }

  baris.sort(function (a, b) { return b.rata - a.rata; });

  var pad = function (t, n) {
    t = String(t);
    while (t.length < n) t += ' ';
    return t;
  };
  var padKiri = function (t, n) {
    t = String(t);
    while (t.length < n) t = ' ' + t;
    return t;
  };

  var out = ['FUNGSI PALING LAMBAT HARI INI', '',
             pad('Fungsi', 26) + padKiri('Dipakai', 8) + padKiri('Rata', 8) +
             padKiri('Terlama', 9) + padKiri('Total', 9), ''];

  baris.slice(0, 25).forEach(function (b) {
    out.push(pad(b.nama, 26) + padKiri(b.n + 'x', 8) +
      padKiri((b.rata / 1000).toFixed(1) + 's', 8) +
      padKiri((b.max / 1000).toFixed(1) + 's', 9) +
      padKiri(Math.round(b.total / 1000) + 's', 9));
  });

  var lambat = baris.filter(function (b) { return b.rata > 3000; });
  out.push('');
  out.push(lambat.length
    ? '⚠️ Yang rata-ratanya di atas 3 detik: ' +
      lambat.map(function (b) { return b.nama; }).join(', ') +
      '\n\nKirim daftar ini ke Zul supaya bisa diperbaiki tepat sasaran.'
    : '✅ Semua fungsi rata-rata di bawah 3 detik.');

  return kabar_(out.join('\n'));
}

/** Menghapus catatan pengukuran hari ini, untuk memulai pengukuran bersih */
function resetPengukuran() {
  var c = CacheService.getScriptCache();
  var hari = Utilities.formatDate(new Date(), 'Asia/Jakarta', 'yyyyMMdd');
  c.remove('ELS_PERF_' + hari);
  c.remove('ELS_USE_MS_' + hari);
  c.remove('ELS_USE_N_' + hari);
  return kabar_('Catatan pengukuran hari ini dihapus. Pengukuran dimulai dari nol.');
}

// ============================================================
// MEMERIKSA ANGKA BADGE
// ============================================================

/**
 * Menampilkan angka pekerjaan yang dihitung server untuk tiap divisi,
 * beserta rincian status transaksinya.
 *
 * Kalau angka di layar tidak cocok dengan angka di sini, berarti
 * masalahnya di layar. Kalau angka di sini sendiri yang salah, berarti
 * ada transaksi yang statusnya tidak seperti dugaan — dan daftarnya
 * ikut tercetak di bawah.
 */
function cekBadge() {
  var today = Util.todayStr();
  var rows = Repo.columns(DB.SHEET.TRX, [
    'trx_id', 'trx_no', 'branch', 'stage_status', 'payment_status',
    'nota_no', 'activation_done_at', 'override_flags', 'is_void'
  ]);

  var per = {}, rincian = [];
  var gudang = 0, nota = 0, bayar = 0, aktivasi = 0, ambil = 0;

  rows.forEach(function (t) {
    if (Util.isTrue(t.is_void)) return;
    var st = String(t.stage_status);
    per[st] = (per[st] || 0) + 1;

    var masuk = '';
    if (st === 'MENUNGGU_GUDANG' || st === 'PROSES_GUDANG') { gudang++; masuk = 'GUDANG'; }
    else if (st === 'SIAP_NOTA') { nota++; masuk = 'ADMIN'; }
    else if (st === 'MENUNGGU_PEMBAYARAN') { bayar++; masuk = 'KASIR'; }
    else if (st === 'MENUNGGU_AKTIVASI' || st === 'PROSES_AKTIVASI') { aktivasi++; masuk = 'TEKNISI'; }
    else if ((st === 'SELESAI' || st === 'AKTIVASI_SELESAI') &&
             Util.dateStr(t.activation_done_at) === today) {
      var f = {};
      try { f = JSON.parse(String(t.override_flags || '') || '{}'); } catch (e) {}
      if (!(f.diserahkan && f.diserahkan.at)) { ambil++; masuk = 'TEKNISI (menunggu diambil)'; }
    }

    if (st !== 'MENUNGGU_PEMBAYARAN' && String(t.nota_no || '').trim() &&
        String(t.payment_status) === 'DP') { bayar++; masuk = 'KASIR (DP belum lunas)'; }

    if (masuk) {
      rincian.push('  ' + String(t.trx_no) + ' · ' + st + ' · ' +
        String(t.payment_status) + ' → ' + masuk);
    }
  });

  var out = ['ANGKA PEKERJAAN MENURUT SERVER', '',
    '  GUDANG  (Antrian Pesanan)   : ' + gudang,
    '  ADMIN   (Resep & Nota)      : ' + nota,
    '  KASIR   (Pembayaran)        : ' + bayar,
    '  TEKNISI (Antrian Aktivasi)  : ' + (aktivasi + ambil) +
      '   (' + aktivasi + ' aktivasi + ' + ambil + ' menunggu diambil)',
    '',
    'TRANSAKSI YANG DIHITUNG:'];

  out = out.concat(rincian.length ? rincian : ['  (tidak ada)']);

  out.push('');
  out.push('SEMUA STATUS YANG ADA:');
  Object.keys(per).sort().forEach(function (k) {
    out.push('  ' + k + ': ' + per[k]);
  });

  out.push('');
  out.push('Kalau angka di layar berbeda dari angka di atas, berkas Page_Notif ' +
    'atau 12_NotifyService belum ikut terpasang.');

  return kabar_(out.join('\n'));
}

// ============================================================
// MEMBERSIHKAN DRAFT KOSONG YANG TERLUPAKAN
// ============================================================

/**
 * Menghapus draft yang nol item dan sudah lewat sehari.
 *
 * Draft kosong biasanya sisa salah klik atau pesanan yang batal
 * sebelum barangnya dipilih. Tidak ada isinya, jadi tidak ada yang
 * bisa hilang — tapi kalau dibiarkan, daftar pesanan penuh baris
 * kosong dan yang benar-benar perlu ditangani jadi tenggelam.
 *
 * Draft yang SUDAH ADA barangnya tidak pernah disentuh fungsi ini.
 */
function bersihkanDraftKosong() {
  /*
   * Diukur dalam jam, bukan hari.
   *
   * Draft kosong biasanya salah klik yang disadari dalam hitungan menit.
   * Menunggunya sampai besok membuat daftar pesanan penuh seharian —
   * justru pada saat paling ramai dan paling perlu dibaca cepat.
   */
  var jamLalu = Number(Settings.num('DRAFT_KOSONG_JAM', 3));
  var batas = new Date().getTime() - jamLalu * 3600000;

  var punyaItem = {};
  Repo.columns(DB.SHEET.ITEMS, ['item_id', 'trx_id', 'is_active']).forEach(function (i) {
    if (Util.isTrue(i.is_active)) punyaItem[String(i.trx_id)] = true;
  });

  var sh = Repo.sheet(DB.SHEET.TRX);
  var rows = Repo.all(DB.SHEET.TRX);
  var buang = [], daftar = [];

  rows.forEach(function (t) {
    if (String(t.stage_status) !== 'DRAFT') return;
    if (Util.isTrue(t.is_void)) return;
    if (punyaItem[String(t.trx_id)]) return;

    var dibuat = new Date(Util.isoStr(t.created_at)).getTime();
    if (isNaN(dibuat) || dibuat > batas) return;

    buang.push(t._row);
    daftar.push('  ' + String(t.trx_no) + ' · ' + Util.dateStr(t.created_at) +
      ' · ' + String(t.updated_by_name || ''));
  });

  if (!buang.length) {
    return kabar_('Tidak ada draft kosong yang perlu dibersihkan.\n\n' +
      'Yang dibersihkan hanya draft nol item yang dibuat lebih dari ' +
      jamLalu + ' jam lalu.\n\n' +
      'Kalau ada draft kosong yang baru dibuat, tunggu dulu — atau turunkan ' +
      'DRAFT_KOSONG_JAM di sheet SETTINGS.');
  }

  buang.sort(function (a, b) { return b - a; });
  for (var i = 0; i < buang.length; i++) sh.deleteRow(buang[i]);

  Repo.bustSheet(DB.SHEET.TRX);
  logAuditRaw_({
    actor_name: 'Sistem', actor_role: 'SYSTEM',
    entity: 'TRX', entity_id: 'DRAFT_KOSONG', action: 'DELETE',
    new_value: buang.length + ' draft kosong dihapus'
  });
  flushLog_();

  return kabar_(buang.length + ' draft kosong dihapus:\n\n' + daftar.join('\n') +
    '\n\nDraft yang sudah berisi barang tidak disentuh.');
}

function pasangJadwalBersihDraft() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'bersihkanDraftKosong') ScriptApp.deleteTrigger(t);
  });
  // Tiap jam, bukan sekali sehari — supaya daftar pesanan tetap bersih
  // sepanjang jam kerja, bukan baru rapi besok pagi.
  ScriptApp.newTrigger('bersihkanDraftKosong')
    .timeBased().everyHours(1).create();

  return kabar_('Pembersihan draft kosong dipasang setiap jam.\n\n' +
    'Yang dihapus hanya draft nol item yang dibuat lebih dari ' +
    Settings.num('DRAFT_KOSONG_JAM', 3) + ' jam lalu. Draft yang sudah berisi ' +
    'barang tidak pernah disentuh.\n\n' +
    'Lamanya bisa diubah lewat DRAFT_KOSONG_JAM di sheet SETTINGS.');
}

/**
 * Menghapus SEMUA draft kosong sekarang juga, tanpa menunggu batas jam.
 * Dipakai sekali untuk membersihkan sisa uji coba.
 */
function bersihkanDraftKosongSekarang() {
  var punyaItem = {};
  Repo.columns(DB.SHEET.ITEMS, ['item_id', 'trx_id', 'is_active']).forEach(function (i) {
    if (Util.isTrue(i.is_active)) punyaItem[String(i.trx_id)] = true;
  });

  var sh = Repo.sheet(DB.SHEET.TRX);
  var rows = Repo.all(DB.SHEET.TRX);
  var buang = [], daftar = [];

  rows.forEach(function (t) {
    if (String(t.stage_status) !== 'DRAFT') return;
    if (Util.isTrue(t.is_void)) return;
    if (punyaItem[String(t.trx_id)]) return;
    buang.push(t._row);
    daftar.push('  ' + String(t.trx_no));
  });

  if (!buang.length) return kabar_('Tidak ada draft kosong sama sekali.');

  buang.sort(function (a, b) { return b - a; });
  for (var i = 0; i < buang.length; i++) sh.deleteRow(buang[i]);
  Repo.bustSheet(DB.SHEET.TRX);

  return kabar_(buang.length + ' draft kosong dihapus:\n\n' + daftar.join('\n') +
    '\n\nDraft yang sudah berisi barang tidak disentuh.');
}

// ============================================================
// MEMBERSIHKAN SN YANG SALAH DIISI
// ============================================================

/**
 * Menghapus serial number yang salah diketik.
 *
 * TIDAK memakai kotak isian, karena kotak isian menggantung kalau
 * spreadsheetnya sedang tidak terbuka. Nomornya diketik di sheet
 * SETTINGS, baris SN_HAPUS.
 *
 * Cara pakai:
 *   1. Buka sheet SETTINGS di ELS_OPS_DB
 *   2. Cari baris SN_HAPUS, isi kolom value: 10, 11, 12, 13
 *   3. Jalankan fungsi ini
 *
 * Barisnya dihapus betulan dari database. SN yang tidak pernah ada di
 * barangnya bukan riwayat yang perlu disimpan — dan selama tersimpan,
 * angka itu akan menolak barang lain yang kebetulan punya SN sama.
 */
function hapusSnSalah() {
  Settings.bust();
  var row = Repo.findOne(DB.SHEET.SETTINGS, 'key', 'SN_HAPUS');

  if (!row) {
    var sh0 = Repo.sheet(DB.SHEET.SETTINGS);
    sh0.getRange(sh0.getLastRow() + 1, 1, 1, 7).setValues([[
      'SN_HAPUS', '', 'TEXT', 'SYSTEM',
      'Daftar serial number yang mau dihapus, dipisah koma. Diisi sementara, lalu jalankan hapusSnSalah(). Dikosongkan sendiri setelah selesai.',
      nowIso_(), 'SETUP'
    ]]);
    Settings.bust();
    return kabar_('Baris SN_HAPUS baru saja dibuat di sheet SETTINGS.\n\n' +
      'Buka sheet SETTINGS, cari baris SN_HAPUS, isi kolom value dengan ' +
      'nomor SN yang mau dihapus — dipisah koma.\n\n' +
      'Contoh:  10, 11, 12, 13\n\n' +
      'Setelah itu jalankan fungsi ini lagi.');
  }

  var daftarTeks = String(row.value || '').trim();
  if (!daftarTeks) {
    return kabar_('Baris SN_HAPUS masih kosong.\n\n' +
      'Buka sheet SETTINGS, isi kolom value pada baris SN_HAPUS dengan nomor SN ' +
      'yang mau dihapus, dipisah koma.\n\nContoh:  10, 11, 12, 13');
  }

  var cari = {};
  daftarTeks.split(',').forEach(function (x) {
    var v = String(x).trim().toUpperCase();
    if (v) cari[v] = true;
  });

  if (!Object.keys(cari).length) return kabar_('Isi SN_HAPUS tidak terbaca.');

  var sh = Repo.sheet(DB.SHEET.SN);
  var rows = Repo.all(DB.SHEET.SN);
  var buang = [], daftar = [];

  rows.forEach(function (r) {
    var sn = String(r.serial_number || '').trim().toUpperCase();
    if (!sn || !cari[sn]) return;
    buang.push(r._row);
    daftar.push('  ' + sn + '  ·  ' + String(r.trx_no || '') + '  ·  ' +
      String(r.product_code || ''));
  });

  if (!buang.length) {
    return kabar_('Tidak ada SN yang cocok.\n\n' +
      'Yang dicari: ' + Object.keys(cari).join(', ') + '\n\n' +
      'Pastikan ditulis persis seperti yang tersimpan di sheet TRANSACTION_SN.');
  }

  buang.sort(function (a, b) { return b - a; });
  for (var i = 0; i < buang.length; i++) sh.deleteRow(buang[i]);

  // Dikosongkan supaya tidak terjalan dua kali tanpa sengaja
  Repo.update(DB.SHEET.SETTINGS, row._row, {
    value: '', updated_at: nowIso_(), updated_by: 'hapusSnSalah'
  });

  Repo.bustSheet(DB.SHEET.SN);
  bustSnHistCache_();
  bersihkanCache();

  logAuditRaw_({
    actor_name: 'Sistem', actor_role: 'SYSTEM',
    entity: 'SN', entity_id: Object.keys(cari).join(','), action: 'DELETE',
    new_value: buang.length + ' SN salah ketik dihapus'
  });
  flushLog_();

  return kabar_(buang.length + ' serial number dihapus dari database:\n\n' +
    daftar.join('\n') + '\n\n' +
    'Baris SN_HAPUS sudah dikosongkan kembali.\n\n' +
    'Barangnya juga tidak akan ditandai perlu SN lagi.');
}

/**
 * Menghapus semua serial number milik satu transaksi.
 *
 * Nomor transaksinya diketik di sheet SETTINGS, baris SN_HAPUS_TRX.
 */
function hapusSnTransaksi() {
  Settings.bust();
  var row = Repo.findOne(DB.SHEET.SETTINGS, 'key', 'SN_HAPUS_TRX');

  if (!row) {
    var sh0 = Repo.sheet(DB.SHEET.SETTINGS);
    sh0.getRange(sh0.getLastRow() + 1, 1, 1, 7).setValues([[
      'SN_HAPUS_TRX', '', 'TEXT', 'SYSTEM',
      'Nomor transaksi yang seluruh SN-nya mau dihapus. Diisi sementara, lalu jalankan hapusSnTransaksi().',
      nowIso_(), 'SETUP'
    ]]);
    Settings.bust();
    return kabar_('Baris SN_HAPUS_TRX baru saja dibuat di sheet SETTINGS.\n\n' +
      'Isi kolom value dengan nomor transaksinya, contoh: TRX-20260919-004\n\n' +
      'Setelah itu jalankan fungsi ini lagi.');
  }

  var no = String(row.value || '').trim().toUpperCase();
  if (!no) {
    return kabar_('Baris SN_HAPUS_TRX masih kosong.\n\n' +
      'Isi kolom value dengan nomor transaksinya, contoh: TRX-20260919-004');
  }

  var sh = Repo.sheet(DB.SHEET.SN);
  var rows = Repo.all(DB.SHEET.SN);
  var buang = [], daftar = [];

  rows.forEach(function (r) {
    if (String(r.trx_no || '').trim().toUpperCase() !== no) return;
    buang.push(r._row);
    daftar.push('  ' + String(r.serial_number) + '  ·  ' + String(r.product_code || ''));
  });

  if (!buang.length) return kabar_('Tidak ada SN tersimpan untuk ' + no + '.');

  buang.sort(function (a, b) { return b - a; });
  for (var i = 0; i < buang.length; i++) sh.deleteRow(buang[i]);

  Repo.update(DB.SHEET.SETTINGS, row._row, {
    value: '', updated_at: nowIso_(), updated_by: 'hapusSnTransaksi'
  });

  Repo.bustSheet(DB.SHEET.SN);
  bustSnHistCache_();
  bersihkanCache();

  return kabar_(buang.length + ' SN milik ' + no + ' dihapus:\n\n' + daftar.join('\n') +
    '\n\nBaris SN_HAPUS_TRX sudah dikosongkan kembali.');
}

/** Melihat SN apa saja yang tersimpan untuk satu kode barang atau satu SN */
function lihatSn() {
  Settings.bust();
  var cari = String(Settings.get('SN_HAPUS', '')).trim().toUpperCase();
  if (!cari) {
    return kabar_('Isi dulu SN_HAPUS di sheet SETTINGS dengan SN atau kode barang ' +
      'yang mau dilihat.\n\nFungsi ini hanya melihat, tidak menghapus apa pun.');
  }

  var hasil = [];
  Repo.all(DB.SHEET.SN).forEach(function (r) {
    var sn = String(r.serial_number || '').toUpperCase();
    var kode = String(r.product_code || '').toUpperCase();
    if (sn.indexOf(cari) < 0 && kode.indexOf(cari) < 0) return;
    hasil.push('  ' + String(r.serial_number) + '  ·  ' + String(r.trx_no || '') +
      '  ·  ' + String(r.product_code || '') +
      (Util.isTrue(r.is_active) ? '' : '  (sudah nonaktif)'));
  });

  return kabar_(hasil.length
    ? hasil.length + ' baris ditemukan untuk "' + cari + '":\n\n' + hasil.join('\n') +
      '\n\nUntuk menghapusnya, jalankan hapusSnSalah().'
    : 'Tidak ada SN yang cocok dengan "' + cari + '".');
}

// ============================================================
// MEMERIKSA KELENGKAPAN KOLOM
// ============================================================

/**
 * Memeriksa apakah semua kolom tambahan sudah terpasang di sheet.
 *
 * Penyimpanan mengabaikan kolom yang tidak dikenal tanpa berkata
 * apa-apa — jadi fitur baru bisa terlihat berhasil di layar padahal
 * datanya tidak pernah tersimpan. Fungsi ini menemukan hal seperti itu
 * sebelum staf yang menemukannya.
 */
function cekKolom() {
  var perlu = [
    [DB.SHEET.TRX, 'nota_indent', 'siapkanNotaIndent'],
    [DB.SHEET.TRX, 'nota_indent_at', 'siapkanNotaIndent'],
    [DB.SHEET.TRX, 'nota_indent_by', 'siapkanNotaIndent'],
    [DB.SHEET.TRX, 'indent_note', 'siapkanIndent'],
    [DB.SHEET.TRX, 'sales_code', 'siapkanDaftarSales'],
    [DB.SHEET.TRX, 'sales_type', 'siapkanDaftarSales'],
    [DB.SHEET.TRX, 'gudang_petugas', 'siapkanDaftarGudang'],
    [DB.SHEET.TRX, 'gudang_petugas_nama', 'siapkanDaftarGudang'],
    [DB.SHEET.ITEMS, 'base_price', 'siapkanHargaDasar'],
    [DB.SHEET.PRODUCTS, 'stock_other', 'siapkanKolomStokCabang']
  ];

  var kurang = [], ada = 0;

  perlu.forEach(function (x) {
    var head = [];
    try { head = Repo.headers(x[0]); } catch (e) {}
    if (head.indexOf(x[1]) < 0) kurang.push('  ' + x[0] + '.' + x[1] + '   → jalankan ' + x[2] + '()');
    else ada++;
  });

  // Tahap MENUNGGU_BARANG di STATUS_MASTER
  var adaTahap = false;
  try {
    var shS = Repo.sheet(DB.SHEET.STATUS);
    if (shS.getLastRow() >= 1 && shS.getLastColumn() >= 1) {
      Repo.columns(DB.SHEET.STATUS, ['status_code']).forEach(function (r) {
        if (String(r.status_code) === 'MENUNGGU_BARANG') adaTahap = true;
      });
    }
  } catch (e) {}
  if (!adaTahap) kurang.push('  STATUS_MASTER.MENUNGGU_BARANG   → jalankan siapkanIndent()');

  if (!kurang.length) {
    return kabar_('Semua kolom tambahan sudah terpasang (' + ada + ' diperiksa).\n\n' +
      'Kalau ada fitur yang datanya tidak tersimpan, penyebabnya bukan kolom.');
  }

  return kabar_('ADA ' + kurang.length + ' YANG BELUM TERPASANG:\n\n' + kurang.join('\n') +
    '\n\nSelama kolomnya belum ada, penyimpanan untuk bagian itu diabaikan diam-diam — ' +
    'terlihat berhasil di layar tapi tidak tersimpan.\n\n' +
    'Jalankan fungsi yang disebut di atas, lalu bersihkanCache().');
}

// ============================================================
// MEMERIKSA BARANG YANG TIDAK KETEMU
// ============================================================

/**
 * Mencari barang langsung dari sheet, tanpa lewat salinan sementara.
 *
 * Kalau barang ada di sheet tapi tidak muncul saat dicari di aplikasi,
 * fungsi ini memisahkan dua kemungkinan: salinannya yang basi, atau
 * barisnya memang tidak memenuhi syarat untuk ditampilkan.
 *
 * Cara pakai: isi baris CARI_BARANG di sheet SETTINGS dengan kode atau
 * sebagian nama barangnya, lalu jalankan.
 */
function cekBarang() {
  Settings.bust();
  var row = Repo.findOne(DB.SHEET.SETTINGS, 'key', 'CARI_BARANG');

  if (!row) {
    var sh0 = Repo.sheet(DB.SHEET.SETTINGS);
    sh0.getRange(sh0.getLastRow() + 1, 1, 1, 7).setValues([[
      'CARI_BARANG', '', 'TEXT', 'SYSTEM',
      'Kode atau sebagian nama barang yang mau diperiksa lewat cekBarang(). Diisi sementara.',
      nowIso_(), 'SETUP'
    ]]);
    Settings.bust();
    return kabar_('Baris CARI_BARANG dibuat di sheet SETTINGS.\n\n' +
      'Isi kolom value dengan kode atau sebagian nama barangnya, lalu jalankan lagi.');
  }

  var cari = String(row.value || '').trim().toLowerCase();
  if (!cari) return kabar_('Baris CARI_BARANG masih kosong. Isi dulu di sheet SETTINGS.');

  var sh = Repo.sheet(DB.SHEET.PRODUCTS);
  var lr = sh.getLastRow(), lc = sh.getLastColumn();
  if (lr < 2) return kabar_('Sheet PRODUCTS_LOCAL kosong.');

  var head = sh.getRange(1, 1, 1, lc).getValues()[0]
               .map(function (v) { return String(v).trim(); });
  var iKode = head.indexOf('product_code');
  var iNama = head.indexOf('product_name');
  var iAktif = head.indexOf('is_active');
  var iCari = head.indexOf('search_key');
  var iStok = head.indexOf('stock');
  var iHarga = head.indexOf('price');

  var vals = sh.getRange(2, 1, lr - 1, lc).getValues();
  var hasil = [], terlewat = [];

  for (var i = 0; i < vals.length; i++) {
    var r = vals[i];
    var kode = String(iKode >= 0 ? r[iKode] : '').trim();
    var nama = String(iNama >= 0 ? r[iNama] : '').trim();
    if ((kode + ' ' + nama).toLowerCase().indexOf(cari) < 0) continue;

    var aktif = iAktif >= 0 ? r[iAktif] : '';
    var lolos = true, sebab = [];

    if (!kode) { lolos = false; sebab.push('kode kosong'); }
    if (String(aktif) !== '' && !Util.isTrue(aktif)) { lolos = false; sebab.push('is_active = ' + aktif); }

    // Baris pertama sheet ikut menentukan: baris dengan kolom pertama
    // kosong dilewati saat pembacaan
    if (String(r[0]).trim() === '') { lolos = false; sebab.push('kolom pertama (' + head[0] + ') kosong'); }

    var baris = '  baris ' + (i + 2) + ' · ' + kode + ' · ' + nama +
      (iStok >= 0 ? ' · stok ' + r[iStok] : '') +
      (iHarga >= 0 ? ' · ' + r[iHarga] : '');

    if (lolos) hasil.push(baris);
    else terlewat.push(baris + '\n      TIDAK TERBACA: ' + sebab.join(', '));
  }

  var out = ['HASIL PENCARIAN "' + cari + '" LANGSUNG DARI SHEET', ''];

  out.push('Terbaca sistem: ' + hasil.length);
  if (hasil.length) out = out.concat(hasil.slice(0, 30));

  if (terlewat.length) {
    out.push('');
    out.push('DILEWATI SISTEM: ' + terlewat.length);
    out = out.concat(terlewat.slice(0, 30));
  }

  if (!hasil.length && !terlewat.length) {
    out.push('  (tidak ada yang cocok — periksa ejaannya)');
  }

  // Bandingkan dengan yang ada di salinan
  var diIndeks = 0;
  try {
    getProductIndex_().forEach(function (p) {
      if ((String(p.k) + ' ' + String(p.n)).toLowerCase().indexOf(cari) >= 0) diIndeks++;
    });
  } catch (e) {}

  out.push('');
  out.push('Di salinan sementara: ' + diIndeks);
  if (diIndeks < hasil.length) {
    out.push('');
    out.push('Salinannya tertinggal. Jalankan bersihkanCache() lalu coba cari lagi di aplikasi.');
  }

  return kabar_(out.join('\n'));
}

// ============================================================
// MEMERIKSA TRANSAKSI YANG TERSANGKUT
//
// Yang dicari: transaksi yang tahapnya tidak cocok dengan keadaan
// sebenarnya. Contoh paling sering — sudah lunas tapi masih berdiri
// di antrian Kasir, jadi Teknisi tidak pernah melihatnya.
//
// Penyebabnya bisa penyimpanan yang terputus di tengah, atau urutan
// yang tidak terduga di lapangan. Yang penting bisa ditemukan dan
// dibetulkan tanpa menunggu ada yang mengeluh.
// ============================================================

function cekAlur() {
  var rows = Repo.all(DB.SHEET.TRX);
  var masalah = [];

  rows.forEach(function (t) {
    if (Util.isTrue(t.is_void)) return;

    var tahap = String(t.stage_status);
    var bayar = String(t.payment_status);
    var nota = String(t.nota_no || '').trim();
    var notaSo = String(t.nota_indent || '').trim();
    var sebab = null, usul = null;

    if (tahap === 'MENUNGGU_PEMBAYARAN' && bayar === 'LUNAS') {
      sebab = 'sudah lunas tapi masih di antrian Kasir';
      usul = 'MENUNGGU_AKTIVASI';
    } else if (tahap === 'SIAP_NOTA' && nota) {
      sebab = 'nota ' + nota + ' sudah ada tapi masih di antrian Admin';
      usul = bayar === 'LUNAS' ? 'MENUNGGU_AKTIVASI' : 'MENUNGGU_PEMBAYARAN';
    } else if (tahap === 'MENUNGGU_AKTIVASI' && bayar !== 'LUNAS' && bayar !== 'DP') {
      sebab = 'di antrian Teknisi tapi belum ada pembayaran sama sekali';
      usul = nota ? 'MENUNGGU_PEMBAYARAN' : 'SIAP_NOTA';
    } else if (tahap === 'MENUNGGU_BARANG' && !notaSo && bayar === 'LUNAS') {
      sebab = 'indent sudah lunas tapi nota pesanannya belum ada';
      usul = null;
    }

    if (!sebab) return;

    masalah.push({
      row: t._row, trx_no: String(t.trx_no), nama: String(t.cust_name_snap),
      tahap: tahap, bayar: bayar, sebab: sebab, usul: usul
    });
  });

  if (!masalah.length) {
    return kabar_('Tidak ada transaksi yang tersangkut.\n\n' +
      rows.length + ' transaksi diperiksa, semuanya tahapnya cocok dengan keadaannya.');
  }

  var out = ['ADA ' + masalah.length + ' TRANSAKSI TERSANGKUT', ''];
  masalah.forEach(function (m) {
    out.push('  ' + m.trx_no + ' · ' + m.nama);
    out.push('      ' + stageLabel_(m.tahap) + ' · ' + m.bayar);
    out.push('      ' + m.sebab);
    out.push('      seharusnya: ' + (m.usul ? stageLabel_(m.usul) : 'perlu diperiksa manual'));
    out.push('');
  });

  out.push('Jalankan perbaikiAlur() untuk membetulkan yang ada usulannya.');
  out.push('Perbaikan dicatat di riwayat, jadi jejaknya tetap ada.');

  return kabar_(out.join('\n'));
}

/** Membetulkan tahap transaksi yang tersangkut */
function perbaikiAlur() {
  var rows = Repo.all(DB.SHEET.TRX);
  var diperbaiki = [];

  rows.forEach(function (t) {
    if (Util.isTrue(t.is_void)) return;

    var tahap = String(t.stage_status);
    var bayar = String(t.payment_status);
    var nota = String(t.nota_no || '').trim();
    var usul = null;

    if (tahap === 'MENUNGGU_PEMBAYARAN' && bayar === 'LUNAS') {
      usul = 'MENUNGGU_AKTIVASI';
    } else if (tahap === 'SIAP_NOTA' && nota) {
      usul = bayar === 'LUNAS' ? 'MENUNGGU_AKTIVASI' : 'MENUNGGU_PEMBAYARAN';
    }

    if (!usul || usul === tahap) return;

    Repo.update(DB.SHEET.TRX, t._row, {
      stage_status: usul,
      updated_at: nowIso_(),
      updated_by_name: 'Sistem (perbaikan alur)'
    });

    logAuditRaw_({
      actor_name: 'Sistem', actor_role: 'SYSTEM',
      entity: 'TRX', entity_id: String(t.trx_id), trx_no: String(t.trx_no),
      action: 'STAGE_CHANGE', field: 'stage_status',
      old_value: tahap, new_value: usul,
      reason: 'Tahap tidak cocok dengan keadaan pembayaran atau notanya'
    });

    // Divisi tujuan diberi tahu, supaya tidak perlu menunggu lagi
    var peran = usul === 'MENUNGGU_AKTIVASI' ? 'TEKNISI'
              : (usul === 'MENUNGGU_PEMBAYARAN' ? 'KASIR' : 'ADMIN');
    pushNotif_({
      target_role: peran, target_branch: String(t.branch),
      trx_id: String(t.trx_id), trx_no: String(t.trx_no),
      type: 'ORDER_READY', priority: 'HIGH',
      title: 'Transaksi masuk antrian Anda',
      body: String(t.trx_no) + ' · ' + String(t.cust_name_snap) +
            ' · sempat tersangkut, sudah dibetulkan'
    });

    diperbaiki.push('  ' + String(t.trx_no) + ' · ' + String(t.cust_name_snap) +
      '\n      ' + stageLabel_(tahap) + '  →  ' + stageLabel_(usul));
  });

  flushLog_();
  bersihkanCache();

  if (!diperbaiki.length) {
    return kabar_('Tidak ada yang perlu dibetulkan.');
  }

  return kabar_(diperbaiki.length + ' transaksi dibetulkan:\n\n' +
    diperbaiki.join('\n') + '\n\n' +
    'Divisi tujuan sudah diberi tahu. Perbaikan tercatat di Riwayat Perubahan.');
}

/** Memasang pemeriksaan alur otomatis tiap 15 menit */
function pasangJadwalAlur() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'perbaikiAlur') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('perbaikiAlur').timeBased().everyMinutes(15).create();

  return kabar_('Pemeriksaan alur dipasang tiap 15 menit.\n\n' +
    'Transaksi yang tahapnya tidak cocok dengan keadaan pembayaran atau notanya ' +
    'akan dibetulkan sendiri, dan divisi tujuannya diberi tahu.\n\n' +
    'Ini jaring pengaman, bukan pengganti perbaikan penyebabnya. Kalau sering ' +
    'ada yang tersangkut, laporkan supaya sebabnya dicari.');
}

/**
 * Menampilkan lama tiap langkah di dalam fungsi yang diukur.
 *
 * Total sembilan detik tidak memberi tahu apa pun tentang di mana
 * sembilan detik itu habis. Ini yang memberi tahu.
 */
function cekLangkah() {
  var c = CacheService.getScriptCache();
  var hari = Utilities.formatDate(new Date(), 'Asia/Jakarta', 'yyyyMMdd');
  var fungsi = [
    'apiConfirmSales', 'apiCreateDraft',                     // Sales
    'apiConfirmWarehouse', 'apiStartPrepare',                // Gudang
    'apiSaveNota', 'apiPrintResep',                          // Admin
    'apiAddPayment',                                         // Kasir
    'apiStartActivation', 'apiDoneActivation', 'apiTandaiDiserahkan'  // Teknisi
  ];

  var out = ['LAMA TIAP LANGKAH HARI INI', ''];
  var adaIsi = false;

  fungsi.forEach(function (nm) {
    var teks = c.get('ELS_STEP_' + hari + '_' + nm);
    if (!teks) return;

    var data = {};
    try { data = JSON.parse(teks); } catch (e) { return; }

    var total = data._total || { n: 0, ms: 0 };
    if (!total.n) return;
    adaIsi = true;

    out.push(nm + '   (' + total.n + 'x, rata ' + (total.ms / total.n / 1000).toFixed(1) + 's)');

    Object.keys(data).forEach(function (k) {
      if (k === '_total') return;
      var d = data[k];
      var rata = d.ms / d.n / 1000;
      var persen = total.ms ? Math.round(d.ms / total.ms * 100) : 0;
      out.push('    ' + (rata.toFixed(1) + 's').padStart(7) +
        '  (' + String(persen).padStart(2) + '%)  ' + k);
    });

    var terukur = 0;
    Object.keys(data).forEach(function (k) { if (k !== '_total') terukur += data[k].ms; });
    var sisa = (total.ms - terukur) / total.n / 1000;
    out.push('    ' + (sisa.toFixed(1) + 's').padStart(7) + '         sisanya (izin, catat, kirim)');
    out.push('');
  });

  if (!adaIsi) {
    return kabar_('Belum ada data langkah hari ini.\n\n' +
      'Kerjakan beberapa transaksi dulu, lalu jalankan lagi.');
  }

  out.push('Angka ini yang menentukan apa yang perlu diperbaiki berikutnya.');
  return kabar_(out.join('\n'));
}
// ============================================================
// MEMBERESKAN PERMINTAAN GANTI YANG MENGGANTUNG
//
// Teknisi kadang lupa menandai unit pengganti diterima, lalu langsung
// menyerahkan barangnya. Permintaannya berdiri terus di daftar Gudang
// seolah masih ada pekerjaan, padahal barangnya sudah di tangan
// customer berhari-hari lalu.
// ============================================================

function cekGantiGantung() {
  var sekarang = new Date().getTime();
  var hasil = [];

  Repo.all(DB.SHEET.TRX).forEach(function (t) {
    if (String(t.override_flags || '').indexOf('"ganti"') < 0) return;

    var f = {};
    try { f = JSON.parse(String(t.override_flags || '') || '{}'); } catch (e) { return; }
    if (!f.ganti || !f.ganti.length) return;

    var diserahkan = !!(f.diserahkan && f.diserahkan.at);

    f.ganti.forEach(function (g) {
      if (['SELESAI', 'BATAL'].indexOf(String(g.status)) >= 0) return;

      var menit = 0;
      if (g.minta_at) {
        menit = Math.max(Math.round((sekarang - new Date(g.minta_at).getTime()) / 60000), 0);
      }

      hasil.push({
        trx_no: String(t.trx_no), nama: String(t.cust_name_snap),
        barang: String(g.product_name), unit: g.unit_seq,
        status: String(g.status), menit: menit,
        diserahkan: diserahkan
      });
    });
  });

  if (!hasil.length) {
    return kabar_('Tidak ada permintaan ganti yang menggantung.');
  }

  hasil.sort(function (a, b) { return b.menit - a.menit; });

  var out = ['PERMINTAAN GANTI YANG BELUM DITUTUP', ''];
  var bisaOtomatis = 0;

  hasil.forEach(function (h) {
    var jam = Math.floor(h.menit / 60);
    out.push('  ' + h.trx_no + ' · ' + h.nama);
    out.push('      ' + h.barang + ' unit ' + h.unit + ' · ' + labelStatusGanti_(h.status));
    out.push('      menggantung ' + (jam >= 24 ? Math.floor(jam / 24) + ' hari' : jam + ' jam') +
      (h.diserahkan ? '  ← BARANG SUDAH DISERAHKAN, aman ditutup' : ''));
    out.push('');
    if (h.diserahkan) bisaOtomatis++;
  });

  out.push(bisaOtomatis
    ? bisaOtomatis + ' di antaranya barangnya sudah diserahkan ke customer. ' +
      'Jalankan tutupGantiGantung() untuk menutupnya.'
    : 'Belum ada yang barangnya sudah diserahkan. Biarkan dulu, mungkin memang ' +
      'masih dikerjakan.');

  return kabar_(out.join('\n'));
}

/**
 * Menutup permintaan ganti pada transaksi yang barangnya SUDAH
 * diserahkan ke customer.
 *
 * Syarat itu yang menjaga supaya tidak ada yang tertutup keliru:
 * kalau barangnya sudah keluar, tidak mungkin masih ada unit
 * pengganti yang ditunggu.
 */
function tutupGantiGantung() {
  var ditutup = [];

  Repo.all(DB.SHEET.TRX).forEach(function (t) {
    if (String(t.override_flags || '').indexOf('"ganti"') < 0) return;

    var f = {};
    try { f = JSON.parse(String(t.override_flags || '') || '{}'); } catch (e) { return; }
    if (!f.ganti || !f.ganti.length) return;

    // Hanya yang barangnya sudah diserahkan
    if (!(f.diserahkan && f.diserahkan.at)) return;

    var berubah = false;
    f.ganti.forEach(function (g, i) {
      if (['SELESAI', 'BATAL'].indexOf(String(g.status)) >= 0) return;
      f.ganti[i].status = 'SELESAI';
      f.ganti[i].selesai_by = 'Sistem';
      f.ganti[i].selesai_at = nowIso_();
      f.ganti[i].catatan_tutup = 'Ditutup sistem — barang sudah diserahkan ke customer';
      berubah = true;
      ditutup.push('  ' + String(t.trx_no) + ' · ' + String(g.product_name) +
        ' unit ' + g.unit_seq);
    });

    if (!berubah) return;

    Repo.update(DB.SHEET.TRX, t._row, { override_flags: JSON.stringify(f) });

    logAuditRaw_({
      actor_name: 'Sistem', actor_role: 'SYSTEM',
      entity: 'TRX', entity_id: String(t.trx_id), trx_no: String(t.trx_no),
      action: 'UPDATE', field: 'ganti_unit',
      old_value: 'menggantung', new_value: 'ditutup',
      reason: 'Barang sudah diserahkan ke customer'
    });
  });

  flushLog_();
  bersihkanCache();

  if (!ditutup.length) {
    return kabar_('Tidak ada yang perlu ditutup.\n\n' +
      'Yang ditutup hanya permintaan pada transaksi yang barangnya sudah ' +
      'diserahkan ke customer. Jalankan cekGantiGantung() untuk melihat ' +
      'apa saja yang masih terbuka.');
  }

  return kabar_(ditutup.length + ' permintaan ganti ditutup:\n\n' + ditutup.join('\n') +
    '\n\nSemuanya pada transaksi yang barangnya sudah diserahkan. ' +
    'Tercatat di Riwayat Perubahan.');
}

/**
 * Menyiapkan pengaturan akses Sales ke rincian transaksi.
 *
 * Bawaannya FALSE — rincian ditutup begitu transaksi masuk Kasir.
 * Ubah nilainya di sheet SETTINGS atau lewat menu Pengaturan kalau
 * suatu saat perlu dibuka lagi.
 */
function siapkanAksesSales() {
  var row = Repo.findOne(DB.SHEET.SETTINGS, 'key', 'SALES_LIHAT_SETELAH_KASIR');

  if (row) {
    Settings.bust();
    return kabar_('Pengaturan sudah ada.\n\n' +
      'SALES_LIHAT_SETELAH_KASIR = ' + String(row.value) + '\n\n' +
      'FALSE = rincian ditutup setelah masuk Kasir\n' +
      'TRUE  = Sales bisa membuka sampai selesai');
  }

  var sh = Repo.sheet(DB.SHEET.SETTINGS);
  sh.getRange(sh.getLastRow() + 1, 1, 1, 7).setValues([[
    'SALES_LIHAT_SETELAH_KASIR', 'FALSE', 'TEXT', 'AKSES',
    'TRUE = Sales bisa membuka rincian transaksi sampai selesai. FALSE = ditutup begitu masuk Kasir. Menjaga agar promotor brand tidak melihat penjualan brand lain.',
    nowIso_(), 'SETUP'
  ]]);

  Settings.bust();
  bersihkanCache();

  return kabar_('Pengaturan SALES_LIHAT_SETELAH_KASIR dibuat, nilainya FALSE.\n\n' +
    'Mulai sekarang Sales tidak bisa membuka rincian transaksi yang sudah masuk ' +
    'Kasir, Teknisi, atau selesai. Daftarnya tetap terlihat, tapi tombol Buka ' +
    'diganti tanda gembok.\n\n' +
    'Untuk membukanya kembali, ubah nilainya jadi TRUE lewat menu Pengaturan ' +
    '(hanya Super Admin), lalu jalankan bersihkanCache().');
}

// ============================================================
// MEMERIKSA NOMOR TRANSAKSI KEMBAR
//
// Pernah terjadi dua transaksi berbeda mendapat nomor yang sama,
// karena pemeriksaannya memakai salinan sementara yang belum
// memuat baris yang baru ditulis.
//
// Penyebabnya sudah dibetulkan, tapi yang terlanjur kembar perlu
// ditemukan — nomor ganda merembet ke nota, pembayaran, dan laporan.
// ============================================================

function cekNomorKembar() {
  var rows = Repo.columns(DB.SHEET.TRX, [
    'trx_id', 'trx_no', 'trx_date', 'cust_name_snap', 'stage_status',
    'payment_status', 'grand_total', 'nota_no', 'is_void'
  ]);

  var per = {};
  rows.forEach(function (t) {
    var no = String(t.trx_no || '').trim();
    if (!no) return;
    if (!per[no]) per[no] = [];
    per[no].push(t);
  });

  var kembar = Object.keys(per).filter(function (k) { return per[k].length > 1; }).sort();

  if (!kembar.length) {
    return kabar_('Tidak ada nomor transaksi kembar.\n\n' +
      rows.length + ' transaksi diperiksa.');
  }

  var out = ['ADA ' + kembar.length + ' NOMOR YANG DIPAKAI LEBIH DARI SEKALI', ''];

  kembar.forEach(function (no) {
    out.push('  ' + no);
    per[no].forEach(function (t) {
      out.push('      ' + String(t.trx_id) + ' · ' + String(t.cust_name_snap) +
        ' · ' + stageLabel_(t.stage_status) + ' · ' + String(t.payment_status) +
        ' · ' + formatRp_(t.grand_total) +
        (Util.isTrue(t.is_void) ? '  [DIBATALKAN]' : '') +
        (t.nota_no ? '  Nota ' + String(t.nota_no) : ''));
    });
    out.push('');
  });

  out.push('Yang bertanda DIBATALKAN aman dibiarkan — sudah tidak muncul di mana pun.');
  out.push('Kalau ada dua yang sama-sama hidup, batalkan salah satunya lewat menu Admin,');
  out.push('lalu jalankan nomorUlangKembar() untuk memberi nomor baru pada yang tersisa.');

  return kabar_(out.join('\n'));
}

/**
 * Memberi nomor baru pada transaksi yang nomornya kembar.
 *
 * Yang dibiarkan memakai nomor lama: yang paling dulu dibuat.
 * Yang lain diberi nomor berikutnya yang masih kosong. Transaksi
 * yang sudah dibatalkan tidak disentuh — nomornya tidak mengganggu
 * siapa pun karena tidak muncul di daftar mana pun.
 */
function nomorUlangKembar() {
  var rows = Repo.all(DB.SHEET.TRX);

  var per = {};
  rows.forEach(function (t) {
    var no = String(t.trx_no || '').trim();
    if (!no) return;
    if (!per[no]) per[no] = [];
    per[no].push(t);
  });

  var terpakai = {};
  Object.keys(per).forEach(function (no) { terpakai[no] = true; });

  var diubah = [];

  Object.keys(per).forEach(function (no) {
    var daftar = per[no];
    if (daftar.length < 2) return;

    // Yang hidup dan paling dulu dibuat tetap memakai nomornya
    daftar.sort(function (a, b) {
      var av = Util.isTrue(a.is_void) ? 1 : 0, bv = Util.isTrue(b.is_void) ? 1 : 0;
      if (av !== bv) return av - bv;
      return String(a.created_at) < String(b.created_at) ? -1 : 1;
    });

    for (var i = 1; i < daftar.length; i++) {
      var t = daftar[i];
      if (Util.isTrue(t.is_void)) continue;      // yang batal dibiarkan

      var dasar = no.replace(/-(\d+)$/, '');
      var urut = Number((no.match(/-(\d+)$/) || [])[1] || 0);
      var baru = '';

      for (var n = urut + 1; n < urut + 500; n++) {
        var calon = dasar + '-' + Util.pad(n, 3);
        if (!terpakai[calon]) { baru = calon; break; }
      }
      if (!baru) continue;

      terpakai[baru] = true;
      Repo.update(DB.SHEET.TRX, t._row, { trx_no: baru, updated_at: nowIso_() });

      // Barang, SN, pembayaran, dan riwayatnya ikut diperbarui
      ['ITEMS', 'SN', 'PAYMENTS', 'TIMELINE'].forEach(function (k) {
        try {
          var baris = Repo.findManyFast(DB.SHEET[k], 'trx_id', t.trx_id)
                          .map(function (r) { return r._row; });
          Repo.setKolom(DB.SHEET[k], baris, 'trx_no', baru);
        } catch (e) {}
      });

      logAuditRaw_({
        actor_name: 'Sistem', actor_role: 'SYSTEM',
        entity: 'TRX', entity_id: String(t.trx_id), trx_no: baru,
        action: 'UPDATE', field: 'trx_no',
        old_value: no, new_value: baru,
        reason: 'Nomor kembar, diberi nomor baru'
      });

      diubah.push('  ' + no + '  →  ' + baru + '   (' + String(t.cust_name_snap) + ')');
    }
  });

  flushLog_();
  bersihkanCache();

  if (!diubah.length) {
    return kabar_('Tidak ada yang perlu dinomori ulang.\n\n' +
      'Jalankan cekNomorKembar() untuk melihat keadaannya.');
  }

  return kabar_(diubah.length + ' transaksi diberi nomor baru:\n\n' + diubah.join('\n') +
    '\n\nNomor lama tetap dipegang transaksi yang lebih dulu dibuat. ' +
    'Kalau notanya sudah tercetak dengan nomor lama, betulkan juga di sistem kantor.');
}

// ============================================================
// MELEPAS SERIAL NUMBER PADA TRANSAKSI YANG DIBATALKAN
//
// Pembatalan lewat menu Admin sudah otomatis melepas SN-nya.
// Pembatalan manual di sheet tidak — barisnya diubah, tapi SN-nya
// tetap tercatat aktif.
//
// Akibatnya unit itu dianggap sudah keluar gudang, dan SN-nya
// ditolak saat barangnya benar-benar dijual. Baru ketahuan berhari
// -hari kemudian, saat Gudang menembak dan sistem menolak.
// ============================================================

function cekSnBatal() {
  var batal = {};
  Repo.columns(DB.SHEET.TRX, ['trx_id', 'trx_no', 'stage_status', 'is_void'])
    .forEach(function (t) {
      if (Util.isTrue(t.is_void) || String(t.stage_status) === 'DIBATALKAN') {
        batal[String(t.trx_id)] = String(t.trx_no);
      }
    });

  var nyangkut = [];
  Repo.columns(DB.SHEET.SN, ['sn_id', 'trx_id', 'serial_number', 'is_active'])
    .forEach(function (r) {
      if (!Util.isTrue(r.is_active)) return;
      if (!batal[String(r.trx_id)]) return;
      nyangkut.push({
        sn: String(r.serial_number), trx_no: batal[String(r.trx_id)], row: r._row
      });
    });

  if (!nyangkut.length) {
    return kabar_('Tidak ada serial number yang tersangkut.\n\n' +
      'Semua SN pada transaksi yang dibatalkan sudah dilepas.');
  }

  var out = [nyangkut.length + ' SERIAL NUMBER MASIH TERKUNCI', '',
    'Transaksinya sudah dibatalkan, tapi SN-nya masih tercatat aktif —',
    'jadi akan DITOLAK kalau barangnya dijual lagi.', ''];

  nyangkut.slice(0, 40).forEach(function (x) {
    out.push('  ' + x.sn + '   (' + x.trx_no + ')');
  });
  if (nyangkut.length > 40) out.push('  … dan ' + (nyangkut.length - 40) + ' lagi');

  out.push('');
  out.push('Jalankan lepasSnBatal() untuk melepas semuanya.');

  return kabar_(out.join('\n'));
}

/** Melepas semua SN pada transaksi yang sudah dibatalkan */
function lepasSnBatal() {
  var batal = {};
  Repo.columns(DB.SHEET.TRX, ['trx_id', 'trx_no', 'stage_status', 'is_void'])
    .forEach(function (t) {
      if (Util.isTrue(t.is_void) || String(t.stage_status) === 'DIBATALKAN') {
        batal[String(t.trx_id)] = String(t.trx_no);
      }
    });

  var baris = [], daftar = [];
  Repo.columns(DB.SHEET.SN, ['sn_id', 'trx_id', 'serial_number', 'is_active'])
    .forEach(function (r) {
      if (!Util.isTrue(r.is_active)) return;
      if (!batal[String(r.trx_id)]) return;
      baris.push(r._row);
      daftar.push('  ' + String(r.serial_number) + '   (' + batal[String(r.trx_id)] + ')');
    });

  if (!baris.length) return kabar_('Tidak ada yang perlu dilepas.');

  Repo.setKolom(DB.SHEET.SN, baris, 'is_active', false);
  Repo.setKolom(DB.SHEET.SN, baris, 'replaced_reason',
    'Dilepas — transaksinya dibatalkan');

  logAuditRaw_({
    actor_name: 'Sistem', actor_role: 'SYSTEM',
    entity: 'SN', entity_id: 'MASSAL', action: 'VOID',
    old_value: baris.length + ' SN aktif', new_value: '(dilepas)',
    reason: 'Transaksinya sudah dibatalkan'
  });
  flushLog_();
  bersihkanCache();

  return kabar_(baris.length + ' serial number dilepas:\n\n' +
    daftar.slice(0, 40).join('\n') +
    (daftar.length > 40 ? '\n  … dan ' + (daftar.length - 40) + ' lagi' : '') +
    '\n\nSemuanya sekarang bisa ditembak lagi di transaksi baru.');
}

// ============================================================
// MENYIAPKAN LAPORAN TEKNISI
//
// Membuat sheet daftar teknisi dan catatan pekerjaan manual, lalu
// menambah kolom nama pengerja di sheet transaksi.
//
// Jalankan sekali setelah deploy.
// ============================================================

/*
 * Dipecah jadi langkah-langkah kecil.
 *
 * Sekali jalan untuk semuanya sempat gagal dengan "Service
 * Spreadsheets timed out" — Google menyerah saat spreadsheet sedang
 * dipakai ramai dan satu perintah menunggu terlalu lama.
 *
 * Dengan dipecah, yang gagal tinggal diulang bagiannya saja, dan
 * yang sudah jadi tidak dikerjakan dua kali.
 */

function siapkanSheetTeknisi() {
  var ss = SpreadsheetApp.getActive();
  var pesan = [];

  [DB.SHEET.TEKNISI, DB.SHEET.TECH_WORK].forEach(function (nama) {
    if (ss.getSheetByName(nama)) { pesan.push('✓ Sheet ' + nama + ' sudah ada.'); return; }

    var sh = ss.insertSheet(nama);
    var h = DB.HEADERS[nama];
    sh.getRange(1, 1, 1, h.length).setValues([h])
      .setFontWeight('bold').setBackground('#f1f3f4');
    sh.setFrozenRows(1);
    SpreadsheetApp.flush();
    pesan.push('✓ Sheet ' + nama + ' dibuat.');
  });

  Repo.clearHeaderCache();
  return kabar_(pesan.join('\n') + '\n\nLanjut: siapkanKolomTeknisi()');
}

function siapkanKolomTeknisi() {
  var sh = Repo.sheet(DB.SHEET.TRX);
  var lc = sh.getLastColumn();
  var head = sh.getRange(1, 1, 1, lc).getValues()[0]
               .map(function (v) { return String(v).trim(); });

  var pesan = [];
  ['tech_petugas', 'tech_petugas_nama'].forEach(function (kol) {
    if (head.indexOf(kol) >= 0) { pesan.push('✓ Kolom ' + kol + ' sudah ada.'); return; }
    lc++;
    sh.getRange(1, lc).setValue(kol).setFontWeight('bold').setBackground('#f1f3f4');
    head.push(kol);
    pesan.push('✓ Kolom ' + kol + ' ditambahkan.');
  });

  SpreadsheetApp.flush();
  Repo.clearHeaderCache();
  bersihkanCache();

  return kabar_(pesan.join('\n') + '\n\nLanjut: siapkanPengaturanTeknisi()');
}

function siapkanPengaturanTeknisi() {
  var sh = Repo.sheet(DB.SHEET.SETTINGS);
  var pesan = [];

  [['KATEGORI_TEKNISI',
    'McAfee=MCAFEE|Screen=SCREEN,ANTIGORES|Skin Laptop=SKIN|Office Profesional=OFFICE,OFC',
    'Kategori yang dihitung otomatis dari barang di pesanan. Bentuknya Nama=kata1,kata2 dipisah tanda |.'],
   ['JENIS_KERJA_MANUAL',
    'Upgrade RAM,Upgrade SSD,Rakit PC,Inkcharging,Bundling Office Pro 2021,' +
    'Pasang Screen,Pasang SKIN,Aktivasi Laptop,Onsite Service',
    'Pilihan pekerjaan yang dicatat manual Teknisi, dipisah koma.']
  ].forEach(function (x) {
    if (Repo.findOne(DB.SHEET.SETTINGS, 'key', x[0])) {
      pesan.push('✓ Pengaturan ' + x[0] + ' sudah ada.');
      return;
    }
    sh.getRange(sh.getLastRow() + 1, 1, 1, 7).setValues([[
      x[0], x[1], 'TEXT', 'TEKNISI', x[2], nowIso_(), 'SETUP'
    ]]);
    pesan.push('✓ Pengaturan ' + x[0] + ' dibuat.');
  });

  SpreadsheetApp.flush();
  Settings.bust();
  bersihkanCache();

  return kabar_(pesan.join('\n') + '\n\nSemua siap.\n\n' +
    'Langkah berikutnya:\n' +
    '1. Isi sheet TEKNISI_LIST dengan nama tiap teknisi\n' +
    '   (tech_code bebas misal TK-ALVIAN, tech_name, branch PWT_KOTA, is_active TRUE)\n' +
    '2. Minta Teknisi memilih namanya saat menekan Mulai aktivasi\n' +
    '3. Laporannya ada di menu Laporan Teknisi\n\n' +
    'Kalau ada teknisi yang belum terdaftar, jalankan isiTeknisiContoh() ' +
    'untuk mengisi delapan nama sekaligus lalu betulkan di sheetnya.');
}

/** Menjalankan ketiganya berurutan, berhenti di bagian yang gagal */
function siapkanLaporanTeknisi() {
  var hasil = [];

  try { siapkanSheetTeknisi(); hasil.push('Sheet: berhasil'); }
  catch (e) {
    return kabar_('Berhenti di pembuatan sheet: ' + e.message +
      '\n\nCoba lagi saat toko sepi, atau jalankan siapkanSheetTeknisi() sendiri.');
  }

  try { siapkanKolomTeknisi(); hasil.push('Kolom: berhasil'); }
  catch (e) {
    return kabar_(hasil.join('\n') + '\nBerhenti di penambahan kolom: ' + e.message +
      '\n\nJalankan siapkanKolomTeknisi() sendiri untuk melanjutkan.');
  }

  try { siapkanPengaturanTeknisi(); hasil.push('Pengaturan: berhasil'); }
  catch (e) {
    return kabar_(hasil.join('\n') + '\nBerhenti di pengaturan: ' + e.message +
      '\n\nJalankan siapkanPengaturanTeknisi() sendiri untuk melanjutkan.');
  }

  return kabar_(hasil.join('\n') + '\n\nSemua siap. Isi sheet TEKNISI_LIST ' +
    'dengan nama tiap teknisi, atau jalankan isiTeknisiContoh().');
}

/** Mengisi daftar teknisi sekaligus, tinggal dibetulkan di sheetnya */
function isiTeknisiContoh() {
  var nama = ['Alvian', 'Difa', 'Ifan', 'Renaldi', 'Saeful', 'Sarif', 'Tofik', 'Dion'];
  var sh = Repo.sheet(DB.SHEET.TEKNISI);

  var sudah = {};
  Repo.columns(DB.SHEET.TEKNISI, ['tech_name']).forEach(function (r) {
    sudah[String(r.tech_name).trim().toUpperCase()] = true;
  });

  var now = nowIso_();
  var baris = [];

  nama.forEach(function (n) {
    if (sudah[n.toUpperCase()]) return;
    baris.push([
      'TK-' + n.toUpperCase(), n, 'PWT_KOTA', '', '', true,
      now, 'SETUP', now, 'SETUP'
    ]);
  });

  if (!baris.length) return kabar_('Semua nama sudah ada di daftar.');

  sh.getRange(sh.getLastRow() + 1, 1, baris.length, 10).setValues(baris);
  bustTeknisiCache_();

  return kabar_(baris.length + ' teknisi ditambahkan:\n\n  ' +
    baris.map(function (b) { return b[1]; }).join('\n  ') +
    '\n\nBetulkan namanya langsung di sheet TEKNISI_LIST kalau ada yang keliru, ' +
    'lalu jalankan bersihkanCache().');
}

// ============================================================
// MENYIAPKAN DIVISI ONLINE
//
// Pesanan online masuk lewat Sales Online, lalu disiapkan Tim
// Eksekusi — bukan Gudang. Pekerjaannya sama persis, jadi yang
// ditambahkan bukan tahapan baru, melainkan penyaring antrian dan
// beberapa keterangan khusus online.
//
// Jalankan sekali setelah deploy.
// ============================================================

function siapkanOnline() {
  var pesan = [];

  // 1. Sheet daftar PIC eksekusi
  var ss = SpreadsheetApp.getActive();
  if (ss.getSheetByName(DB.SHEET.EKSEKUSI)) {
    pesan.push('✓ Sheet ' + DB.SHEET.EKSEKUSI + ' sudah ada.');
  } else {
    var sh = ss.insertSheet(DB.SHEET.EKSEKUSI);
    var h = DB.HEADERS[DB.SHEET.EKSEKUSI];
    sh.getRange(1, 1, 1, h.length).setValues([h])
      .setFontWeight('bold').setBackground('#f1f3f4');
    sh.setFrozenRows(1);
    SpreadsheetApp.flush();
    pesan.push('✓ Sheet ' + DB.SHEET.EKSEKUSI + ' dibuat.');
  }

  // 2. Kolom baru di transaksi
  var shTrx = Repo.sheet(DB.SHEET.TRX);
  var lc = shTrx.getLastColumn();
  var head = shTrx.getRange(1, 1, 1, lc).getValues()[0]
                  .map(function (v) { return String(v).trim(); });

  ['channel', 'sumber', 'gedung', 'metode_serah', 'faktur_pajak',
   'cara_bayar', 'tempo_hari',
   'dp_info', 'perlu_teknisi', 'kerja_teknisi', 'catatan_teknisi', 'tek_dulu',
   'serah_driver', 'serah_resi',
   'tempo_jatuh', 'tempo_by', 'eksekusi_pic', 'eksekusi_pic_nama']
    .forEach(function (kol) {
      if (head.indexOf(kol) >= 0) { pesan.push('✓ Kolom ' + kol + ' sudah ada.'); return; }
      lc++;
      shTrx.getRange(1, lc).setValue(kol).setFontWeight('bold').setBackground('#f1f3f4');
      head.push(kol);
      pesan.push('✓ Kolom ' + kol + ' ditambahkan.');
    });

  SpreadsheetApp.flush();

  // 3. Pengaturan pilihan sumber dan cara serah
  var shSet = Repo.sheet(DB.SHEET.SETTINGS);
  [['SUMBER_ONLINE',
    'WA Hotline,Instagram,Facebook,TikTok,Shopee,Tokopedia,Lazada,TikTok Shop,BliBli,Web',
    'Pilihan asal pesanan online, dipisah koma.'],
   ['CARA_BAYAR_ONLINE', 'Lunas,DP (uang muka),Belum bayar',
    'Pilihan cara bayar selain tempo, dipisah koma.'],
   ['TEMPO_HARI', '3,7,14,30,45,60,90',
    'Pilihan lama tempo dalam hari, dipisah koma.'],
   ['KERJA_TEKNISI', 'Aktivasi,Rakit PC,Inkcharging,Cek unit,Instal ulang',
    'Pilihan pekerjaan yang diminta Eksekusi ke Teknisi, dipisah koma.'],
   ['GEDUNG_LIST', 'G-UTARA,G-SELATAN',
    'Gedung tempat barang diambil. G-UTARA gedung NB (ada petugas gudang), G-SELATAN gedung PC dan aksesori.'],
   ['METODE_SERAH', 'DI-AMBIL,KIRIM DRIVER,PAKET,GOSEND / GRAB',
    'Pilihan cara barang sampai ke customer, dipisah koma.']
  ].forEach(function (x) {
    if (Repo.findOne(DB.SHEET.SETTINGS, 'key', x[0])) {
      pesan.push('✓ Pengaturan ' + x[0] + ' sudah ada.');
      return;
    }
    shSet.getRange(shSet.getLastRow() + 1, 1, 1, 7).setValues([[
      x[0], x[1], 'TEXT', 'ONLINE', x[2], nowIso_(), 'SETUP'
    ]]);
    pesan.push('✓ Pengaturan ' + x[0] + ' dibuat.');
  });

  // Tahap baru "Siap Diserahkan" ikut didaftarkan
  try { pesan.push(isiStatusMaster_()); } catch (eS) {}

  Repo.clearHeaderCache();
  Settings.bust();
  bersihkanCache();

  return kabar_(pesan.join('\n') + '\n\n' +
    'Langkah berikutnya:\n' +
    '1. Jalankan isiChannelLama() untuk mengisi kolom channel pada transaksi\n' +
    '   yang sudah ada — tanpa itu semuanya dianggap RITEL.\n' +
    '2. Buat akun divisi EKSEKUSI lewat Kelola User (role EKSEKUSI).\n' +
    '3. Isi sheet ' + DB.SHEET.EKSEKUSI + ' dengan nama PIC: Arul, Kosim,\n' +
    '   Anggun, Anjar, Eko.\n' +
    '4. Pastikan sales online punya kode berjenis O, misalnya SPW-O-NOFI.\n\n' +
    'Setelah itu pesanan dari sales online otomatis masuk antrian Eksekusi, ' +
    'bukan Gudang.');
}

/**
 * Mengisi kolom channel pada transaksi yang sudah ada.
 *
 * Dibaca dari jenis sales masing-masing. Tanpa ini, seluruh transaksi
 * lama dianggap ritel — dan pesanan online yang masih berjalan akan
 * nyangkut di antrian Gudang yang tidak menanganinya.
 */
function isiChannelLama() {
  var rows = Repo.columns(DB.SHEET.TRX, ['trx_id', 'sales_code', 'channel']);

  var isi = [];
  rows.forEach(function (t) {
    if (String(t.channel || '').trim()) return;
    var sales = findSales_(t.sales_code);
    isi.push([t._row, saluranDariSales_(sales)]);
  });

  if (!isi.length) return kabar_('Semua transaksi sudah punya keterangan saluran.');

  Repo.setKolomNilai(DB.SHEET.TRX, isi, 'channel');
  bersihkanCache();

  var hitung = {};
  isi.forEach(function (x) { hitung[x[1]] = (hitung[x[1]] || 0) + 1; });

  return kabar_(isi.length + ' transaksi diisi keterangan saluran:\n\n' +
    Object.keys(hitung).sort().map(function (k) {
      return '  ' + k + ' : ' + hitung[k];
    }).join('\n') +
    '\n\nDibaca dari jenis kode salesnya masing-masing.');
}

/**
 * Mengatur kolom nomor telepon jadi teks di spreadsheet.
 *
 * Penyebab nol di depan hilang: spreadsheet memperlakukan 085xxx
 * sebagai angka, dan angka tidak punya nol di depan. Itu terjadi
 * diam-diam saat penulisan, dan baru ketahuan waktu ada yang mau
 * menelepon.
 *
 * Aplikasi sudah mengembalikan nolnya saat membaca, tapi yang
 * tersimpan di sheet tetap salah. Ini membereskannya sampai ke
 * sumbernya — formatnya diubah jadi teks, dan nomor yang terlanjur
 * kehilangan nolnya dibetulkan.
 */
function betulkanNomorTelepon() {
  var pesan = [];

  var kerjakan = function (namaSheet, kolomNama) {
    var sh = Repo.sheet(namaSheet);
    var lr = sh.getLastRow(), lc = sh.getLastColumn();
    if (lr < 2) { pesan.push('Sheet ' + namaSheet + ' kosong.'); return; }

    var head = sh.getRange(1, 1, 1, lc).getValues()[0]
                 .map(function (v) { return String(v).trim(); });

    kolomNama.forEach(function (kol) {
      var idx = head.indexOf(kol);
      if (idx < 0) return;

      var rng = sh.getRange(2, idx + 1, lr - 1, 1);
      rng.setNumberFormat('@');          // teks, bukan angka

      var isi = rng.getValues();
      var ubah = 0;

      for (var i = 0; i < isi.length; i++) {
        var lama = String(isi[i][0] === null ? '' : isi[i][0]).trim();
        if (!lama) continue;

        var baru = Util.hp(lama);
        if (baru !== lama) { isi[i][0] = baru; ubah++; }
        else isi[i][0] = lama;
      }

      if (ubah) rng.setValues(isi);
      pesan.push('  ' + namaSheet + '.' + kol + ' : ' + ubah + ' nomor dibetulkan');
    });
  };

  kerjakan(DB.SHEET.CUSTOMERS, ['phone']);
  kerjakan(DB.SHEET.TRX, ['cust_phone_snap']);

  try { kerjakan(DB.SHEET.USERS, ['phone']); } catch (e) {}
  try { kerjakan(DB.SHEET.GUDANG, ['phone']); } catch (e) {}
  try { kerjakan(DB.SHEET.TEKNISI, ['phone']); } catch (e) {}
  try { kerjakan(DB.SHEET.EKSEKUSI, ['phone']); } catch (e) {}

  SpreadsheetApp.flush();
  bersihkanCache();

  return kabar_('NOMOR TELEPON DIBETULKAN\n\n' + pesan.join('\n') +
    '\n\nKolomnya sekarang bertipe teks, jadi nol di depan tidak akan ' +
    'hilang lagi pada penyimpanan berikutnya.');
}

/**
 * Memperbarui tulisan tahap yang sudah terlanjur tersimpan.
 *
 * Tahap Teknisi dulu bernama "Menunggu Aktivasi". Itu benar selama
 * yang masuk ke sana cuma laptop — tapi sekarang ada inkcharging
 * printer, rakit PC, dan cek unit. Orang membaca "menunggu aktivasi"
 * lalu membuka pesanan isi tinta, dan bingung.
 *
 * Yang diganti hanya tulisannya. Kodenya tetap MENUNGGU_AKTIVASI,
 * jadi tidak ada logika yang perlu diubah di mana pun.
 */
function perbaruiLabelTahap() {
  var ganti = {
    MENUNGGU_AKTIVASI: 'Menunggu Teknisi',
    PROSES_AKTIVASI: 'Dikerjakan Teknisi',
    AKTIVASI_SELESAI: 'Selesai di Teknisi'
  };

  var sh = Repo.sheet(DB.SHEET.STATUS);
  var lr = sh.getLastRow(), lc = sh.getLastColumn();
  if (lr < 2) return kabar_('Sheet STATUS_MASTER masih kosong. Jalankan siapkanStatusMaster().');

  var head = sh.getRange(1, 1, 1, lc).getValues()[0]
               .map(function (v) { return String(v).trim(); });
  var iKode = head.indexOf('status_code');
  var iLabel = head.indexOf('label');
  if (iKode < 0 || iLabel < 0) return kabar_('Kolom status_code atau label tidak ditemukan.');

  var vals = sh.getRange(2, 1, lr - 1, lc).getValues();
  var ubah = [];

  for (var i = 0; i < vals.length; i++) {
    var kode = String(vals[i][iKode]).trim();
    if (!ganti[kode]) continue;

    var lama = String(vals[i][iLabel]).trim();
    if (lama === ganti[kode]) continue;

    sh.getRange(i + 2, iLabel + 1).setValue(ganti[kode]);
    ubah.push('  ' + kode + ' : "' + lama + '"  →  "' + ganti[kode] + '"');
  }

  SpreadsheetApp.flush();
  bersihkanCache();

  if (!ubah.length) return kabar_('Semua tulisan tahap sudah sesuai.');

  return kabar_('TULISAN TAHAP DIPERBARUI\n\n' + ubah.join('\n') +
    '\n\nBerlaku di semua akun sekaligus. Kodenya tidak berubah, jadi ' +
    'tidak ada data lama yang perlu disesuaikan.');
}

/**
 * Memperbarui pilihan jenis pekerjaan dan kategori laporan Teknisi.
 *
 * Dipakai setelah daftar pekerjaannya bertambah — "Pasang Screen",
 * "Pasang SKIN", "Bundling Office Pro 2021", "Aktivasi Laptop".
 *
 * Yang penting bukan pilihannya saja, tapi kategorinya: tanpa itu,
 * "Pasang Screen" yang dicatat manual akan berdiri sebagai kolom
 * sendiri di laporan, terpisah dari screen yang terjual lewat
 * pesanan — dan persentase pencapaiannya jadi salah.
 */
function perbaruiKerjaTeknisi() {
  var baru = {
    JENIS_KERJA_MANUAL:
      'Upgrade RAM,Upgrade SSD,Rakit PC,Inkcharging,Bundling Office Pro 2021,' +
      'Pasang Screen,Pasang SKIN,Aktivasi Laptop,Onsite Service',
    KATEGORI_TEKNISI:
      'McAfee=MCAFEE,ANTIVIRUS|Screen=SCREEN,ANTIGORES|Skin Laptop=SKIN|' +
      'Office Profesional=OFFICE,OFC|Aktivasi Laptop=AKTIVASI LAPTOP'
  };

  var sh = Repo.sheet(DB.SHEET.SETTINGS);
  var lr = sh.getLastRow(), lc = sh.getLastColumn();
  var head = sh.getRange(1, 1, 1, lc).getValues()[0]
               .map(function (v) { return String(v).trim(); });

  var iKey = head.indexOf('key');
  var iVal = head.indexOf('value');
  if (iKey < 0 || iVal < 0) return kabar_('Kolom key atau value tidak ditemukan.');

  var vals = sh.getRange(2, 1, lr - 1, lc).getValues();
  var pesan = [];

  Object.keys(baru).forEach(function (k) {
    var ketemu = -1;
    for (var i = 0; i < vals.length; i++) {
      if (String(vals[i][iKey]).trim() === k) { ketemu = i; break; }
    }

    if (ketemu < 0) {
      sh.getRange(sh.getLastRow() + 1, 1, 1, 7).setValues([[
        k, baru[k], 'TEXT', 'TEKNISI', 'Diperbarui otomatis', nowIso_(), 'SETUP'
      ]]);
      pesan.push('  ' + k + ' dibuat');
      return;
    }

    var lama = String(vals[ketemu][iVal]).trim();
    if (lama === baru[k]) { pesan.push('  ' + k + ' sudah sesuai'); return; }

    sh.getRange(ketemu + 2, iVal + 1).setValue(baru[k]);
    pesan.push('  ' + k + ' diperbarui');
  });

  SpreadsheetApp.flush();
  Settings.bust();
  bersihkanCache();

  return kabar_('PEKERJAAN TEKNISI DIPERBARUI\n\n' + pesan.join('\n') +
    '\n\nSekarang "Pasang Screen" masuk ke kolom Screen, "Pasang SKIN" ke ' +
    'Skin Laptop, dan "Bundling Office Pro 2021" ke Office Profesional — ' +
    'menyatu dengan yang terhitung dari pesanan.\n\n' +
    'Kategori bisa ditambah sendiri di SETTINGS baris KATEGORI_TEKNISI.');
}

/**
 * Menambahkan pilihan baru ke daftar asal pesanan online.
 *
 * Dipakai saat ada marketplace atau saluran baru. Lebih aman
 * daripada mengetik ulang seluruh daftarnya di sheet — yang sudah
 * ada tidak tersentuh, dan tidak bisa terhapus karena salah ketik.
 *
 * Isi dulu TAMBAH_SUMBER di SETTINGS dengan nama yang mau
 * ditambahkan (boleh beberapa, dipisah koma), lalu jalankan ini.
 */
function tambahSumberOnline() {
  var tambahan = String(Settings.get('TAMBAH_SUMBER', '') || '').trim();
  if (!tambahan) {
    return kabar_('Isi dulu TAMBAH_SUMBER di sheet SETTINGS dengan nama ' +
      'yang mau ditambahkan.\n\nContoh: BliBli, Bukalapak\n\n' +
      'Kalau barisnya belum ada, buat baris baru dengan key TAMBAH_SUMBER.');
  }

  var sekarang = String(Settings.get('SUMBER_ONLINE', '') || '')
    .split(',').map(function (x) { return x.trim(); })
    .filter(function (x) { return x; });

  var adaLower = {};
  sekarang.forEach(function (x) { adaLower[x.toLowerCase()] = true; });

  var masuk = [], lewat = [];
  tambahan.split(',').forEach(function (x) {
    var nama = x.trim();
    if (!nama) return;
    if (adaLower[nama.toLowerCase()]) { lewat.push(nama); return; }
    sekarang.push(nama);
    adaLower[nama.toLowerCase()] = true;
    masuk.push(nama);
  });

  if (!masuk.length) {
    return kabar_('Tidak ada yang ditambahkan — semuanya sudah ada:\n  ' +
      lewat.join(', '));
  }

  var sh = Repo.sheet(DB.SHEET.SETTINGS);
  var lr = sh.getLastRow(), lc = sh.getLastColumn();
  var head = sh.getRange(1, 1, 1, lc).getValues()[0]
               .map(function (v) { return String(v).trim(); });
  var iKey = head.indexOf('key'), iVal = head.indexOf('value');

  var vals = sh.getRange(2, 1, lr - 1, lc).getValues();
  var baris = -1;
  for (var i = 0; i < vals.length; i++) {
    if (String(vals[i][iKey]).trim() === 'SUMBER_ONLINE') { baris = i + 2; break; }
  }

  if (baris < 0) {
    sh.getRange(sh.getLastRow() + 1, 1, 1, 7).setValues([[
      'SUMBER_ONLINE', sekarang.join(','), 'TEXT', 'ONLINE',
      'Pilihan asal pesanan online, dipisah koma.', nowIso_(), 'SETUP'
    ]]);
  } else {
    sh.getRange(baris, iVal + 1).setValue(sekarang.join(','));
  }

  SpreadsheetApp.flush();
  Settings.bust();
  bersihkanCache();

  return kabar_('Ditambahkan: ' + masuk.join(', ') +
    (lewat.length ? '\nSudah ada sebelumnya: ' + lewat.join(', ') : '') +
    '\n\nDaftar sekarang:\n  ' + sekarang.join('\n  ') +
    '\n\nBisa juga diubah langsung dari menu Pengaturan di akun Super Admin — ' +
    'cari baris SUMBER_ONLINE.');
}

/**
 * Memeriksa apakah SN dari permintaan Eksekusi benar-benar tersimpan.
 *
 * Dipakai saat ada laporan "Gudang sudah menembak SN tapi tidak
 * muncul". Menunjukkan apa yang sebenarnya ada di sheet, bukan apa
 * yang terlihat di layar — kalau datanya memang ada, berarti
 * masalahnya di tampilan; kalau kosong, berarti penyimpanannya yang
 * gagal.
 *
 * Isi CEK_TRX di SETTINGS dengan nomor transaksinya, lalu jalankan.
 */
function cekSnPermintaan() {
  var cari = String(Settings.get('CEK_TRX', '') || '').trim().toUpperCase();
  if (!cari) {
    return kabar_('Isi dulu CEK_TRX di sheet SETTINGS dengan nomor transaksinya.\n\n' +
      'Contoh: TRX-20261029-012\n\n' +
      'Kalau barisnya belum ada, buat baris baru dengan key CEK_TRX.');
  }

  var trx = null;
  Repo.all(DB.SHEET.TRX).forEach(function (t) {
    if (String(t.trx_no).toUpperCase() === cari ||
        String(t.trx_id).toUpperCase() === cari) trx = t;
  });

  if (!trx) return kabar_('Transaksi ' + cari + ' tidak ditemukan.');

  var items = Repo.findManyFast(DB.SHEET.ITEMS, 'trx_id', trx.trx_id)
    .filter(function (i) { return Util.isTrue(i.is_active); });

  var sn = Repo.findManyFast(DB.SHEET.SN, 'trx_id', trx.trx_id);

  var perItem = {};
  sn.forEach(function (r) {
    if (!Util.isTrue(r.is_active)) return;
    var k = String(r.item_id);
    if (!perItem[k]) perItem[k] = [];
    perItem[k].push(String(r.serial_number));
  });

  var baris = items.map(function (i) {
    var daftarSn = perItem[String(i.item_id)] || [];
    return '  ' + String(i.product_name).substring(0, 34) +
      '\n     perlu SN : ' + (Util.isTrue(i.need_sn) ? 'ya' : 'tidak') +
      '\n     tercatat : ' + (Number(i.sn_filled_qty) || 0) + ' dari ' + (i.qty || 1) +
      '\n     di sheet : ' + (daftarSn.length ? daftarSn.join(', ') : '(kosong)');
  }).join('\n\n');

  var minta = [];
  try {
    bacaMintaSn_(trx).forEach(function (m) {
      minta.push('  ' + String(m.status) + ' · diminta ' + String(m.minta_by || '-') +
        ' · ' + (m.barang || []).length + ' barang' +
        (m.isi_by ? ' · disiapkan ' + m.isi_by : ''));
    });
  } catch (e) {}

  return kabar_('CEK SN · ' + String(trx.trx_no) +
    '\nTahap: ' + stageLabel_(trx.stage_status) +
    '\n\nPERMINTAAN KE GUDANG\n' + (minta.length ? minta.join('\n') : '  (tidak ada)') +
    '\n\nBARANG\n\n' + baris +
    '\n\nKalau "di sheet" terisi tapi tidak muncul di layar, jalankan ' +
    'bersihkanCache(). Kalau kosong, SN-nya memang belum tersimpan.');
}

/**
 * Menyiapkan percakapan antar divisi.
 *
 * Membuat sheet TRX_CHAT. Jalankan sekali setelah deploy.
 */
function siapkanChat() {
  var ss = SpreadsheetApp.getActive();

  if (ss.getSheetByName(DB.SHEET.CHAT)) {
    return kabar_('Sheet ' + DB.SHEET.CHAT + ' sudah ada. Tidak ada yang perlu dikerjakan.');
  }

  var sh = ss.insertSheet(DB.SHEET.CHAT);
  var h = DB.HEADERS[DB.SHEET.CHAT];
  sh.getRange(1, 1, 1, h.length).setValues([h])
    .setFontWeight('bold').setBackground('#f1f3f4');
  sh.setFrozenRows(1);

  SpreadsheetApp.flush();
  Repo.clearHeaderCache();
  bersihkanCache();

  return kabar_('Sheet ' + DB.SHEET.CHAT + ' dibuat.\n\n' +
    'Kotak percakapan sekarang muncul di bawah layar pesanan — di Gudang, ' +
    'Eksekusi, Admin, Kasir, dan Teknisi.\n\n' +
    'Pesan yang ditulis menempel pada transaksinya, dan divisi yang sedang ' +
    'memegang pesanan itu mendapat pemberitahuan.');
}

/**
 * Menyiapkan pengaturan menu.
 *
 * Menambahkan kolom urutan menu di sheet USERS. Pengaturan per
 * divisi tersimpan di SETTINGS dan dibuat sendiri saat pertama
 * kali diatur, jadi tidak ada yang perlu disiapkan untuk itu.
 */
function siapkanMenu() {
  var sh = Repo.sheet(DB.SHEET.USERS);
  var lc = sh.getLastColumn();
  var head = sh.getRange(1, 1, 1, lc).getValues()[0]
               .map(function (v) { return String(v).trim(); });

  if (head.indexOf('menu_urut') >= 0) {
    return kabar_('Kolom menu_urut sudah ada. Tidak ada yang perlu dikerjakan.');
  }

  sh.getRange(1, lc + 1).setValue('menu_urut')
    .setFontWeight('bold').setBackground('#f1f3f4');

  SpreadsheetApp.flush();
  Repo.clearHeaderCache();
  bersihkanCache();

  return kabar_('Kolom menu_urut ditambahkan di sheet USERS.\n\n' +
    'Menu "Atur Menu" sekarang bisa dipakai:\n\n' +
    '  • Tiap orang menyusun urutan menunya sendiri\n' +
    '  • Super Admin menentukan menu apa saja yang dilihat tiap divisi\n\n' +
    'Yang disembunyikan untuk sebuah divisi tidak bisa dimunculkan sendiri ' +
    'oleh pemakainya. Beranda selalu ada dan tidak bisa dibuang.');
}

/**
 * Memperpanjang masa berlaku sesi.
 *
 * Keluhan dari iPhone: harus masuk ulang berkali-kali dalam sehari.
 * Sebabnya masa sesi dihitung sejak masuk — orang yang bekerja
 * seharian tetap terputus begitu batasnya lewat, di tengah
 * pekerjaan.
 *
 * Ini menaikkan batasnya jadi seminggu. Masa itu juga diperpanjang
 * sendiri tiap kali aplikasinya dipakai, jadi yang bekerja tiap
 * hari praktis tidak pernah diminta masuk ulang. Yang benar-benar
 * ditinggalkan tetap kedaluwarsa.
 */
function perpanjangSesi() {
  var jam = 168;      // tujuh hari

  var sh = Repo.sheet(DB.SHEET.SETTINGS);
  var lr = sh.getLastRow(), lc = sh.getLastColumn();
  var head = sh.getRange(1, 1, 1, lc).getValues()[0]
               .map(function (v) { return String(v).trim(); });
  var iKey = head.indexOf('key'), iVal = head.indexOf('value');

  var vals = lr > 1 ? sh.getRange(2, 1, lr - 1, lc).getValues() : [];
  var baris = -1;
  for (var i = 0; i < vals.length; i++) {
    if (String(vals[i][iKey]).trim() === 'SESSION_HOURS') { baris = i + 2; break; }
  }

  if (baris < 0) {
    sh.getRange(sh.getLastRow() + 1, 1, 1, 7).setValues([[
      'SESSION_HOURS', jam, 'NUMBER', 'AUTH',
      'Berapa jam sesi berlaku. Diperpanjang sendiri selama aplikasinya dipakai.',
      nowIso_(), 'SETUP'
    ]]);
  } else {
    sh.getRange(baris, iVal + 1).setValue(jam);
  }

  SpreadsheetApp.flush();
  Settings.bust();
  bersihkanCache();

  return kabar_('Masa sesi diatur jadi ' + jam + ' jam (7 hari).\n\n' +
    'Sesi yang sedang berjalan ikut diperpanjang sendiri saat dipakai. ' +
    'Yang terlanjur kedaluwarsa tetap perlu masuk sekali lagi.\n\n' +
    'Catatan untuk iPhone: Safari membuang simpanan situs yang tidak dibuka ' +
    'selama tujuh hari. Supaya tidak terjadi, pasang aplikasinya ke layar ' +
    'utama lewat tombol Bagikan → Tambahkan ke Layar Utama.');
}

/**
 * Menyiapkan akun sales perorangan.
 *
 * Menambahkan kolom sales_code di sheet USERS. Akun yang kolomnya
 * terisi jadi milik satu orang sales: namanya terpasang sendiri di
 * tiap pesanan, daftar sales di layarnya hanya berisi dirinya, dan
 * yang terlihat olehnya hanya penjualannya sendiri.
 *
 * Akun divisi yang dipakai bersama tetap berjalan seperti biasa —
 * kolomnya dibiarkan kosong.
 */
function siapkanSalesAkun() {
  var sh = Repo.sheet(DB.SHEET.USERS);
  var lc = sh.getLastColumn();
  var head = sh.getRange(1, 1, 1, lc).getValues()[0]
               .map(function (v) { return String(v).trim(); });

  if (head.indexOf('sales_code') >= 0) {
    return kabar_('Kolom sales_code sudah ada.\n\n' +
      'Isi kolom itu dengan kode salesnya, misalnya SPW-R-RIRIH, lalu ' +
      'jalankan bersihkanCache().');
  }

  sh.getRange(1, lc + 1).setValue('sales_code')
    .setFontWeight('bold').setBackground('#f1f3f4');

  SpreadsheetApp.flush();
  Repo.clearHeaderCache();
  bersihkanCache();

  return kabar_('Kolom sales_code ditambahkan di sheet USERS.\n\n' +
    'Cara pakai:\n' +
    '  1. Buat akun baru lewat Kelola User, isi Kode sales\n' +
    '     (atau isi kolomnya langsung di sheet untuk akun yang sudah ada)\n' +
    '  2. Orangnya masuk dengan akun itu\n\n' +
    'Yang berubah untuk akun seperti itu:\n' +
    '  • Nama sales terpasang sendiri, tidak perlu dipilih\n' +
    '  • Daftar sales di layarnya hanya berisi dirinya\n' +
    '  • Pesanan Saya hanya berisi pesanannya sendiri\n\n' +
    'Akun divisi yang sekarang tetap berjalan — kolomnya dibiarkan kosong.');
}

/**
 * Menyalakan atau mematikan alur "Teknisi sebelum Kasir".
 *
 * Alur bawaannya: nota → Kasir → Teknisi. Yang sering terjadi di
 * lapangan, pesanan menumpuk di Kasir karena customernya belum
 * datang membayar — padahal unitnya sudah bisa dirakit atau
 * diaktivasi sambil menunggu.
 *
 * Kalau dinyalakan, pesanan langsung masuk antrian Teknisi begitu
 * bernota. Yang tidak berubah:
 *
 *   • transaksinya tetap berdiri di daftar Kasir sampai dibayar
 *   • statusnya tetap tertulis belum lunas apa adanya
 *   • barangnya tetap tidak bisa diserahkan sebelum lunas
 *
 * Jadi yang dipercepat pekerjaannya, bukan penyerahannya.
 */
function alurTeknisiDuluan() {
  var kini = Util.isTrue(Settings.get('TEKNISI_SEBELUM_KASIR', 'FALSE'));
  var baru = kini ? 'FALSE' : 'TRUE';

  var sh = Repo.sheet(DB.SHEET.SETTINGS);
  var lr = sh.getLastRow(), lc = sh.getLastColumn();
  var head = sh.getRange(1, 1, 1, lc).getValues()[0]
               .map(function (v) { return String(v).trim(); });
  var iKey = head.indexOf('key'), iVal = head.indexOf('value');

  var vals = lr > 1 ? sh.getRange(2, 1, lr - 1, lc).getValues() : [];
  var baris = -1;
  for (var i = 0; i < vals.length; i++) {
    if (String(vals[i][iKey]).trim() === 'TEKNISI_SEBELUM_KASIR') { baris = i + 2; break; }
  }

  if (baris < 0) {
    sh.getRange(sh.getLastRow() + 1, 1, 1, 7).setValues([[
      'TEKNISI_SEBELUM_KASIR', baru, 'BOOL', 'ALUR',
      'TRUE: setelah nota terbit, pesanan langsung masuk antrian Teknisi ' +
      'walau belum dibayar. Penyerahan barang tetap menunggu lunas.',
      nowIso_(), 'SETUP'
    ]]);
  } else {
    sh.getRange(baris, iVal + 1).setValue(baru);
  }

  SpreadsheetApp.flush();
  Settings.bust();
  bersihkanCache();

  return kabar_(baru === 'TRUE'
    ? 'ALUR TEKNISI DULUAN: NYALA\n\n' +
      'Setelah Admin menerbitkan nota, pesanan langsung masuk antrian ' +
      'Teknisi — tidak menunggu pembayaran.\n\n' +
      'Yang tidak berubah:\n' +
      '  • Transaksinya tetap ada di daftar Kasir sampai dibayar\n' +
      '  • Statusnya tetap tertulis belum lunas\n' +
      '  • Barang tidak bisa diserahkan sebelum lunas atau disetujui tempo\n\n' +
      'Jalankan fungsi ini sekali lagi untuk mengembalikan alur semula.'
    : 'ALUR TEKNISI DULUAN: MATI\n\n' +
      'Kembali ke alur semula: nota → Kasir → Teknisi.\n\n' +
      'Jalankan sekali lagi untuk menyalakannya.');
}
