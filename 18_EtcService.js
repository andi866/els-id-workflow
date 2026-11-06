/**
 * ELS.ID WORKFLOW SYSTEM
 * File : 18_EtcService.gs
 * Isi  : Formulir Pendaftaran Notebook untuk Layanan ELS Total Care.
 *
 * Formulir ini ditandatangani customer, jadi isinya diambil apa adanya
 * dari transaksi — bukan dari data yang bisa berubah belakangan.
 *
 * Nama dan alamat sengaja bisa dibetulkan Admin sebelum dicetak, karena
 * formulir ini menuntut nama sesuai KTP sedangkan customer sering
 * mengisi nama panggilan saat mendaftar. Yang diketik di layar cetak
 * tidak mengubah data customer — hanya berlaku untuk lembar itu.
 */

// ============================================================
// API
// ============================================================

function apiEtcData(payload) {
  return withGuard_(payload, { permission: 'RESEP_PRINT' }, function (session) {
    var trx = cariTrx_(payload.trx_id);
    if (!trx) throw appErr_('NOT_FOUND', 'Transaksi tidak ditemukan.');

    var cust = Repo.findOne(DB.SHEET.CUSTOMERS, 'customer_id', trx.customer_id);

    // Serial number per barang
    var snPerItem = {};
    Repo.findManyFast(DB.SHEET.SN, 'trx_id', trx.trx_id).forEach(function (s) {
      if (!Util.isTrue(s.is_active)) return;
      var k = String(s.item_id);
      if (!snPerItem[k]) snPerItem[k] = [];
      snPerItem[k].push({ seq: Number(s.unit_seq), sn: String(s.serial_number) });
    });

    var kata = Settings.list('ETC_KEYWORDS');

    var items = Repo.findManyFast(DB.SHEET.ITEMS, 'trx_id', trx.trx_id)
      .filter(function (i) { return Util.isTrue(i.is_active); })
      .sort(function (a, b) { return Number(a.line_no) - Number(b.line_no); })
      .map(function (i) {
        var nama = String(i.product_name);
        var rendah = nama.toLowerCase();

        // Ditandai kalau namanya mengandung kata yang menunjukkan notebook.
        // Hanya saran — Admin tetap yang memutuskan mana yang dicetak.
        var notebook = false;
        for (var k = 0; k < kata.length; k++) {
          var w = String(kata[k]).toLowerCase().trim();
          if (w && rendah.indexOf(w) >= 0) { notebook = true; break; }
        }

        var sns = (snPerItem[String(i.item_id)] || [])
          .sort(function (a, b) { return a.seq - b.seq; })
          .map(function (x) { return x.sn; });

        /*
         * Harga acuan ETC = nilai unitnya sendiri, setelah diskon,
         * tanpa bundling.
         *
         * Diskon yang diberikan sales pada laptopnya IKUT, karena itu
         * memang harga yang disepakati untuk unit tersebut. Tambahan
         * bundling seperti Office TIDAK ikut, karena layanan ini
         * mengikat notebooknya saja.
         *
         * Ketiganya sudah tersimpan terpisah, jadi bisa dihitung pasti:
         *
         *   katalog   6.299.000   harga master
         *   jual      6.599.000   dinaikkan 300.000 untuk Office
         *   dibayar   6.539.000   setelah diskon 60.000
         *
         *   bundling  = jual - katalog        = 300.000
         *   harga ETC = dibayar - bundling    = 6.239.000
         *
         * Hasilnya sama dengan katalog dikurangi diskon — persis yang
         * seharusnya tercantum di formulir.
         */
        var hargaKatalog = Number(i.master_price) || 0;
        var hargaJual = Number(i.base_price) || hargaKatalog;
        var dibayar = Number(i.unit_price) || 0;

        var bundling = Math.max(hargaJual - hargaKatalog, 0);
        var hargaEtc = Math.max(dibayar - bundling, 0);

        // Kalau datanya tidak lengkap, jatuh kembali ke yang ada
        if (!hargaEtc) hargaEtc = hargaKatalog || dibayar;

        return {
          item_id: String(i.item_id),
          product_code: String(i.product_code),
          product_name: nama,
          qty: Number(i.qty) || 0,
          unit_price: Number(i.unit_price) || 0,
          master_price: hargaKatalog,
          base_price: hargaJual,
          bundling: bundling,
          harga_etc: hargaEtc,
          line_total: (Number(i.qty) || 0) * (Number(i.unit_price) || 0),
          sns: sns,
          notebook: notebook
        };
      });

    return {
      trx: {
        trx_id: String(trx.trx_id), trx_no: String(trx.trx_no),
        trx_date: Util.dateStr(trx.trx_date),
        nota_no: String(trx.nota_no || ''),
        sales_name: String(trx.sales_name || ''),
        stage_label: stageLabel_(trx.stage_status)
      },
      customer: {
        nama: String(trx.cust_name_snap || ''),
        telepon: String(trx.cust_phone_snap || ''),
        alamat: cust ? String(cust.address || '') : '',
        email: cust ? String(cust.email || '') : '',
        member: String(trx.cust_member_snap || '')
      },
      items: items,
      toko: {
        nama: String(Settings.get('COMPANY_NAME', 'ELS.ID')),
        alamat: String(Settings.get('ETC_ALAMAT', Settings.get('COMPANY_ADDRESS', ''))),
        logo: String(Settings.get('LOGO_URL', ''))
      },
      posisi: bacaPosisiEtc_(),
      arah: bacaArahEtc_(),
      teks: {
        judul: String(Settings.get('ETC_JUDUL',
          'Formulir Pendaftaran Notebook untuk Layanan ELS Total Care')),
        catatanHarga: String(Settings.get('ETC_CATATAN_HARGA',
          'Harga notebook diatas adalah harga unit notebook (tidak termasuk software dan ' +
          'perlengkapan tambahan), harga ini yang nantinya akan digunakan sebagai acuan untuk ' +
          'menghitung nilai harga tukar tambah ataupun harga jual kembali.')),
        catatanTtd: String(Settings.get('ETC_CATATAN_TTD',
          'Dengan ditandatangani formulir ini maka pembeli sudah memahami layanan ELS Total Care ' +
          'beserta syarat dan ketentuan yang berlaku.')),
        ttdKiri: String(Settings.get('ETC_TTD_KIRI', 'Pihak ELS Total Care')),
        ttdKanan: String(Settings.get('ETC_TTD_KANAN', 'Pihak Pembeli'))
      }
    };
  });
}

/** Mencatat bahwa formulir dicetak, supaya bisa ditelusuri kalau ada sengketa */
function apiCatatCetakEtc(payload) {
  return withGuard_(payload, { permission: 'RESEP_PRINT', lock: 'ringan' }, function (session) {
    var trx = cariTrx_(payload.trx_id);
    if (!trx) throw appErr_('NOT_FOUND', 'Transaksi tidak ditemukan.');

    var barang = String(payload.ringkas || '').substring(0, 300);

    logAudit_(session, {
      entity: 'TRX', entity_id: trx.trx_id, trx_no: trx.trx_no,
      action: 'UPDATE', field: 'cetak_etc',
      old_value: '', new_value: 'Formulir ETC dicetak · ' + barang
    });
    logTimeline_(session, {
      trx_id: trx.trx_id, trx_no: trx.trx_no,
      event_code: 'ETC_PRINT', stage_after: String(trx.stage_status),
      event_label: 'Admin ' + session.full_name + ' mencetak Formulir ELS Total Care',
      detail: barang
    });

    return { ok: true };
  });
}

// ============================================================
// POSISI ISIAN DI ATAS KERTAS
//
// Kertas formulir ETC sudah tercetak duluan — judul, garis, dan
// keterangan semuanya sudah ada. Yang dicetak sistem ini hanya
// ISINYA, dan harus jatuh pas di atas garis isian.
//
// Koordinatnya disimpan sebagai pengaturan supaya Admin bisa
// menyetelnya sendiri sampai pas, tanpa menunggu perubahan kode.
// Satuannya milimeter, dihitung dari pojok kiri atas kertas.
// ============================================================

var ETC_ARAH_BAWAAN = 'tegak';

var ETC_POSISI_BAWAAN = {
  tanggal:  { x: 46, y: 34, size: 10, lebar: 80 },
  nama:     { x: 46, y: 44, size: 10, lebar: 80 },
  alamat:   { x: 46, y: 54, size: 9,  lebar: 82, baris: 2 },
  hp:       { x: 46, y: 68, size: 10, lebar: 60 },
  produk:   { x: 20, y: 84, size: 9,  lebar: 108, baris: 6 },
  harga:    { x: 46, y: 122, size: 12, lebar: 70, tebal: true },
  sales:    { x: 82, y: 178, size: 9,  lebar: 55 }
};

function bacaArahEtc_() {
  var a = String(Settings.get('ETC_ARAH', ETC_ARAH_BAWAAN)).trim().toLowerCase();
  return a === 'mendatar' ? 'mendatar' : 'tegak';
}

function bacaPosisiEtc_() {
  var teks = String(Settings.get('ETC_POS', '')).trim();
  var hasil = {};

  Object.keys(ETC_POSISI_BAWAAN).forEach(function (k) {
    hasil[k] = {};
    Object.keys(ETC_POSISI_BAWAAN[k]).forEach(function (f) {
      hasil[k][f] = ETC_POSISI_BAWAAN[k][f];
    });
  });

  if (teks) {
    try {
      var simpan = JSON.parse(teks);
      Object.keys(hasil).forEach(function (k) {
        if (!simpan[k]) return;
        Object.keys(simpan[k]).forEach(function (f) { hasil[k][f] = simpan[k][f]; });
      });
    } catch (e) {}
  }
  return hasil;
}

function apiSavePosisiEtc(payload) {
  return withGuard_(payload, { permission: 'RESEP_PRINT', lock: true }, function (session) {
    var pos = payload.posisi;
    if (!pos || typeof pos !== 'object') throw appErr_('BAD_POS', 'Data posisi tidak terbaca.');

    var bersih = {};
    Object.keys(ETC_POSISI_BAWAAN).forEach(function (k) {
      if (!pos[k]) return;
      bersih[k] = {
        x: Number(pos[k].x) || 0,
        y: Number(pos[k].y) || 0,
        size: Number(pos[k].size) || 10,
        lebar: Number(pos[k].lebar) || 80
      };
      if (ETC_POSISI_BAWAAN[k].baris) bersih[k].baris = Number(pos[k].baris) || 2;
      if (ETC_POSISI_BAWAAN[k].tebal) bersih[k].tebal = true;
    });

    // Arah kertas ikut disimpan — tanpa itu, koordinat sebagus apa pun
    // tidak berarti kalau kertasnya masuk dengan arah berbeda
    if (payload.arah) {
      var arah = String(payload.arah) === 'mendatar' ? 'mendatar' : 'tegak';
      var rowA = Repo.findOne(DB.SHEET.SETTINGS, 'key', 'ETC_ARAH');
      if (rowA) {
        Repo.update(DB.SHEET.SETTINGS, rowA._row, {
          value: arah, updated_at: nowIso_(), updated_by: session.full_name
        });
      } else {
        Repo.append(DB.SHEET.SETTINGS, {
          key: 'ETC_ARAH', value: arah, value_type: 'TEXT', group: 'ETC',
          description: 'Arah kertas formulir ETC: tegak (148x210mm) atau mendatar (210x148mm).',
          updated_at: nowIso_(), updated_by: session.full_name
        });
      }
    }

    var row = Repo.findOne(DB.SHEET.SETTINGS, 'key', 'ETC_POS');
    var nilai = JSON.stringify(bersih);

    if (row) {
      Repo.update(DB.SHEET.SETTINGS, row._row, {
        value: nilai, updated_at: nowIso_(), updated_by: session.full_name
      });
    } else {
      Repo.append(DB.SHEET.SETTINGS, {
        key: 'ETC_POS', value: nilai, value_type: 'TEXT', group: 'ETC',
        description: 'Posisi tiap isian pada kertas formulir ETC, dalam milimeter dari pojok kiri atas. Disetel lewat tombol Atur posisi, jangan diketik manual.',
        updated_at: nowIso_(), updated_by: session.full_name
      });
    }

    Settings.bust();
    logAudit_(session, {
      entity: 'SETTING', entity_id: 'ETC_POS', action: 'UPDATE',
      field: 'posisi', old_value: '(sebelumnya)', new_value: 'posisi isian ETC disetel ulang'
    });

    return { ok: true, posisi: bacaPosisiEtc_(), arah: bacaArahEtc_() };
  });
}

function apiResetPosisiEtc(payload) {
  return withGuard_(payload, { permission: 'RESEP_PRINT', lock: true }, function (session) {
    var row = Repo.findOne(DB.SHEET.SETTINGS, 'key', 'ETC_POS');
    if (row) {
      Repo.update(DB.SHEET.SETTINGS, row._row, {
        value: '', updated_at: nowIso_(), updated_by: session.full_name
      });
    }
    Settings.bust();
    return { ok: true, posisi: bacaPosisiEtc_(), arah: bacaArahEtc_() };
  });
}

// ============================================================
// PENGATURAN — jalankan sekali dari editor
// ============================================================

function siapkanPengaturanEtc() {
  var sh = Repo.sheet(DB.SHEET.SETTINGS);
  var ada = {};
  Repo.columns(DB.SHEET.SETTINGS, ['key']).forEach(function (r) { ada[String(r.key).trim()] = true; });

  var now = nowIso_();
  var baru = [
    ['ETC_JUDUL', 'Formulir Pendaftaran Notebook untuk Layanan ELS Total Care', 'TEXT', 'ETC',
     'Judul yang tercetak di kepala formulir ETC.'],
    ['ETC_ALAMAT', 'Jl. Kapt. Pierre Tendean 11 PURWOKERTO', 'TEXT', 'ETC',
     'Alamat yang tercetak di formulir ETC. Kosongkan untuk memakai COMPANY_ADDRESS.'],
    ['ETC_KEYWORDS', 'laptop,notebook,macbook', 'TEXT', 'ETC',
     'Kata pada nama barang yang menandakan notebook. Barang yang cocok tercentang otomatis saat mencetak formulir ETC. Admin tetap bisa mengubah pilihannya.'],
    ['ETC_CATATAN_HARGA',
     'Harga notebook diatas adalah harga unit notebook (tidak termasuk software dan perlengkapan tambahan), harga ini yang nantinya akan digunakan sebagai acuan untuk menghitung nilai harga tukar tambah ataupun harga jual kembali.',
     'TEXT', 'ETC', 'Keterangan di bawah kolom harga notebook.'],
    ['ETC_CATATAN_TTD',
     'Dengan ditandatangani formulir ini maka pembeli sudah memahami layanan ELS Total Care beserta syarat dan ketentuan yang berlaku.',
     'TEXT', 'ETC', 'Keterangan di atas kolom tanda tangan.'],
    ['ETC_TTD_KIRI', 'Pihak ELS Total Care', 'TEXT', 'ETC', 'Label tanda tangan sebelah kiri.'],
    ['ETC_TTD_KANAN', 'Pihak Pembeli', 'TEXT', 'ETC', 'Label tanda tangan sebelah kanan.']
  ].filter(function (s) { return !ada[s[0]]; });

  if (baru.length) {
    sh.getRange(sh.getLastRow() + 1, 1, baru.length, 7).setValues(
      baru.map(function (s) { return [s[0], s[1], s[2], s[3], s[4], now, 'SETUP']; }));
  }
  Settings.bust();

  return kabar_((baru.length ? baru.length + ' pengaturan ETC ditambahkan.' : 'Pengaturan sudah ada.') +
    '\n\nSeluruh kalimat pada formulir bisa diubah lewat menu Pengaturan, ' +
    'tanpa menyentuh kode. Ukuran kertasnya tetap A5.');
}

// ============================================================
// TATA LETAK LEWAT SPREADSHEET
//
// Menyetel koordinat dalam milimeter itu tidak alami. Menggeser kolom
// dan baris di spreadsheet jauh lebih dekat dengan cara orang menata
// sesuatu di atas kertas — lihat, geser, lihat lagi.
//
// Cara kerjanya: di sheet ETC_LAYOUT ada penanda seperti {NAMA} yang
// ditaruh di sel mana pun. Sistem menghitung posisinya dari lebar
// kolom dan tinggi baris di sebelah kirinya dan di atasnya, lalu
// mengubahnya jadi milimeter.
//
// Jadi kalau tulisan perlu turun sedikit, tinggal tambah tinggi baris.
// Kalau perlu bergeser ke kanan, lebarkan kolom sebelumnya.
// ============================================================

var ETC_SHEET_LAYOUT = 'ETC_LAYOUT';

/* Satu piksel di Google Sheets = 1/96 inci */
function pxKeMm_(px) {
  return Math.round((Number(px) || 0) * 25.4 / 96 * 10) / 10;
}

var ETC_PENANDA = {
  '{TANGGAL}': 'tanggal',
  '{NAMA}': 'nama',
  '{ALAMAT}': 'alamat',
  '{HP}': 'hp',
  '{PRODUK}': 'produk',
  '{HARGA}': 'harga',
  '{SALES}': 'sales'
};

/**
 * Membaca posisi tiap isian dari sheet ETC_LAYOUT.
 * Mengembalikan null kalau sheetnya tidak ada atau belum berisi penanda.
 */
function bacaLayoutEtc_() {
  var ss = SpreadsheetApp.getActive();
  var sh = ss.getSheetByName(ETC_SHEET_LAYOUT);
  if (!sh) return null;

  var lr = sh.getLastRow(), lc = sh.getLastColumn();
  if (lr < 1 || lc < 1) return null;

  var nilai = sh.getRange(1, 1, lr, lc).getValues();

  // Jarak tiap kolom dan baris dari tepi, dihitung sekali
  var xKol = [0];
  for (var c = 1; c <= lc; c++) xKol[c] = xKol[c - 1] + pxKeMm_(sh.getColumnWidth(c));

  var yBar = [0];
  for (var r = 1; r <= lr; r++) yBar[r] = yBar[r - 1] + pxKeMm_(sh.getRowHeight(r));

  var hasil = {}, ketemu = 0;

  for (var i = 0; i < lr; i++) {
    for (var j = 0; j < lc; j++) {
      var isi = String(nilai[i][j] || '').trim().toUpperCase();
      var kunci = ETC_PENANDA[isi];
      if (!kunci) continue;

      var sel = sh.getRange(i + 1, j + 1);
      var lebarSel = pxKeMm_(sh.getColumnWidth(j + 1));
      var barisSel = 1;

      // Kalau selnya digabung, ukurannya ikut seluruh gabungan
      try {
        var gab = sel.getMergedRanges();
        if (gab && gab.length) {
          var g = gab[0];
          lebarSel = xKol[Math.min(g.getColumn() + g.getNumColumns() - 1, lc)] -
                     xKol[g.getColumn() - 1];
          barisSel = g.getNumRows();
        }
      } catch (e) {}

      var ukuranHuruf = 10;
      try { ukuranHuruf = Number(sel.getFontSize()) || 10; } catch (e) {}

      hasil[kunci] = {
        x: xKol[j],                    // jarak dari tepi kiri kertas
        y: yBar[i],                    // jarak dari tepi atas kertas
        lebar: Math.max(lebarSel, 10),
        size: ukuranHuruf,
        baris: barisSel > 1 ? barisSel : (kunci === 'produk' ? 6 : (kunci === 'alamat' ? 2 : 1))
      };
      ketemu++;
    }
  }

  return ketemu ? hasil : null;
}

/**
 * Menyiapkan sheet tata letak, sudah berisi penanda dan ukuran kertas
 * yang mendekati A5.
 */
function siapkanLayoutEtc() {
  var ss = SpreadsheetApp.getActive();
  var sh = ss.getSheetByName(ETC_SHEET_LAYOUT);

  if (sh) {
    return kabar_('Sheet ' + ETC_SHEET_LAYOUT + ' sudah ada.\n\n' +
      'Geser lebar kolom dan tinggi baris di sana sampai penandanya jatuh ' +
      'pas di atas kotak formulir. Lalu di aplikasi pilih sumber tata letak ' +
      '"Dari spreadsheet" dan cetak.\n\n' +
      'Kalau mau mulai dari nol, hapus sheetnya lalu jalankan fungsi ini lagi.');
  }

  sh = ss.insertSheet(ETC_SHEET_LAYOUT);

  // Lebar kolom dibuat seragam 20 px ≈ 5,3 mm, supaya menggesernya
  // terasa seperti memakai kertas berpetak
  var kolom = 28;   // 28 x 5,3 mm ≈ 148 mm, selebar A5 tegak
  sh.insertColumnsAfter(1, Math.max(kolom - sh.getMaxColumns(), 0));
  for (var c = 1; c <= kolom; c++) sh.setColumnWidth(c, 20);

  var baris = 40;   // 40 x 5,3 mm ≈ 210 mm
  if (sh.getMaxRows() < baris) sh.insertRowsAfter(sh.getMaxRows(), baris - sh.getMaxRows());
  for (var r = 1; r <= baris; r++) sh.setRowHeight(r, 20);

  // Penanda ditaruh di posisi awal yang masuk akal
  var taruh = [
    [7, 9, '{TANGGAL}'],
    [9, 9, '{NAMA}'],
    [11, 9, '{ALAMAT}'],
    [14, 9, '{HP}'],
    [17, 4, '{PRODUK}'],
    [25, 9, '{HARGA}'],
    [34, 16, '{SALES}']
  ];

  taruh.forEach(function (t) {
    sh.getRange(t[0], t[1]).setValue(t[2])
      .setFontSize(10).setFontWeight('bold').setFontColor('#0B5FFF');
  });

  // Keterangan singkat, ditaruh jauh di bawah supaya tidak ikut terhitung
  sh.getRange(44, 1).setValue(
    'CARA PAKAI — jangan hapus penanda {NAMA} dan kawan-kawannya.');
  sh.getRange(45, 1).setValue(
    'Posisi tulisan dihitung dari lebar kolom di kirinya dan tinggi baris di atasnya.');
  sh.getRange(46, 1).setValue(
    'Perlu turun? Tambah tinggi baris. Perlu ke kanan? Lebarkan kolom sebelumnya.');
  sh.getRange(47, 1).setValue(
    'Lebar tulisan mengikuti lebar selnya. Gabungkan beberapa sel kalau perlu lebih lebar.');
  sh.getRange(48, 1).setValue(
    'Ukuran huruf mengikuti ukuran huruf di sel itu.');
  sh.getRange(49, 1).setValue(
    'Setelah digeser, buka aplikasi > Cetak Formulir ETC > Atur posisi > Muat dari spreadsheet.');
  sh.getRange(44, 1, 6, 1).setFontColor('#888').setFontSize(9);

  sh.setFrozenRows(0);

  return kabar_('Sheet ' + ETC_SHEET_LAYOUT + ' dibuat.\n\n' +
    'Satu kolom dan satu baris = sekitar 5,3 mm, jadi seluruh lembarnya ' +
    'kira-kira sebesar A5.\n\n' +
    'Geser penandanya sampai jatuh pas di atas kotak formulir, lalu di aplikasi ' +
    'buka Atur posisi dan tekan "Muat dari spreadsheet".');
}

/** Mengambil posisi dari sheet tata letak, untuk dipakai aplikasi */
function apiLayoutEtc(payload) {
  return withGuard_(payload, { permission: 'RESEP_PRINT' }, function () {
    var pos = bacaLayoutEtc_();
    if (!pos) {
      throw appErr_('NO_LAYOUT',
        'Sheet ' + ETC_SHEET_LAYOUT + ' belum ada atau belum berisi penanda. ' +
        'Jalankan siapkanLayoutEtc() dari editor Apps Script dulu.');
    }

    /*
     * Memeriksa apakah ada penanda yang jatuh di luar kertas.
     *
     * Posisi dihitung dari tepi kiri atas SHEET, bukan dari tempat
     * penandanya terlihat. Kalau penanda ditaruh di baris bawah — di
     * dekat keterangan cara pakai, misalnya — jaraknya bisa melebihi
     * tinggi kertas, dan tulisannya tidak akan tercetak sama sekali.
     *
     * Lebih baik diberi tahu sekarang daripada ketahuan setelah
     * kertasnya keluar kosong.
     */
    var arah = bacaArahEtc_();
    var lebarKertas = arah === 'mendatar' ? 210 : 148;
    var tinggiKertas = arah === 'mendatar' ? 148 : 210;

    var diLuar = [];
    Object.keys(pos).forEach(function (k) {
      var b = pos[k];
      if (b.y > tinggiKertas - 3 || b.x > lebarKertas - 5) {
        diLuar.push(k + ' (x ' + b.x + 'mm, y ' + b.y + 'mm)');
      }
    });

    return {
      posisi: pos, arah: arah,
      kertas: { lebar: lebarKertas, tinggi: tinggiKertas },
      diLuar: diLuar
    };
  });
}

/**
 * Melengkapi penanda yang belum ada di sheet tata letak.
 *
 * Dipakai kalau ETC_LAYOUT sudah terlanjur dibuat sebelum ada isian
 * baru. Yang sudah ada tidak disentuh — hanya yang belum ditambahkan,
 * ditaruh di bawah supaya mudah dicari lalu digeser sendiri.
 */
function lengkapiLayoutEtc() {
  var ss = SpreadsheetApp.getActive();
  var sh = ss.getSheetByName(ETC_SHEET_LAYOUT);

  if (!sh) {
    return kabar_('Sheet ' + ETC_SHEET_LAYOUT + ' belum ada. ' +
      'Jalankan siapkanLayoutEtc() dulu.');
  }

  var lr = Math.max(sh.getLastRow(), 1);
  var lc = Math.max(sh.getLastColumn(), 1);
  var nilai = sh.getRange(1, 1, lr, lc).getValues();

  var sudahAda = {};
  for (var i = 0; i < lr; i++) {
    for (var j = 0; j < lc; j++) {
      var isi = String(nilai[i][j] || '').trim().toUpperCase();
      if (ETC_PENANDA[isi]) sudahAda[isi] = true;
    }
  }

  var kurang = Object.keys(ETC_PENANDA).filter(function (k) { return !sudahAda[k]; });

  if (!kurang.length) {
    return kabar_('Semua penanda sudah ada di sheet ' + ETC_SHEET_LAYOUT + '.\n\n' +
      Object.keys(ETC_PENANDA).join('  '));
  }

  // Ditaruh berderet di baris kosong paling bawah
  var barisTaruh = lr + 2;
  kurang.forEach(function (k, n) {
    sh.getRange(barisTaruh + n * 2, 3).setValue(k)
      .setFontSize(10).setFontWeight('bold').setFontColor('#D04545');
  });

  return kabar_(kurang.length + ' penanda ditambahkan di sheet ' + ETC_SHEET_LAYOUT +
    ', mulai baris ' + barisTaruh + ':\n\n  ' + kurang.join('\n  ') + '\n\n' +
    'Warnanya merah supaya mudah dicari. Geser ke tempat yang benar di kertas, ' +
    'lalu buka aplikasi > Cetak Formulir ETC > Atur posisi > Muat dari spreadsheet.');
}
