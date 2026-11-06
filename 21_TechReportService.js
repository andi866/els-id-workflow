/**
 * ELS.ID WORKFLOW SYSTEM
 * File : 21_TechReportService.gs
 * Isi  : Daftar teknisi, pencatatan pekerjaan, dan laporan bulanan.
 *
 * Selama ini Teknisi melaporkan pekerjaannya lewat Google Form yang
 * diisi manual, lalu direkap jadi pivot tiap bulan. Masalahnya angka
 * di form itu diketik sendiri — tidak ada yang mencocokkannya dengan
 * penjualan yang benar-benar terjadi.
 *
 * Di sini dibagi dua:
 *
 *   Dihitung sendiri — McAfee, Screen, Skin, Office. Semuanya barang
 *   yang ada di pesanan, jadi begitu aktivasi selesai angkanya
 *   terhitung dari isi transaksi. Tidak bisa lupa, tidak bisa
 *   dilebihkan.
 *
 *   Dicatat manual — Upgrade RAM, Rakit PC, Inkcharging, dan
 *   sejenisnya. Ini tidak selalu menempel pada penjualan, jadi
 *   memang harus diketik. Tapi tercatat siapa dan kapan.
 */

var TEKNISI_IDX_KEY = 'ELS_TEKNISIIDX_V1';

function bustTeknisiCache_() {
  CacheService.getScriptCache().remove(TEKNISI_IDX_KEY);
}

function daftarTeknisiIndex_() {
  // Nama yang ditambah langsung di sheet harus langsung terpakai —
  // lihat keterangan yang sama di daftar sales
  var barisKini = 0;
  try { barisKini = Repo.sheet(DB.SHEET.TEKNISI).getLastRow(); } catch (e) {}

  var hit = CacheService.getScriptCache().get(TEKNISI_IDX_KEY);
  if (hit) {
    try {
      var simpan = JSON.parse(hit);
      if (simpan && simpan.baris === barisKini && simpan.isi) return simpan.isi;
    } catch (e) {}
  }

  var out = [];
  try {
    Repo.columns(DB.SHEET.TEKNISI, [
      'tech_code', 'tech_name', 'branch', 'is_active'
    ]).forEach(function (r) {
      var kode = String(r.tech_code || '').trim();
      if (!kode) return;
      out.push({
        k: kode, n: String(r.tech_name || ''),
        b: String(r.branch || ''), a: Util.isTrue(r.is_active)
      });
    });
  } catch (e) {}

  CacheService.getScriptCache().put(TEKNISI_IDX_KEY,
    JSON.stringify({ baris: barisKini, isi: out }), 1800);
  return out;
}

function cariTeknisi_(kode) {
  if (!kode) return null;
  var hasil = null;
  daftarTeknisiIndex_().forEach(function (t) {
    if (String(t.k) === String(kode)) hasil = { code: t.k, name: t.n, branch: t.b };
  });
  return hasil;
}

/** Daftar teknisi aktif untuk dipilih saat mulai aktivasi */
function apiTeknisiList(payload) {
  return withGuard_(payload, {}, function (session) {
    var semua = Util.isTrue(payload.semua);
    var out = [];

    daftarTeknisiIndex_().forEach(function (t) {
      if (!semua && !t.a) return;
      if (t.b && String(t.b) !== String(session.branch) &&
          !hasPerm_(session, 'TRX_VIEW_ALL')) return;
      out.push({ code: t.k, name: t.n, branch: t.b, aktif: t.a });
    });

    out.sort(function (a, b) { return a.name < b.name ? -1 : 1; });
    return { list: out };
  });
}

/** Menambah atau mengubah teknisi — hanya Super Admin */
function apiSimpanTeknisi(payload) {
  return withGuard_(payload, { permission: 'USER_MANAGE', lock: 'ringan' }, function (session) {
    var nama = String(payload.tech_name || '').trim();
    if (nama.length < 2) throw appErr_('BAD_NAME', 'Nama teknisi tidak boleh kosong.');

    var kode = String(payload.tech_code || '').trim().toUpperCase();
    var now = nowIso_();

    if (!kode) {
      // Kode dibuat dari namanya, supaya mudah dikenali di laporan
      kode = 'TK-' + nama.toUpperCase().replace(/[^A-Z0-9]+/g, '-').substring(0, 18);
    }

    var ada = Repo.findOne(DB.SHEET.TEKNISI, 'tech_code', kode);

    if (ada) {
      Repo.update(DB.SHEET.TEKNISI, ada._row, {
        tech_name: nama,
        branch: String(payload.branch || ada.branch || session.branch),
        phone: String(payload.phone || ''),
        notes: String(payload.notes || ''),
        is_active: payload.is_active === undefined ? true : Util.isTrue(payload.is_active),
        updated_at: now, updated_by: session.user_id
      });
    } else {
      Repo.append(DB.SHEET.TEKNISI, {
        tech_code: kode, tech_name: nama,
        branch: String(payload.branch || session.branch),
        phone: String(payload.phone || ''),
        notes: String(payload.notes || ''),
        is_active: true,
        created_at: now, created_by: session.user_id,
        updated_at: now, updated_by: session.user_id
      });
    }

    bustTeknisiCache_();
    logAudit_(session, {
      entity: 'SETTING', entity_id: kode, action: ada ? 'UPDATE' : 'CREATE',
      new_value: 'Teknisi ' + nama
    });
    flushLog_();

    return { ok: true, tech_code: kode, tech_name: nama };
  });
}

function apiHapusTeknisi(payload) {
  return withGuard_(payload, { permission: 'USER_MANAGE', lock: 'ringan' }, function (session) {
    var row = Repo.findOne(DB.SHEET.TEKNISI, 'tech_code', String(payload.tech_code || ''));
    if (!row) throw appErr_('NOT_FOUND', 'Teknisi tidak ditemukan.');

    /*
     * Bawaannya dinonaktifkan, bukan dihapus.
     *
     * Namanya masih menempel di transaksi dan laporan bulan-bulan
     * sebelumnya. Menghapus barisnya membuat laporan lama kehilangan
     * nama pengerjanya.
     *
     * Hapus permanen tetap disediakan untuk nama yang salah dibuat,
     * tapi harus diminta dengan sengaja.
     */
    if (Util.isTrue(payload.paksa)) {
      Repo.deleteRow(DB.SHEET.TEKNISI, row._row);
      logAudit_(session, {
        entity: 'SETTING', entity_id: String(payload.tech_code), action: 'DELETE',
        old_value: String(row.tech_name), new_value: '(dihapus permanen)',
        reason: payload.reason || 'Dihapus paksa oleh Super Admin'
      });
      bustTeknisiCache_();
      flushLog_();
      return { ok: true, mode: 'HAPUS_PAKSA' };
    }

    Repo.update(DB.SHEET.TEKNISI, row._row, {
      is_active: false, updated_at: nowIso_(), updated_by: session.user_id
    });

    bustTeknisiCache_();
    logAudit_(session, {
      entity: 'SETTING', entity_id: String(payload.tech_code), action: 'UPDATE',
      old_value: 'aktif', new_value: 'nonaktif'
    });
    flushLog_();

    return { ok: true };
  });
}

/* ============================================================
   KATEGORI OTOMATIS

   Aturannya disimpan di SETTINGS supaya bisa ditambah tanpa
   menyentuh kode. Bentuknya:

     McAfee=MCAFEE|Screen=SCREEN,ANTIGORES|Skin Laptop=SKIN

   Dicocokkan dengan nama DAN kode barang, tidak peduli huruf besar
   kecil.
   ============================================================ */

function aturanKategori_() {
  Settings.bust();
  var teks = String(Settings.get('KATEGORI_TEKNISI', '') || '');
  var out = [];

  teks.split('|').forEach(function (bagian) {
    var p = bagian.split('=');
    if (p.length < 2) return;

    var nama = p[0].trim();
    var kata = p[1].split(',').map(function (x) {
      return x.trim().toUpperCase();
    }).filter(function (x) { return x; });

    if (nama && kata.length) out.push({ nama: nama, kata: kata });
  });

  return out;
}

function kategoriBarang_(nama, kode, aturan) {
  var bahan = (String(nama || '') + ' ' + String(kode || '')).toUpperCase();
  var hasil = [];

  aturan.forEach(function (a) {
    for (var i = 0; i < a.kata.length; i++) {
      if (bahan.indexOf(a.kata[i]) >= 0) { hasil.push(a.nama); return; }
    }
  });

  return hasil;
}

/* ============================================================
   PEKERJAAN YANG DICATAT MANUAL
   ============================================================ */

function apiJenisKerja(payload) {
  return withGuard_(payload, {}, function () {
    /*
     * Dibaca segar dari sheet, tidak dari salinan.
     *
     * Pengaturan disimpan beberapa menit supaya tidak dibaca
     * berulang. Tapi daftar jenis pekerjaan jarang dibuka dan sering
     * ditambah — menambah "Onsite Service" lalu tidak muncul sampai
     * belasan menit kemudian membuat orang mengira perubahannya
     * gagal, lalu menambahkannya lagi.
     */
    Settings.bust();
    var teks = String(Settings.get('JENIS_KERJA_MANUAL', '') || '');
    var list = teks.split(',').map(function (x) { return x.trim(); })
                   .filter(function (x) { return x; });
    return { list: list };
  });
}

function apiCatatKerja(payload) {
  return withGuard_(payload, { permission: 'ACTIVATION_START', lock: 'ringan' }, function (session) {
    var tech = cariTeknisi_(payload.tech_code);
    if (!tech) throw appErr_('NO_TECH', 'Pilih dulu nama teknisi yang mengerjakan.');

    var jenis = String(payload.jenis || '').trim();
    if (!jenis) throw appErr_('NO_TYPE', 'Pilih dulu jenis pekerjaannya.');

    var jumlah = Number(payload.jumlah) || 1;
    if (jumlah < 1 || jumlah > 100) {
      throw appErr_('BAD_QTY', 'Jumlahnya harus antara 1 sampai 100.');
    }

    /*
     * Keterangan boleh dikosongkan.
     *
     * Jenis pekerjaannya sendiri sudah cukup menjelaskan — "Upgrade
     * RAM" tidak perlu diterangkan lagi. Yang wajib hanya kalau
     * memilih "Pekerjaan lain", karena di situ jenisnya memang belum
     * dijelaskan apa pun.
     */
    var ket = String(payload.keterangan || '').trim();
    if (jenis === 'Pekerjaan lain' && ket.length < 3) {
      throw appErr_('NO_NOTE',
        'Anda memilih "Pekerjaan lain" — tulis dulu pekerjaannya apa.');
    }

    var now = nowIso_();
    Repo.append(DB.SHEET.TECH_WORK, {
      work_id: Util.id('TW'),
      tgl: Util.todayStr(),
      branch: session.branch,
      tech_code: tech.code, tech_name: tech.name,
      jenis: jenis, jumlah: jumlah,
      keterangan: ket.substring(0, 200),
      trx_no: String(payload.trx_no || ''),
      created_at: now, created_by: session.user_id,
      is_void: false
    });

    /*
     * Salinan dibuang supaya catatannya langsung terlihat.
     *
     * Daftar "dicatat hari ini" dibaca dari salinan blok data.
     * Tanpa dibuang, catatan yang baru masuk belum ada di salinan
     * itu — dan yang mencatatnya menyimpulkan tulisannya hilang,
     * lalu mencatat ulang. Kerjaannya terhitung dua kali.
     */
    try { Repo.bustSheet(DB.SHEET.TECH_WORK); } catch (eB) {}
    SpreadsheetApp.flush();

    return { ok: true, pesan: jumlah + 'x ' + jenis + ' dicatat untuk ' + tech.name + '.' };
  });
}

/** Pekerjaan manual hari ini, untuk dilihat dan dibetulkan */
function apiKerjaHariIni(payload) {
  return withGuard_(payload, { permission: 'ACTIVATION_START' }, function (session) {
    // Dibaca dari sumbernya — daftar ini dipakai untuk memastikan
    // catatan tadi benar-benar masuk
    try { Repo.bustSheet(DB.SHEET.TECH_WORK); } catch (eB) {}

    var tgl = String(payload.tgl || Util.todayStr());
    var out = [];

    Repo.all(DB.SHEET.TECH_WORK).forEach(function (r) {
      if (Util.isTrue(r.is_void)) return;
      if (Util.dateStr(r.tgl) !== tgl) return;
      if (String(r.branch) !== String(session.branch) &&
          !hasPerm_(session, 'TRX_VIEW_ALL')) return;

      out.push({
        work_id: String(r.work_id), tech_name: String(r.tech_name),
        jenis: String(r.jenis), jumlah: Number(r.jumlah) || 0,
        keterangan: String(r.keterangan || ''),
        jam: Util.isoStr(r.created_at)
      });
    });

    out.sort(function (a, b) { return a.jam < b.jam ? 1 : -1; });
    return { list: out, tgl: tgl };
  });
}

function apiHapusKerja(payload) {
  return withGuard_(payload, { permission: 'ACTIVATION_START', lock: 'ringan' }, function (session) {
    var row = Repo.findOne(DB.SHEET.TECH_WORK, 'work_id', String(payload.work_id || ''));
    if (!row) throw appErr_('NOT_FOUND', 'Catatan tidak ditemukan.');

    // Dibatalkan, bukan dihapus — supaya salah catat tetap ada jejaknya
    Repo.update(DB.SHEET.TECH_WORK, row._row, { is_void: true });

    logAudit_(session, {
      entity: 'SETTING', entity_id: String(payload.work_id), action: 'DELETE',
      old_value: String(row.jumlah) + 'x ' + String(row.jenis) + ' — ' + String(row.tech_name),
      reason: String(payload.alasan || 'Salah catat')
    });
    flushLog_();

    return { ok: true };
  });
}

/* ============================================================
   LAPORAN BULANAN

   Bentuknya mengikuti rekap yang selama ini dipakai: jumlah per
   kategori per teknisi, persentase kontribusi, dan KPI.

   KPI = persentase pekerjaan orang itu dibagi bagian idealnya
   (100% dibagi jumlah teknisi), dibatasi 100%. Jadi kalau ada
   delapan teknisi, bagian idealnya 12,5% — yang mengerjakan
   12,5% atau lebih mendapat 100%.
   ============================================================ */

function apiLaporanTeknisi(payload) {
  return withGuard_(payload, { permission: 'ACTIVATION_START' }, function (session) {
    /*
     * Laporan selalu dibaca dari sumbernya.
     *
     * Angka laporan dipakai untuk menilai orang. Angka yang berubah
     * tiap kali dimuat ulang membuat seluruh laporannya tidak bisa
     * dipercaya — dan yang dirugikan teknisi yang kerjanya paling
     * banyak.
     *
     * Dibaca ulang penuh tiap kali. Laporan dibuka beberapa kali
     * sehari, bukan tiap detik, jadi harganya murah.
     */
    [DB.SHEET.TRX, DB.SHEET.ITEMS, DB.SHEET.SN, DB.SHEET.TECH_WORK]
      .forEach(function (sh) { try { Repo.bustSheet(sh); } catch (eB) {} });

    var bulan = String(payload.bulan || Utilities.formatDate(
      new Date(), 'Asia/Jakarta', 'yyyy-MM'));

    var semuaCabang = hasPerm_(session, 'TRX_VIEW_ALL');
    var aturan = aturanKategori_();

    var namaKategori = aturan.map(function (a) { return a.nama; });
    var per = {};        // tech_name -> { kategori -> jumlah }

    var pastikan = function (nama) {
      if (!per[nama]) per[nama] = { _total: 0 };
      return per[nama];
    };

    /* ---------- dari transaksi yang sudah diaktivasi ---------- */
    var trxPerId = {};
    Repo.columns(DB.SHEET.TRX, [
      'trx_id', 'branch', 'tech_petugas_nama', 'tech_user_id',
      'activation_done_at', 'stage_status', 'is_void'
    ]).forEach(function (t) {
      if (Util.isTrue(t.is_void)) return;
      if (!t.activation_done_at) return;
      if (!semuaCabang && String(t.branch) !== String(session.branch)) return;

      var tgl = Util.dateStr(t.activation_done_at);
      if (String(tgl).substring(0, 7) !== bulan) return;

      var nama = String(t.tech_petugas_nama || '').trim();
      if (!nama) return;                       // belum pilih nama teknisi

      trxPerId[String(t.trx_id)] = nama;
      pastikan(nama);
    });

    /*
     * Serial number yang benar-benar tercatat, per barang.
     *
     * Dipakai untuk mengenali laptop pada pesanan lama yang tanda
     * "perlu SN"-nya tidak terisi.
     */
    var snPerItem = {};
    try {
      Repo.columns(DB.SHEET.SN, ['item_id', 'is_active']).forEach(function (r) {
        if (!Util.isTrue(r.is_active)) return;
        snPerItem[String(r.item_id)] = true;
      });
    } catch (eSn) {}

    Repo.columns(DB.SHEET.ITEMS, [
      'trx_id', 'item_id', 'product_code', 'product_name', 'qty', 'need_sn', 'is_active'
    ]).forEach(function (i) {
      if (!Util.isTrue(i.is_active)) return;

      var nama = trxPerId[String(i.trx_id)];
      if (!nama) return;

      var kat = kategoriBarang_(i.product_name, i.product_code, aturan);

      /*
       * Laptop dikenali dari tanda SN-nya, bukan dari kode.
       *
       * Kode laptop bermacam-macam — NB-AX, NB-AS, NB-AC, dan terus
       * bertambah tiap ada merek baru. Mendaftar semuanya berarti
       * laporan diam-diam salah setiap kali ada merek yang belum
       * terdaftar.
       *
       * Yang membedakan laptop dari aksesori sudah ada dan terpakai
       * sehari-hari: barang ber-SN. Screen, skin, dan antivirus
       * sudah tertangkap kategori lain lebih dulu, jadi sisanya yang
       * ber-SN memang unit yang diaktivasi.
       */
      /*
       * Laptop dikenali dari SN-nya, dengan dua cara.
       *
       * Tanda "perlu SN" pada barang adalah yang utama. Tapi tanda
       * itu disimpan saat barang dimasukkan ke pesanan — barang
       * lama, atau yang ditambahkan manual, bisa saja tidak
       * bertanda padahal SN-nya terisi.
       *
       * Jadi yang kedua: kalau ada serial number tercatat untuk
       * barang itu, berarti memang unit yang diaktivasi.
       */
      if (!kat.length && (Util.isTrue(i.need_sn) || snPerItem[String(i.item_id)])) {
        kat = ['Aktivasi Laptop'];
      }

      if (!kat.length) return;

      var qty = Number(i.qty) || 1;
      var orang = pastikan(nama);

      kat.forEach(function (k) {
        orang[k] = (orang[k] || 0) + qty;
        orang._total += qty;
      });
    });

    var manual = {};

    /*
     * Pekerjaan yang diminta Eksekusi ikut terhitung.
     *
     * Rakit PC, inkcharging, dan cek unit tidak menempel pada barang
     * mana pun — tidak ada "barang rakit" di pesanan. Jadi kalau
     * hanya menghitung isi pesanan, pekerjaan itu hilang dari
     * laporan padahal memakan waktu paling lama.
     *
     * Aktivasi sengaja dilewati: itu sudah terhitung dari barangnya,
     * dan menghitungnya lagi di sini membuat angkanya dobel.
     */
    Repo.columns(DB.SHEET.TRX, [
      'trx_id', 'branch', 'kerja_teknisi', 'tech_petugas_nama',
      'activation_done_at', 'is_void'
    ]).forEach(function (t) {
      if (Util.isTrue(t.is_void)) return;
      if (!t.activation_done_at) return;
      if (!semuaCabang && String(t.branch) !== String(session.branch)) return;
      if (String(Util.dateStr(t.activation_done_at)).substring(0, 7) !== bulan) return;

      var namaT = String(t.tech_petugas_nama || '').trim();
      if (!namaT) return;

      String(t.kerja_teknisi || '').split(',').forEach(function (k) {
        var jenisK = k.trim();
        if (!jenisK) return;
        if (jenisK.toUpperCase().indexOf('AKTIVASI') >= 0) return;

        var orangK = pastikan(namaT);
        orangK[jenisK] = (orangK[jenisK] || 0) + 1;
        orangK._total += 1;

        if (namaKategori.indexOf(jenisK) < 0) manual[jenisK] = true;
      });
    });

    /*
     * Sebagian pekerjaan manual sebenarnya kategori yang sama.
     *
     * "Pasang Screen" yang dicatat manual dan screen yang terjual
     * lewat pesanan adalah pekerjaan yang sama — hanya jalur
     * masuknya berbeda. Kalau dibiarkan jadi kolom sendiri,
     * laporannya punya dua kolom untuk satu jenis pekerjaan dan
     * persentasenya jadi salah.
     *
     * Aturannya dibaca dari kategori otomatis yang sudah ada, jadi
     * menambah kategori baru di SETTINGS otomatis ikut berlaku di
     * sini tanpa menyentuh kode.
     */
    var satukan = function (jenis) {
      var atas = String(jenis).toUpperCase();

      for (var i = 0; i < aturan.length; i++) {
        var a = aturan[i];

        // Nama kategorinya sendiri, misalnya "Skin Laptop"
        if (atas.indexOf(a.nama.toUpperCase()) >= 0) return a.nama;

        // Atau salah satu kata kuncinya, misalnya OFFICE dan SCREEN
        for (var k = 0; k < a.kata.length; k++) {
          if (atas.indexOf(a.kata[k]) >= 0) return a.nama;
        }
      }
      return jenis;
    };

    /* ---------- dari pekerjaan yang dicatat manual ---------- */
    Repo.columns(DB.SHEET.TECH_WORK, [
      'tgl', 'branch', 'tech_name', 'jenis', 'jumlah', 'is_void'
    ]).forEach(function (r) {
      if (Util.isTrue(r.is_void)) return;
      if (!semuaCabang && String(r.branch) !== String(session.branch)) return;
      if (String(Util.dateStr(r.tgl)).substring(0, 7) !== bulan) return;

      var nama = String(r.tech_name || '').trim();
      if (!nama) return;

      var jenis = satukan(String(r.jenis));
      var jml = Number(r.jumlah) || 0;

      var orang = pastikan(nama);
      orang[jenis] = (orang[jenis] || 0) + jml;
      orang._total += jml;

      // Kolomnya hanya ditambah kalau memang jenis baru, bukan
      // kategori yang sudah ada
      if (namaKategori.indexOf(jenis) < 0) manual[jenis] = true;
    });

    /* ---------- disusun jadi tabel ---------- */
    var kolomManual = Object.keys(manual).sort();
    var kolom = namaKategori.concat(kolomManual);

    var orang = Object.keys(per).sort();
    var totalSemua = 0;
    orang.forEach(function (n) { totalSemua += per[n]._total; });

    var jumlahOrang = orang.length || 1;
    var bagianIdeal = 100 / jumlahOrang;

    var totalKolom = {};
    kolom.forEach(function (k) {
      var t = 0;
      orang.forEach(function (n) { t += (per[n][k] || 0); });
      totalKolom[k] = t;
    });

    var baris = orang.map(function (n) {
      var isi = {}, persen = {};

      kolom.forEach(function (k) {
        isi[k] = per[n][k] || 0;
        persen[k] = totalKolom[k] ? (isi[k] / totalKolom[k] * 100) : 0;
      });

      var persenAll = totalSemua ? (per[n]._total / totalSemua * 100) : 0;
      var kpi = bagianIdeal ? (persenAll / bagianIdeal * 100) : 0;

      return {
        nama: n, isi: isi, persen: persen,
        total: per[n]._total,
        persen_all: persenAll,
        kpi: kpi,
        kpi_nilai: Math.min(Math.round(kpi), 100)
      };
    });

    baris.sort(function (a, b) { return b.total - a.total; });

    return {
      bulan: bulan,
      kolom: kolom,
      kolom_manual: kolomManual,
      baris: baris,
      total_kolom: totalKolom,
      total_semua: totalSemua,
      jumlah_teknisi: orang.length,
      bagian_ideal: bagianIdeal
    };
  });
}

// ============================================================
// UNIT PENGGANTI YANG MENUNGGU DITERIMA TEKNISI
//
// Kejadian nyata: Gudang sudah menurunkan unit pengganti dan Admin
// sudah membuat notanya, tapi Teknisi lupa menekan "Sudah diterima".
// Permintaannya menggantung di daftar Gudang, dan unit penggantinya
// tidak jelas statusnya.
//
// Dipisah jadi API sendiri supaya bisa ditanyakan dari layar antrian
// tanpa membuka transaksinya satu per satu.
// ============================================================

function apiGantiMenunggu(payload) {
  return withGuard_(payload, { permission: 'ACTIVATION_START' }, function (session) {
    var semuaCabang = hasPerm_(session, 'TRX_VIEW_ALL');
    var sekarang = new Date().getTime();
    var out = [];

    Repo.columns(DB.SHEET.TRX, [
      'trx_id', 'trx_no', 'branch', 'cust_name_snap',
      'stage_status', 'override_flags', 'is_void'
    ]).forEach(function (t) {
      if (Util.isTrue(t.is_void)) return;
      if (String(t.override_flags || '').indexOf('"ganti"') < 0) return;
      if (!semuaCabang && String(t.branch) !== String(session.branch)) return;

      var f = {};
      try { f = JSON.parse(String(t.override_flags || '') || '{}'); } catch (e) { return; }
      if (!f.ganti || !f.ganti.length) return;

      f.ganti.forEach(function (g) {
        /*
         * Yang ditampilkan hanya yang benar-benar menunggu Teknisi:
         * unitnya sudah siap atau notanya sudah dibuat, tapi belum
         * ditandai diterima.
         *
         * Yang masih disiapkan Gudang tidak perlu muncul — tidak ada
         * yang bisa dikerjakan Teknisi di situ.
         */
        if (['SIAP', 'NOTA'].indexOf(String(g.status)) < 0) return;

        var sejak = g.gudang_at || g.minta_at;
        var menit = sejak
          ? Math.max(Math.round((sekarang - new Date(sejak).getTime()) / 60000), 0) : 0;

        out.push({
          trx_id: String(t.trx_id), trx_no: String(t.trx_no),
          cust_name: String(t.cust_name_snap),
          ganti_id: String(g.id),
          product_name: String(g.product_name || ''),
          unit_seq: Number(g.unit_seq) || 1,
          sn_baru: String(g.sn_baru || ''),
          nota_ganti: String(g.nota_ganti || ''),
          status: String(g.status),
          siap_oleh: String(g.gudang_by || ''),
          menit: menit
        });
      });
    });

    out.sort(function (a, b) { return b.menit - a.menit; });
    return { list: out, total: out.length };
  });
}

/**
 * Menjelaskan kenapa sebuah transaksi masuk atau tidak masuk
 * laporan teknisi.
 *
 * Dipakai saat ada yang merasa pekerjaannya tidak terhitung. Yang
 * ditampilkan apa adanya dari data — bukan tebakan — jadi kalau
 * angkanya memang kurang, ketahuan di baris mana.
 *
 * Isi CEK_TRX di SETTINGS dengan nomor transaksinya, lalu jalankan.
 */
function cekLaporanTeknisi() {
  var cari = String(Settings.get('CEK_TRX', '') || '').trim().toUpperCase();
  if (!cari) {
    return kabar_('Isi dulu CEK_TRX di sheet SETTINGS dengan nomor transaksinya.');
  }

  var trx = null;
  Repo.all(DB.SHEET.TRX).forEach(function (t) {
    if (String(t.trx_no).toUpperCase() === cari) trx = t;
  });
  if (!trx) return kabar_('Transaksi ' + cari + ' tidak ditemukan.');

  var aturan = aturanKategori_();
  var items = Repo.findManyFast(DB.SHEET.ITEMS, 'trx_id', trx.trx_id)
    .filter(function (i) { return Util.isTrue(i.is_active); });

  var snAda = {};
  Repo.findManyFast(DB.SHEET.SN, 'trx_id', trx.trx_id).forEach(function (r) {
    if (Util.isTrue(r.is_active)) snAda[String(r.item_id)] = true;
  });

  var baris = items.map(function (i) {
    var kat = kategoriBarang_(i.product_name, i.product_code, aturan);
    if (!kat.length && (Util.isTrue(i.need_sn) || snAda[String(i.item_id)])) {
      kat = ['Aktivasi Laptop (dari tanda SN)'];
    }

    return '  ' + String(i.product_name).substring(0, 38) +
      '\n     perlu SN : ' + (Util.isTrue(i.need_sn) ? 'ya' : 'tidak') +
      '\n     ada SN   : ' + (snAda[String(i.item_id)] ? 'ya' : 'tidak') +
      '\n     masuk ke : ' + (kat.length ? kat.join(', ') : '(tidak terhitung)');
  }).join('\n\n');

  var namaTek = String(trx.tech_petugas_nama || '').trim();
  var selesai = Util.isoStr(trx.activation_done_at);

  return kabar_('CEK LAPORAN TEKNISI · ' + String(trx.trx_no) +
    '\n\nSyarat masuk laporan:' +
    '\n  nama teknisi  : ' + (namaTek || '(KOSONG — ini yang membuat tidak terhitung)') +
    '\n  selesai pada  : ' + (selesai || '(belum selesai)') +
    '\n  bulan laporan : ' + String(Util.dateStr(trx.activation_done_at)).substring(0, 7) +
    '\n\nBARANG\n\n' + baris +
    '\n\nKalau nama teknisi kosong, pekerjaannya tidak bisa dihitung ke siapa pun. ' +
    'Itu dipilih saat menekan Mulai kerjakan.');
}
