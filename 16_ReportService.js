/**
 * ELS.ID WORKFLOW SYSTEM — Phase 10
 * File : 16_ReportService.gs
 * Isi  : Laporan operasional dan pengelolaan pengaturan.
 *
 * Seluruh laporan dihitung dalam satu kali baca per sheet, lalu
 * dikirim sekaligus. Membuka halaman laporan = satu panggilan server,
 * bukan satu panggilan per bagian.
 *
 * Angka yang dilaporkan selalu berasal dari data transaksi, tidak
 * pernah dari kolom ringkasan yang bisa basi.
 */

// ============================================================
// BANTU
// ============================================================

function rentangTanggal_(payload) {
  var sampai = String(payload.sampai || Util.todayStr()).substring(0, 10);
  var dari = String(payload.dari || '').substring(0, 10);

  if (!dari) {
    var d = new Date();
    var n = Number(payload.hari === undefined ? 30 : payload.hari);
    d.setDate(d.getDate() - (n > 0 ? n - 1 : 0));
    dari = Utilities.formatDate(d, 'Asia/Jakarta', 'yyyy-MM-dd');
  }
  if (dari > sampai) { var t = dari; dari = sampai; sampai = t; }
  return { dari: dari, sampai: sampai };
}

function selisihMenit_(a, b) {
  if (!a || !b) return null;
  var x = new Date(Util.isoStr(a)).getTime();
  var y = new Date(Util.isoStr(b)).getTime();
  if (isNaN(x) || isNaN(y)) return null;
  var m = Math.round((y - x) / 60000);
  return m >= 0 ? m : null;
}

function rataRata_(arr) {
  if (!arr.length) return null;
  var j = 0;
  for (var i = 0; i < arr.length; i++) j += arr[i];
  return Math.round(j / arr.length);
}

function tengah_(arr) {
  if (!arr.length) return null;
  var s = arr.slice().sort(function (a, b) { return a - b; });
  var t = Math.floor(s.length / 2);
  return s.length % 2 ? s[t] : Math.round((s[t - 1] + s[t]) / 2);
}

// ============================================================
// API — LAPORAN LENGKAP
// ============================================================

function apiLaporan(payload) {
  return withGuard_(payload, { permission: 'REPORT_VIEW' }, function (session) {
    /*
     * Laporan selalu dibaca dari sumbernya.
     *
     * Angka laporan dipakai untuk mengambil keputusan. Angka yang
     * berubah tiap kali dimuat ulang membuat seluruh laporannya
     * tidak bisa dipercaya — dan yang membacanya tidak punya cara
     * tahu mana yang benar.
     *
     * Laporan dibuka beberapa kali sehari, bukan tiap detik, jadi
     * membaca ulang penuh harganya murah.
     */
    [DB.SHEET.TRX, DB.SHEET.ITEMS, DB.SHEET.PAYMENTS]
      .forEach(function (sh) { try { Repo.bustSheet(sh); } catch (eB) {} });

    var r = rentangTanggal_(payload);
    var semuaCabang = hasPerm_(session, 'TRX_VIEW_ALL');

    // ---------- transaksi dalam rentang ----------
    var trxRows = Repo.columns(DB.SHEET.TRX, [
      'trx_id', 'trx_no', 'branch', 'trx_date', 'cust_name_snap', 'cust_phone_snap',
      'sales_code', 'sales_name', 'sales_type', 'stage_status', 'payment_status',
      'item_count', 'subtotal', 'discount_total', 'grand_total', 'paid_total', 'outstanding',
      'nota_no', 'sales_confirm_at', 'gudang_confirm_at', 'nota_at', 'paid_at',
      'activation_start_at', 'activation_done_at', 'completed_at', 'is_void'
    ]);

    var dalam = {}, daftarTrx = [];
    var ringkas = {
      jumlah: 0, omzet: 0, diskon: 0, terbayar: 0, piutang: 0,
      selesai: 0, berjalan: 0, batal: 0, itemTotal: 0
    };
    var perStatus = {}, perTanggal = {};

    for (var i = 0; i < trxRows.length; i++) {
      var t = trxRows[i];
      var tgl = Util.dateStr(t.trx_date);
      if (tgl < r.dari || tgl > r.sampai) continue;
      if (!semuaCabang && String(t.branch) !== String(session.branch)) continue;

      if (Util.isTrue(t.is_void)) { ringkas.batal++; continue; }

      // Draft belum dianggap penjualan — baru niat, belum pesanan
      if (String(t.stage_status) === 'DRAFT') continue;

      dalam[String(t.trx_id)] = true;
      daftarTrx.push(t);

      var total = Number(t.grand_total) || 0;
      ringkas.jumlah++;
      ringkas.omzet += total;
      ringkas.diskon += Number(t.discount_total) || 0;
      ringkas.terbayar += Number(t.paid_total) || 0;
      ringkas.piutang += Math.max(Number(t.outstanding) || 0, 0);
      ringkas.itemTotal += Number(t.item_count) || 0;

      var st = String(t.stage_status);
      if (st === 'SELESAI') ringkas.selesai++; else ringkas.berjalan++;
      perStatus[st] = (perStatus[st] || 0) + 1;

      if (!perTanggal[tgl]) perTanggal[tgl] = { tanggal: tgl, jumlah: 0, omzet: 0 };
      perTanggal[tgl].jumlah++;
      perTanggal[tgl].omzet += total;
    }

    ringkas.rataTrx = ringkas.jumlah ? Math.round(ringkas.omzet / ringkas.jumlah) : 0;

    // ---------- penjualan per sales dan per jalur ----------
    var perSales = {}, perJalur = {};
    daftarTrx.forEach(function (t) {
      var kode = String(t.sales_code || '').trim() || '(tanpa kode)';
      var nama = String(t.sales_name || '').trim() || '(tanpa sales)';
      var jalur = salesTypeLabel_(t.sales_type);
      var total = Number(t.grand_total) || 0;

      if (!perSales[kode]) {
        perSales[kode] = { kode: kode, nama: nama, jalur: jalur,
                           jumlah: 0, omzet: 0, diskon: 0, item: 0 };
      }
      perSales[kode].jumlah++;
      perSales[kode].omzet += total;
      perSales[kode].diskon += Number(t.discount_total) || 0;
      perSales[kode].item += Number(t.item_count) || 0;

      if (!perJalur[jalur]) perJalur[jalur] = { jalur: jalur, jumlah: 0, omzet: 0 };
      perJalur[jalur].jumlah++;
      perJalur[jalur].omzet += total;
    });

    // ---------- lama tiap tahap ----------
    var tahap = {
      salesKeGudang: [], gudangKeNota: [], notaKeBayar: [],
      bayarKeAktivasi: [], lamaAktivasi: [], totalAlur: []
    };

    daftarTrx.forEach(function (t) {
      var a = selisihMenit_(t.sales_confirm_at, t.gudang_confirm_at);
      if (a !== null) tahap.salesKeGudang.push(a);

      var b = selisihMenit_(t.gudang_confirm_at, t.nota_at);
      if (b !== null) tahap.gudangKeNota.push(b);

      var c = selisihMenit_(t.nota_at, t.paid_at);
      if (c !== null) tahap.notaKeBayar.push(c);

      var d = selisihMenit_(t.paid_at, t.activation_start_at);
      if (d !== null) tahap.bayarKeAktivasi.push(d);

      var e = selisihMenit_(t.activation_start_at, t.activation_done_at);
      if (e !== null) tahap.lamaAktivasi.push(e);

      var f = selisihMenit_(t.sales_confirm_at, t.completed_at);
      if (f !== null) tahap.totalAlur.push(f);
    });

    var waktu = [
      ['Sales konfirmasi → Gudang selesai', tahap.salesKeGudang],
      ['Gudang selesai → Nota dibuat', tahap.gudangKeNota],
      ['Nota dibuat → Lunas', tahap.notaKeBayar],
      ['Lunas → Aktivasi dimulai', tahap.bayarKeAktivasi],
      ['Lama aktivasi', tahap.lamaAktivasi],
      ['Total dari konfirmasi sampai selesai', tahap.totalAlur]
    ].map(function (x) {
      return {
        nama: x[0], jumlah: x[1].length,
        rata: rataRata_(x[1]), tengah: tengah_(x[1]),
        terlama: x[1].length ? Math.max.apply(null, x[1]) : null
      };
    });

    // ---------- pembayaran ----------
    var perMetode = {}, totalBayar = 0;
    Repo.columns(DB.SHEET.PAYMENTS, ['payment_id', 'trx_id', 'type', 'amount', 'method', 'paid_at', 'is_void'])
      .forEach(function (p) {
        if (Util.isTrue(p.is_void)) return;
        if (!dalam[String(p.trx_id)]) return;
        var n = Number(p.amount) || 0;
        if (String(p.type) === 'REFUND') n = -n;
        var m = String(p.method || 'LAIN');
        perMetode[m] = (perMetode[m] || 0) + n;
        totalBayar += n;
      });

    // ---------- barang terlaris ----------
    var perBarang = {};
    Repo.columns(DB.SHEET.ITEMS, [
      'item_id', 'trx_id', 'product_code', 'product_name', 'qty', 'unit_price', 'is_active'
    ]).forEach(function (it) {
      if (!Util.isTrue(it.is_active)) return;
      if (!dalam[String(it.trx_id)]) return;

      var kode = String(it.product_code);
      if (!perBarang[kode]) {
        perBarang[kode] = { kode: kode, nama: String(it.product_name), qty: 0, nilai: 0, trx: 0 };
      }
      var q = Number(it.qty) || 0;
      perBarang[kode].qty += q;
      perBarang[kode].nilai += q * (Number(it.unit_price) || 0);
      perBarang[kode].trx++;
    });

    // ---------- piutang ----------
    var piutang = daftarTrx
      .filter(function (t) {
        return String(t.payment_status) !== 'LUNAS' && String(t.nota_no || '').trim();
      })
      .map(function (t) {
        var umur = 0;
        if (t.nota_at) {
          umur = Math.max(Math.round(
            (new Date().getTime() - new Date(Util.isoStr(t.nota_at)).getTime()) / 86400000), 0);
        }
        return {
          trx_id: String(t.trx_id), trx_no: String(t.trx_no), nota_no: String(t.nota_no),
          cust_name: String(t.cust_name_snap), cust_phone: String(t.cust_phone_snap),
          sales_name: String(t.sales_name || ''),
          grand_total: Number(t.grand_total) || 0,
          paid_total: Number(t.paid_total) || 0,
          outstanding: Math.max(Number(t.outstanding) || 0, 0),
          payment_status: String(t.payment_status),
          stage_label: stageLabel_(t.stage_status),
          umur_hari: umur
        };
      })
      .sort(function (a, b) { return b.outstanding - a.outstanding; });

    var urut = function (obj, kunci) {
      return Object.keys(obj).map(function (k) { return obj[k]; })
        .sort(function (a, b) { return b[kunci] - a[kunci]; });
    };

    return {
      rentang: r,
      ringkas: ringkas,
      perStatus: Object.keys(perStatus).map(function (k) {
        return { kode: k, label: stageLabel_(k), jumlah: perStatus[k] };
      }).sort(function (a, b) { return b.jumlah - a.jumlah; }),
      perTanggal: Object.keys(perTanggal).sort().map(function (k) { return perTanggal[k]; }),
      perSales: urut(perSales, 'omzet'),
      perJalur: urut(perJalur, 'omzet'),
      waktu: waktu,
      pembayaran: {
        total: totalBayar,
        perMetode: Object.keys(perMetode).map(function (k) {
          return { metode: k, nilai: perMetode[k] };
        }).sort(function (a, b) { return b.nilai - a.nilai; })
      },
      barang: urut(perBarang, 'qty').slice(0, 30),
      piutang: piutang.slice(0, 60),
      piutangTotal: piutang.reduce(function (n, p) { return n + p.outstanding; }, 0),
      piutangJumlah: piutang.length
    };
  });
}

// ============================================================
// API — PENGATURAN
// ============================================================

function apiListSettings(payload) {
  return withGuard_(payload, { permission: 'SETTING_MANAGE' }, function () {
    var rows = Repo.all(DB.SHEET.SETTINGS);
    return rows.map(function (s) {
      return {
        key: String(s.key), value: String(s.value === undefined ? '' : s.value),
        type: String(s.value_type || 'TEXT'), group: String(s.group || 'LAIN'),
        description: String(s.description || ''),
        updated_at: Util.isoStr(s.updated_at), updated_by: String(s.updated_by || '')
      };
    }).sort(function (a, b) {
      if (a.group !== b.group) return a.group < b.group ? -1 : 1;
      return a.key < b.key ? -1 : 1;
    });
  });
}

function apiSaveSetting(payload) {
  return withGuard_(payload, { permission: 'SETTING_MANAGE', lock: true }, function (session) {
    var kunci = String(payload.key || '').trim();
    if (!kunci) throw appErr_('BAD_KEY', 'Kunci pengaturan tidak boleh kosong.');

    var row = Repo.findOne(DB.SHEET.SETTINGS, 'key', kunci);
    if (!row) throw appErr_('NOT_FOUND', 'Pengaturan "' + kunci + '" tidak ditemukan.');

    var baru = String(payload.value === undefined ? '' : payload.value).trim();
    var lama = String(row.value === undefined ? '' : row.value);
    if (baru === lama) return { changed: 0 };

    if (String(row.value_type) === 'NUMBER' && baru !== '' && isNaN(Number(baru))) {
      throw appErr_('BAD_VALUE', 'Pengaturan ini harus berupa angka.');
    }

    Repo.update(DB.SHEET.SETTINGS, row._row, {
      value: baru, updated_at: nowIso_(), updated_by: session.full_name
    });
    Settings.bust();
    bustProductCache_();
    bustSnHistCache_();

    logAudit_(session, {
      entity: 'SETTING', entity_id: kunci, action: 'UPDATE', field: 'value',
      old_value: lama, new_value: baru, reason: payload.reason || ''
    });

    return { changed: 1, key: kunci, value: baru };
  });
}

// ============================================================
// BACKUP OTOMATIS
// ============================================================

function backupHarian() {
  try {
    var ss = SpreadsheetApp.getActive();
    var stamp = Utilities.formatDate(new Date(), 'Asia/Jakarta', 'yyyy-MM-dd_HHmm');
    var folder = getOrCreateFolder_('ELS_BACKUP');

    DriveApp.getFileById(ss.getId())
      .makeCopy('BACKUP_' + ss.getName() + '_' + stamp, folder);

    // Buang backup yang sudah melewati batas simpan
    var simpanHari = Settings.num('BACKUP_KEEP_DAYS', 30);
    var batas = new Date().getTime() - simpanHari * 86400000;
    var n = 0;
    var it = folder.getFiles();
    while (it.hasNext()) {
      var f = it.next();
      if (f.getDateCreated().getTime() < batas) { f.setTrashed(true); n++; }
    }

    logAuditRaw_({
      actor_name: 'Sistem', actor_role: 'SYSTEM',
      entity: 'SETTING', entity_id: 'BACKUP', action: 'CREATE',
      new_value: 'backup harian dibuat' + (n ? ', ' + n + ' backup lama dibuang' : '')
    });
    return { ok: true, dibuang: n };

  } catch (e) {
    pushNotif_({
      target_role: 'SUPERADMIN', target_branch: '',
      type: 'SYNC_FAIL', priority: 'HIGH',
      title: 'Backup harian gagal', body: String(e.message)
    });
    return { ok: false, message: String(e.message) };
  }
}

function pasangJadwalBackup() {
  hapusJadwalBackup();
  ScriptApp.newTrigger('backupHarian')
    .timeBased().atHour(23).everyDays(1)
    .inTimezone('Asia/Jakarta').create();

  return kabar_('Backup otomatis dipasang setiap hari sekitar pukul 23.00.\n\n' +
    'Hasilnya masuk ke folder Drive bernama ELS_BACKUP. Backup yang lebih tua dari ' +
    Settings.num('BACKUP_KEEP_DAYS', 30) + ' hari dibuang sendiri.');
}

function hapusJadwalBackup() {
  var n = 0;
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'backupHarian') { ScriptApp.deleteTrigger(t); n++; }
  });
  return n;
}

/** Melihat seluruh jadwal otomatis yang terpasang */
function cekJadwalOtomatis() {
  var daftar = ScriptApp.getProjectTriggers().map(function (t) {
    return '• ' + t.getHandlerFunction();
  });
  return kabar_(daftar.length
    ? 'Jadwal otomatis yang aktif:\n\n' + daftar.join('\n')
    : 'Belum ada jadwal otomatis yang terpasang.\n\n' +
      'Yang sebaiknya dipasang:\n' +
      '• pasangJadwalSync — sinkronisasi master barang\n' +
      '• pasangJadwalTertahan — pemeriksaan transaksi tertahan\n' +
      '• pasangJadwalBackup — backup harian');
}
